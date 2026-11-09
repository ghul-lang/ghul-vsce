import { Watchdog, COLD_START_TIMEOUT_MILLISECONDS, REBUILD_TIMEOUT_FLOOR_MILLISECONDS } from '../src/watchdog';

describe('Watchdog', () => {
    let watchdog: Watchdog;
    let onTimeout: jest.Mock;

    beforeEach(() => {
        jest.useFakeTimers();
        onTimeout = jest.fn();
        watchdog = new Watchdog(1000, onTimeout);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('does not fire if cleared before the timeout', () => {
        watchdog.startWatchdog();
        watchdog.clearWatchdog();

        jest.advanceTimersByTime(2000);

        expect(onTimeout).not.toHaveBeenCalled();
        expect(watchdog.watchdog_timer).toBeNull();
    });

    it('fires the timeout handler once a rebuild\'s limit has passed too', () => {
        watchdog.startWatchdog();

        jest.advanceTimersByTime(1500);

        expect(onTimeout).not.toHaveBeenCalled();

        jest.advanceTimersByTime(COLD_START_TIMEOUT_MILLISECONDS - 1500);

        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    // An edit the analyser can't apply incrementally is answered by a
    // rebuild, which nothing on this side can predict.
    it('allows a request past its own limit as long as a rebuild takes', () => {
        watchdog.setRebuildTimeout(40000);

        watchdog.startWatchdog();

        jest.advanceTimersByTime(39999);
        expect(onTimeout).not.toHaveBeenCalled();
        expect(watchdog.isRunning()).toBe(true);

        jest.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('starts a request known to rebuild on the rebuild limit', () => {
        watchdog.setRebuildTimeout(40000);

        watchdog.startWatchdogIfNotRunning(true);

        jest.advanceTimersByTime(39999);
        expect(onTimeout).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('moves a running timer onto the rebuild limit when a rebuild is asked for behind it', () => {
        watchdog.setRebuildTimeout(40000);

        watchdog.startWatchdogIfNotRunning();
        jest.advanceTimersByTime(500);

        watchdog.startWatchdogIfNotRunning(true);

        jest.advanceTimersByTime(39999);
        expect(onTimeout).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('fires at its own limit when that is already as long as a rebuild\'s', () => {
        watchdog.setTimeout(50000);
        watchdog.setRebuildTimeout(40000);

        watchdog.startWatchdog();

        jest.advanceTimersByTime(50000);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('never gives a rebuild less than the floor', () => {
        watchdog.setRebuildTimeout(2000);

        expect(watchdog.rebuild_timeout_milliseconds).toBe(REBUILD_TIMEOUT_FLOOR_MILLISECONDS);
    });

    it('startWatchdogIfNotRunning is idempotent while a timer is set', () => {
        watchdog.startWatchdogIfNotRunning();
        const firstTimer = watchdog.watchdog_timer;

        watchdog.startWatchdogIfNotRunning();

        expect(watchdog.watchdog_timer).toBe(firstTimer);
        // Cleanup so afterEach's useRealTimers doesn't leave a dangling handle:
        watchdog.clearWatchdog();
    });

    it('resetWatchdog restarts the timer with the configured timeout', () => {
        watchdog.startWatchdog();
        jest.advanceTimersByTime(800);

        watchdog.resetWatchdog();
        // 500ms after reset (1300 total) — pre-reset would have gone past
        // its own limit by now:
        jest.advanceTimersByTime(500);
        expect(onTimeout).not.toHaveBeenCalled();

        jest.advanceTimersByTime(COLD_START_TIMEOUT_MILLISECONDS - 500);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('setTimeout clamps below 1000ms up to 1000ms', () => {
        watchdog.setTimeout(500);
        expect(watchdog.timeout_milliseconds).toBe(1000);
    });

    it('setTimeout accepts values >= 1000ms unchanged', () => {
        watchdog.setTimeout(5000);
        expect(watchdog.timeout_milliseconds).toBe(5000);
    });

    it('clearWatchdog on an unstarted watchdog is a no-op', () => {
        expect(() => watchdog.clearWatchdog()).not.toThrow();
        expect(watchdog.watchdog_timer).toBeUndefined();
    });

    it('enterColdStart widens the timeout to the cold-start bound', () => {
        watchdog.setTimeout(3676);
        watchdog.setRebuildTimeout(40000);

        watchdog.enterColdStart();

        expect(watchdog.timeout_milliseconds).toBe(COLD_START_TIMEOUT_MILLISECONDS);
        expect(watchdog.rebuild_timeout_milliseconds).toBe(COLD_START_TIMEOUT_MILLISECONDS);
    });

    it('enterColdStart drops a timer still running against the outgoing compiler', () => {
        watchdog.startWatchdog();

        watchdog.enterColdStart();

        expect(watchdog.watchdog_timer).toBeNull();

        // The dropped timer must not fire after the cold start.
        jest.advanceTimersByTime(2000);
        expect(onTimeout).not.toHaveBeenCalled();
    });
});

// The timer's lifetime is exactly "a request is outstanding", which makes it
// the one place that knows the compiler is working on something — including
// the on-demand recompile it does to answer a query without announcing it.
describe('Watchdog busy signal', () => {
    let busy: boolean[];

    beforeEach(() => {
        jest.useFakeTimers();
        busy = [];
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function makeWatchdog(on_timeout: () => void = () => {}) {
        return new Watchdog(1000, on_timeout, value => busy.push(value));
    }

    it('reports busy while a request is outstanding and idle once it answers', () => {
        const watchdog = makeWatchdog();

        watchdog.startWatchdogIfNotRunning();
        watchdog.clearWatchdog();

        expect(busy).toEqual([true, false]);
    });

    it('does not re-report busy for a request sent while one is already in flight', () => {
        const watchdog = makeWatchdog();

        watchdog.startWatchdogIfNotRunning();
        watchdog.startWatchdogIfNotRunning();

        expect(busy).toEqual([true]);

        watchdog.clearWatchdog();
    });

    it('reports idle when the compiler is given up on, not just when it answers', () => {
        // Recovery kills the compiler, so no frame is coming back to clear it.
        const watchdog = makeWatchdog();

        watchdog.startWatchdogIfNotRunning();
        jest.advanceTimersByTime(COLD_START_TIMEOUT_MILLISECONDS);

        expect(busy).toEqual([true, false]);
    });

    it('reports idle when a relaunch drops the outgoing compiler\'s request', () => {
        const watchdog = makeWatchdog();

        watchdog.startWatchdogIfNotRunning();
        watchdog.enterColdStart();

        expect(busy).toEqual([true, false]);
    });
});
