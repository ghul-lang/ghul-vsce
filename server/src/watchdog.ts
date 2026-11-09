import { log } from './log';

// A freshly launched compiler's first full compile is cold: the JIT and the
// compiler's symbol and reflection-metadata caches are unwarmed, so it can
// legitimately take far longer than a calibrated steady-state compile. Until
// that first compile lands and the edit queue narrows the timeout from a real
// measurement, the watchdog runs with this wide bound so it cannot mistake a
// healthy cold compiler for a wedged one.
export const COLD_START_TIMEOUT_MILLISECONDS = 60000;

// The least time a request that may be a whole-project rebuild is given. A
// rebuild in a busy editor can take several times one measured on a quiet
// machine, and a compiler that is wedged answers never, so detecting it a
// few seconds later costs nothing.
export const REBUILD_TIMEOUT_FLOOR_MILLISECONDS = 30000;

// Bounds how long the extension waits for the compiler to answer a request.
// The timer is (re)started when a request is sent and cleared when any frame
// comes back; if it fires, the compiler is wedged — it has neither answered
// nor crashed — and the recovery callback kills and relaunches it.
export class Watchdog {
    watchdog_timer: NodeJS.Timeout;
    timeout_milliseconds: number;

    // How long a whole-project rebuild is given. A request known to cause
    // one starts on this limit; any other request that runs past its own
    // limit is allowed this long in total before the compiler counts as
    // wedged, since the analyser can answer an edit it can't apply
    // incrementally by rebuilding.
    rebuild_timeout_milliseconds: number;

    // Whether the running timer is already on the rebuild limit.
    private allowing_rebuild = false;
    private on_timeout: () => void;
    private on_busy_changed: (busy: boolean) => void;

    // The timer's lifetime is exactly "a request is outstanding" — armed when
    // one is sent, cleared by the first frame back — which makes this the one
    // place that knows the compiler is working on something, whatever that
    // something is. on_busy_changed observes it so the user can be told about
    // a wait nothing else predicts: the analyser recompiles on demand to
    // answer a query and gives no advance notice that it is about to.
    constructor(
        timeout_milliseconds: number,
        on_timeout: () => void,
        on_busy_changed: (busy: boolean) => void = () => { }
    ) {
        this.timeout_milliseconds = timeout_milliseconds;
        this.rebuild_timeout_milliseconds = COLD_START_TIMEOUT_MILLISECONDS;
        this.on_timeout = on_timeout;
        this.on_busy_changed = on_busy_changed;
    }

    setTimeout(timeout_milliseconds: number) {
        this.timeout_milliseconds = timeout_milliseconds > 1000 ? timeout_milliseconds : 1000;
    }

    // Sized from the longest round trip seen: never below the floor, and
    // never below the ordinary limit.
    setRebuildTimeout(timeout_milliseconds: number) {
        this.rebuild_timeout_milliseconds = Math.max(timeout_milliseconds, REBUILD_TIMEOUT_FLOOR_MILLISECONDS);
    }

    // expect_rebuild: the request is one the analyser answers with a
    // whole-project rebuild, so it starts on the rebuild limit. A timer
    // already running for another request moves onto that limit too, as
    // the rebuild now has to finish before anything else answers.
    startWatchdogIfNotRunning(expect_rebuild: boolean = false) {
        if (!this.watchdog_timer) {
            this.startWatchdog(expect_rebuild);
        } else if (expect_rebuild && !this.allowing_rebuild) {
            clearTimeout(this.watchdog_timer);

            this.armTimer(true);
        }
    }

    startWatchdog(expect_rebuild: boolean = false) {
        this.armTimer(expect_rebuild);

        this.on_busy_changed(true);
    }

    private rebuildLimit(): number {
        return Math.max(this.rebuild_timeout_milliseconds, this.timeout_milliseconds);
    }

    private armTimer(expect_rebuild: boolean) {
        this.allowing_rebuild = expect_rebuild || this.rebuildLimit() <= this.timeout_milliseconds;

        const limit = expect_rebuild ? this.rebuildLimit() : this.timeout_milliseconds;

        this.watchdog_timer = setTimeout(() => { this.onWatchdogTimeout(); }, limit);
    }

    resetWatchdog() {
        this.clearWatchdog();
        this.startWatchdog();
    }

    clearWatchdog() {
        if (this.watchdog_timer) {
            clearTimeout(this.watchdog_timer);
            this.watchdog_timer = null;
        }

        this.on_busy_changed(false);
    }

    // Called on every (re)launch. Drops any timer still running against the
    // outgoing compiler and widens the timeout for the incoming one's cold
    // first compile. The edit queue narrows it again from the first measured
    // compile.
    enterColdStart() {
        this.clearWatchdog();
        this.timeout_milliseconds = COLD_START_TIMEOUT_MILLISECONDS;
        this.rebuild_timeout_milliseconds = COLD_START_TIMEOUT_MILLISECONDS;
    }

    // True while a request is outstanding: the timer runs from when a request
    // is sent until a response frame arrives.
    isRunning(): boolean {
        return this.watchdog_timer != null;
    }

    // The compiler has not answered within the timeout. A crash would have
    // fired the process 'exit' handler instead, so this is a wedge: nothing
    // recovers it on its own. Hand off to the recovery callback.
    private onWatchdogTimeout() {
        if (!this.allowing_rebuild) {
            // Past an edit's limit but not a rebuild's: the analyser may
            // have declined the edit and be rebuilding to answer it.
            this.allowing_rebuild = true;

            log(`ghūl language extension: compiler has not answered in ${this.timeout_milliseconds.toFixed()} ms; allowing up to ${this.rebuildLimit().toFixed()} ms for a rebuild`);

            this.watchdog_timer = setTimeout(() => { this.onWatchdogTimeout(); }, this.rebuildLimit() - this.timeout_milliseconds);

            return;
        }

        this.watchdog_timer = null;

        // The request is over, however badly: recovery kills the compiler, so
        // no frame is ever coming back to clear this.
        this.on_busy_changed(false);

        log("ghūl language extension: compiler watchdog timeout");

        this.on_timeout();
    }
}
