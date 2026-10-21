import { TextDocumentChangeEvent } from 'vscode-languageserver'

import { log } from './log';

import { Requester } from './requester'

import { ResponseHandler } from './response-handler';

import { Watchdog } from './watchdog';

import { normalizeFileUri } from './normalize-file-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { Activity, ActivityProgress, ROUTINE_ANALYSIS_MESSAGE, SLOW_ACTIVITY_DELAY_MS } from './activity-progress';
import { MetricsReporter } from './metrics-reporter';
import { IncrementalStats, StatEntry, summariseIncrementalStats } from './incremental-stats';
import { EditDelta, computeSpan } from './edit-delta';

enum QueueState {
    START,
    IDLE,
    WAITING_FOR_MORE_EDITS,
    DOING_PARTIAL_COMPILE,
    WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE,
    DOING_FULL_COMPILE,
    // A full compile is running and the edit that supersedes it has already
    // been written. Two responses are outstanding: the compile's, which the
    // analyser cuts short, and then the edit's.
    DOING_FULL_COMPILE_SUPERSEDED,
    DOING_HEAP_CHECK,
}

interface Document {
    uri: string,
    version: number,
    text: string 
}

export class EditQueue {
    fake_version: number;

    expected_build_time: number;

    edit_timeout: number;
    edit_timer: NodeJS.Timeout;

    // Long-period timer, armed only in the IDLE state — strictly outside the
    // edit/compile timer's territory, so the two never run at the same time.
    idle_timer: NodeJS.Timeout;

    edit_count: number;
    build_count: number;

    full_build_timeout: number;

    pending_changes: Map<string,Document>;
    requester: Requester;
    response_handler: ResponseHandler;
    watchdog: Watchdog;
    progress: ActivityProgress | null;
    metrics: MetricsReporter | null;

    // The text the analyser is known to hold for each file, keyed by the
    // normalised path the analyser sees. Populated on every full-text send,
    // and used at flush time to compute the span that changed so only that
    // span is sent rather than the whole file. Cleared on reset: a relaunched
    // analyser holds nothing, and the client re-primes it with full text.
    last_sent_text: Map<string, string>;

    // Queries waiting for the analyser to hold the text the editor is
    // showing. Resolved once the pending edits have been flushed to it —
    // see whenFlushed.
    flushed_waiters: (() => void)[];

    // Smoothed round-trip times, in milliseconds, of the two things the user
    // waits on: an incremental analysis of an edit, and a full compile of the
    // project. Null until one of each has completed.
    edit_latency_ms: number | null;
    compile_latency_ms: number | null;

    // When the request currently in flight was sent, so its round trip can be
    // measured here rather than taken from the analyser's own figure. What the
    // analyser reports is deliberately pessimistic — a maximum of its lifetime
    // mean and its moving average — because it exists to size the timeouts
    // below, where erring high is right. As a latency readout it is badly
    // misleading: it is dominated by the expensive compiles just after a cold
    // start and cannot come down to meet a project that is now fast.
    send_start_time: number;
    compile_start_time: number;
    analyse_start_time: number;

    state: QueueState;

    // Queries held while a compile is in flight against an analyser that
    // cannot answer mid-compile (no mid-compile-queries capability). The
    // requester hands queries to whenNotCompiling, and these resolve the
    // moment the compile they would have parked behind ends.
    private compile_done_waiters: (() => void)[] = [];

    // Whether a compile the analyser is working through is in flight: the
    // states in which the analyser is computing rather than reading its
    // input.
    isCompiling(): boolean {
        return this.state === QueueState.DOING_PARTIAL_COMPILE
            || this.state === QueueState.DOING_FULL_COMPILE
            || this.state === QueueState.DOING_FULL_COMPILE_SUPERSEDED;
    }

    // Resolves once no compile is in flight — immediately when none is.
    // The requester holds queries here against an analyser that cannot
    // answer mid-compile, so a query's round trip starts when it can be
    // answered rather than parking in the analyser's input for the length
    // of the compile.
    whenNotCompiling(): Promise<void> {
        if (!this.isCompiling()) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            this.compile_done_waiters.push(resolve);
        });
    }

    private releaseCompileDoneWaiters() {
        const waiters = this.compile_done_waiters;
        this.compile_done_waiters = [];

        for (const waiter of waiters) {
            waiter();
        }
    }

    static readonly FULL_BUILD_EDIT_TIMEOUT = 1000;
    static readonly PARTIAL_BUILD_EDIT_TIMEOUT = 100;

    // How long the queue must sit IDLE before asking the analyser to sample
    // the heap — long enough that it is a genuine lull in editing.
    static readonly HEAP_CHECK_IDLE_TIMEOUT = 60000;

    // Weight given to the newest measurement when smoothing the reported
    // latencies. Individual compiles vary by an order of magnitude depending
    // on what was edited; the reported figure is meant to answer "how is this
    // project performing", which a single sample does not.
    static readonly LATENCY_SMOOTHING = 0.3;

    // How often the analyser's work counters are asked for. Matched to the
    // rate the metrics they travel with are reported at — asking more often
    // would spend a round trip per edit to refresh a figure nothing shows any
    // faster.
    static readonly STATS_INTERVAL = 2000;

    // How long a query will wait for the analyser to catch up with the
    // editor before being sent anyway. Long enough to cover an incremental
    // analysis of one file, which is what it is normally waiting on; short
    // enough that a project whose round trip is much worse than that answers
    // something rather than appearing to hang.
    static readonly FLUSH_WAIT_TIMEOUT = 500;

    constructor(
        requester: Requester,
        response_handler: ResponseHandler,
        watchdog: Watchdog,
        progress?: ActivityProgress,
        metrics?: MetricsReporter
    ) {
        this.edit_count = 0;
        this.build_count = 0;
        this.fake_version = -1;

        this.requester = requester;
        this.response_handler = response_handler;
        this.watchdog = watchdog;
        this.progress = progress ?? null;
        this.metrics = metrics ?? null;

        this.edit_latency_ms = null;
        this.compile_latency_ms = null;

        this.pending_changes = new Map();
        this.last_sent_text = new Map();
        this.flushed_waiters = [];

        this.state = QueueState.START;

        this.edit_timeout = EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT;
        this.full_build_timeout = EditQueue.FULL_BUILD_EDIT_TIMEOUT;
    }

    // Whether the analyser is still behind the editor — edits queued here that
    // it has not been given yet.
    hasPendingEdits(): boolean {
        return this.pending_changes.size > 0;
    }

    reset() {
        this.pending_changes.clear();
        this.clearEditTimer();
        this.clearIdleTimer();

        // Whatever was in flight died with the compiler, so nothing is going
        // to report it done. Take the indicators down rather than leave them
        // claiming work that is no longer happening.
        this.progress?.end(Activity.Edit);
        this.progress?.end(Activity.Compile);
        this.progress?.end(Activity.Heap);

        // The counters belonged to the compiler that just died; the next one
        // starts its own from zero.
        this.incremental_stats = null;
        this.last_stats_request_at = 0;
        this.memory_bytes = null;
        this.last_memory_request_at = 0;

        // The analyser holds no retained text — a fresh one starts from
        // whatever the client sends it.
        this.last_sent_text.clear();

        // Drop the in-flight clocks with the request they belong to. Left
        // standing, the next compiler's whole-project analysis completes
        // against a timestamp from the dead one's edit and reports the whole
        // span between them as a keystroke's latency.
        this.send_start_time = 0;
        this.compile_start_time = 0;

        // Nothing is going to land and release these — the compiler they were
        // waiting on is gone. Let the queries through to be answered by the
        // replacement rather than by their timeouts.
        const waiters = this.flushed_waiters;

        this.flushed_waiters = [];

        for (const waiter of waiters) {
            waiter();
        }

        // A restart abandons whatever compile was in flight; held queries
        // must not wait on one that will never report its completion.
        this.releaseCompileDoneWaiters();

        this.state = QueueState.IDLE;
    }

    queueEdit(change: TextDocumentChangeEvent<TextDocument>) {
        this.queueEdit3(normalizeFileUri(change.document.uri), change.document.version, change.document.getText());
    }

    sendMultiEdits(documents: { uri: string, source: string }[]) {
        this.requester.sendDocuments(documents);

        // The analyser now holds this text; record it so the next flush can
        // send only the span that changed.
        for (let doc of documents) {
            this.last_sent_text.set(normalizeFileUri(doc.uri), doc.source);
        }
    }

    sendOpenFiles(uris: string[]) {
        this.requester.sendOpenFiles(uris);
    }

    queueEdit3(uri: string, version: number, text: string) {
        if (version == null || version < 0) {
            version = this.fake_version--;
        }

        this.pending_changes.set(uri,
            {
                uri: uri,
                version: version,
                text: text
            });

        if (this.state == QueueState.START) {
            // do nothing
        } else if (this.state == QueueState.IDLE) {
            this.clearIdleTimer();

            this.state = QueueState.WAITING_FOR_MORE_EDITS;

            this.startEditTimer(this.edit_timeout);
        } else if (this.state == QueueState.WAITING_FOR_MORE_EDITS) {
            this.startEditTimer(this.edit_timeout);
        } else if (this.state == QueueState.DOING_PARTIAL_COMPILE) {
            // do nothing, wait for partial compiler to complete
        } else if (this.state == QueueState.WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE) {
            this.state = QueueState.WAITING_FOR_MORE_EDITS;

            this.startEditTimer(this.edit_timeout);
        } else if (this.state == QueueState.DOING_FULL_COMPILE) {
            // The analyser stops a compile as soon as it sees an edit
            // waiting, so debounce this one as usual and then write it
            // rather than holding it until the compile answers. Without
            // that the compile runs on computing diagnostics this edit has
            // already made stale.
            if (this.response_handler.compile_abort_supported) {
                this.startEditTimer(this.edit_timeout);
            }
        } else if (this.state == QueueState.DOING_FULL_COMPILE_SUPERSEDED) {
            // do nothing: the compile has already been superseded, and the
            // edit that did it is in flight
        } else if (this.state == QueueState.DOING_HEAP_CHECK) {
            // do nothing, wait for the heap check to complete
        } else {
            this.response_handler.rejectAllAndThrow("queue edit: unexpected queue state (A): " + QueueState[this.state]);
        }
    }

    onEditTimeout() {
        // The timer has fired; its handle is spent. Drop the reference so a
        // later clearEditTimer cannot act on a stale handle.
        this.edit_timer = null;

        if (this.state == QueueState.WAITING_FOR_MORE_EDITS) {
            this.sendQueued("edit timeout when waiting for more edits");
        } else if(this.state == QueueState.WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE) {
            if (this.pending_changes.size > 0) {
                this.sendQueued("edit timeout when waiting for more edits after partial compile");
            } else {
                this.requestFullCompile();
            }
        } else if (this.state == QueueState.DOING_FULL_COMPILE) {
            this.sendSupersedingEdit();
        } else {
            log("timer expired but not waiting for edits: " + QueueState[this.state] + " (" + this.state + ")");
        }
    }

    // The queue has sat IDLE long enough to be a genuine lull, so ask the
    // analyser to sample the heap — its forced GC then lands off the latency
    // path of interactive requests. Query requests (hover, completion, …)
    // bypass this queue, so the queue can be IDLE while a request is still in
    // flight; if anything is outstanding, the heap check is dropped and the
    // idle timer re-armed for the next lull rather than risk overlapping it
    // with another request.
    onIdleTimeout() {
        if (this.state == QueueState.IDLE && !this.watchdog.isRunning()) {
            this.progress?.report(Activity.Heap, "garbage collecting", {
                delay_ms: SLOW_ACTIVITY_DELAY_MS,
                done_message: "garbage collected"
            });

            this.requester.sendHeapCheckRequest();

            this.state = QueueState.DOING_HEAP_CHECK;
        } else {
            this.startIdleTimer();
        }
    }

    onDiagnosticsReceived() {
        if (this.state == QueueState.START) {
            this.state = QueueState.IDLE;
        }
    }

    onPartialCompileDone(milliseconds: number) {
        if (this.state != QueueState.DOING_PARTIAL_COMPILE) {
            // A stray PARTIAL DONE — e.g. left over from a compiler recycle.
            // Drop it rather than driving a transition (and arming an edit
            // timer) from a state that never requested a partial compile.
            log("edit queue: on partial compile done: unexpected queue state (C): " + QueueState[this.state] + " (" + this.state + ")");
            return;
        }

        // The analyser has compiled the project at least once, so queries
        // can now be answered against real state.
        this.requester.analysed = true;

        this.recordLatency('edit', this.send_start_time);
        this.requestStatsIfDue();
        this.requestMemoryIfDue();

        if (milliseconds) {
            this.edit_timeout = milliseconds * 1.5;

            if (this.full_build_timeout < this.edit_timeout) {
                this.full_build_timeout = this.edit_timeout;

                this.watchdog.setTimeout(this.full_build_timeout * 2);
            }

            if ((this.edit_count & 31) == 0) {
                log(`edit request average: ${milliseconds.toFixed()} ms, edit timeout: ${this.edit_timeout.toFixed()} ms, compile timeout: ${this.full_build_timeout.toFixed()} ms, watchdog timeout: ${this.watchdog.timeout_milliseconds.toFixed()} ms`);
            }

            this.edit_count++;
        }

        if (this.pending_changes.size > 0) {
            // More typing already waiting: the analyser is still behind the
            // user, so the indicator stays up rather than blinking off
            // between one round trip and the next.
            this.state = QueueState.WAITING_FOR_MORE_EDITS;
            this.startEditTimer(this.edit_timeout);
        } else {
            this.progress?.end(Activity.Edit);

            this.state = QueueState.WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE;
            this.startEditTimer(this.full_build_timeout);
        }

        this.releaseFlushedWaiters();

        // Held queries go out after the state has moved off the compile,
        // so a query released by `analysed` above reads no compile as in
        // flight and sends rather than waiting for a compile that has
        // already ended.
        this.releaseCompileDoneWaiters();
    }

    onFullCompileDone(milliseconds: number) {
        if (this.state == QueueState.DOING_FULL_COMPILE_SUPERSEDED) {
            // The compile the analyser cut short. Its diagnostics are
            // whatever it managed before stopping, which is why it sends
            // none; the edit that superseded it is still in flight and its
            // response is what the queue is now waiting for.
            this.progress?.end(Activity.Compile);

            this.state = QueueState.DOING_PARTIAL_COMPILE;

            return;
        }

        if (this.state != QueueState.DOING_FULL_COMPILE) {
            // A stray FULL DONE — drop it rather than transitioning from a
            // state that never requested a full compile.
            log("edit queue: on full compile done: unexpected queue state: " + QueueState[this.state]);
            return;
        }

        this.requester.analysed = true;

        this.progress?.end(Activity.Compile);

        this.recordLatency('compile', this.compile_start_time);
        this.requestStatsIfDue();
        this.requestMemoryIfDue();

        if (milliseconds) {
            this.full_build_timeout = milliseconds * 1.5;

            if (this.full_build_timeout < this.edit_timeout) {
                this.full_build_timeout = this.edit_timeout;
            }

            this.watchdog.setTimeout(this.full_build_timeout * 2);

            if ((this.build_count & 31) == 0) {
                log(`compile request average: ${milliseconds.toFixed()} ms, edit timeout: ${this.edit_timeout.toFixed()} ms, compile timeout: ${this.full_build_timeout.toFixed()} ms, watchdog timeout: ${this.watchdog.timeout_milliseconds.toFixed()} ms`);
            }

            this.build_count++;
        }

        if (this.pending_changes.size > 0) {
            this.state = QueueState.WAITING_FOR_MORE_EDITS;
            this.startEditTimer(this.edit_timeout);
        } else {
            this.state = QueueState.IDLE;
            this.startIdleTimer();
        }

        this.releaseFlushedWaiters();

        // Held queries go out after the state has moved off the compile,
        // for the same reason as in onPartialCompileDone.
        this.releaseCompileDoneWaiters();
    }

    onHeapCheckDone() {
        if (this.state != QueueState.DOING_HEAP_CHECK) {
            // A stray heap-check completion — drop it rather than transitioning
            // from a state that never requested a heap check.
            log("edit queue: on heap check done: unexpected queue state: " + QueueState[this.state]);
            return;
        }

        this.progress?.end(Activity.Heap);

        if (this.pending_changes.size > 0) {
            this.state = QueueState.WAITING_FOR_MORE_EDITS;
            this.startEditTimer(this.edit_timeout);
        } else {
            // Back to IDLE, but the idle timer is deliberately not re-armed:
            // with no edits there are no compiles, so the heap is not growing.
            // The next full compile re-arms it.
            this.state = QueueState.IDLE;
        }

        this.releaseFlushedWaiters();
    }

    forceScheduleFullCompile() {
        this.state = QueueState.WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE;

        this.startEditTimer(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
    }

    private requestFullCompile() {
        this.progress?.report(Activity.Compile, ROUTINE_ANALYSIS_MESSAGE, {
            delay_ms: SLOW_ACTIVITY_DELAY_MS,
            fallback: true
        });

        this.compile_start_time = Date.now();

        this.requester.sendFullCompileRequest();

        this.state = QueueState.DOING_FULL_COMPILE;
    }

    // Fold one round trip into the reported figure. Ignores a completion with
    // no matching send — a stray frame, or one belonging to a compiler that has
    // since been replaced — rather than reporting the time since whenever the
    // last unrelated request happened to go out.
    private recordLatency(kind: 'edit' | 'compile', sent_at: number) {
        if (!sent_at) {
            return;
        }

        const round_trip = Date.now() - sent_at;

        if (kind == 'edit') {
            this.send_start_time = 0;
            this.edit_latency_ms = this.smooth(this.edit_latency_ms, round_trip);
        } else {
            this.compile_start_time = 0;
            this.compile_latency_ms = this.smooth(this.compile_latency_ms, round_trip);
        }

        this.reportMetrics();
    }

    private smooth(previous: number | null, sample: number): number {
        if (previous == null) {
            return sample;
        }

        return previous + EditQueue.LATENCY_SMOOTHING * (sample - previous);
    }

    private reportMetrics() {
        this.metrics?.report(
            this.edit_latency_ms,
            this.compile_latency_ms,
            this.response_handler.incremental_analysis_requested,
            this.incremental_stats,
            this.memory_bytes
        );
    }

    // The analyser's counters, as of the last time they were asked for. Null
    // until the first answer, and cleared when the compiler goes away: the
    // counters are cumulative for one analyser's lifetime, so a set belonging
    // to a process that has died would otherwise be reported as if it
    // described the one that replaced it.
    private incremental_stats: IncrementalStats | null = null;
    private last_stats_request_at: number = 0;

    // The bytes the analyser's process occupies, as of the last answer. Null
    // until one arrives, when the analyser cannot report it, and after the
    // compiler goes away.
    private memory_bytes: number | null = null;
    private last_memory_request_at: number = 0;

    onMemoryUsageReceived(bytes: number) {
        this.memory_bytes = bytes > 0 ? bytes : null;

        this.reportMetrics();
    }

    // As requestStatsIfDue: asked for only where a compile has just finished.
    // Reading the figure collects nothing, so it costs the analyser a syscall.
    private requestMemoryIfDue() {
        if (!this.response_handler.memory_usage_supported) {
            return;
        }

        const now = Date.now();

        if (now - this.last_memory_request_at < EditQueue.STATS_INTERVAL) {
            return;
        }

        this.last_memory_request_at = now;

        this.requester.sendMemoryUsageRequest();
    }

    onStatsReceived(entries: StatEntry[]) {
        this.incremental_stats = summariseIncrementalStats(entries);

        this.reportMetrics();
    }

    // Ask for the counters, no more often than the metrics they accompany are
    // reported. Called only where a compile has just finished, so the request
    // queues behind work that is already done rather than ahead of work the
    // user is waiting on.
    private requestStatsIfDue() {
        if (!this.response_handler.stats_supported) {
            return;
        }

        const now = Date.now();

        if (now - this.last_stats_request_at < EditQueue.STATS_INTERVAL) {
            return;
        }

        this.last_stats_request_at = now;

        this.requester.sendStatsRequest();
    }

    // Self-clearing, so callers never leak a second edit timer: the queue has
    // exactly one edit/compile timer and it belongs to whichever WAITING state
    // armed it. A stale timer that outlived its state would fire onEditTimeout
    // in an unrelated state — the desync the queue's "unexpected state" logs
    // were reporting.
    startEditTimer(timeout: number) {
        this.clearEditTimer();

        this.edit_timer = setTimeout(() => { this.onEditTimeout() }, timeout);
    }

    clearEditTimer() {
        // Unconditional: clearTimeout is a safe no-op on an absent or already-
        // fired handle, and a truthiness guard would skip a live timer whose
        // handle is the falsy 0.
        clearTimeout(this.edit_timer);
        this.edit_timer = null;
    }

    // Self-clearing, so it is safe to call from every IDLE entry point
    // (onFullCompileDone, and onIdleTimeout when it re-arms) without leaking
    // a second timer.
    startIdleTimer() {
        this.clearIdleTimer();

        this.idle_timer = setTimeout(() => { this.onIdleTimeout() }, EditQueue.HEAP_CHECK_IDLE_TIMEOUT);
    }

    clearIdleTimer() {
        if (this.idle_timer) {
            clearTimeout(this.idle_timer);
            this.idle_timer = null;
        }
    }

    // Hand the analyser the whole project, once, when a compiler starts.
    //
    // Deliberately not stamped as the start of an edit. It is not one: it is
    // every file in the project rather than the one being typed in, and it
    // takes seconds rather than milliseconds. Averaged in as though it were a
    // keystroke it dominates the reported figure for the next twenty edits,
    // and every compiler recycle puts it back — which reads as the analyser
    // being far slower than it is.
    start(documents: { uri: string, source: string }[]) {
        this.clearEditTimer();
        this.clearIdleTimer();

        this.state = QueueState.DOING_PARTIAL_COMPILE;
        this.sendMultiEdits(documents);
    }

    // Resolves once the analyser holds the text the editor is showing, so a
    // query about a position means the same thing at both ends.
    //
    // sendQueued below can only flush between round trips. When one is in
    // flight the edits stay queued, and a query sent now is written to the
    // pipe ahead of them and answered against text a keystroke or more
    // behind. For a member completion that is not a slightly stale answer
    // but an answer to a different question: with no `.` in the analyser's
    // text there is no member access at the position, and the reply is the
    // enclosing scope.
    //
    // So wait for the round trip to land, flush, and only then let the query
    // go. Bounded, because a query that never arrives is worse than one
    // answered against text that is behind.
    //
    // Resolves true when the queue reached a lull, false when the bound ran
    // out first — a caller holding state that goes stale across edits (the
    // inlay-hint cache) answers from that state rather than querying text it
    // knows is behind.
    whenFlushed(): Promise<boolean> {
        if (this.pending_changes.size == 0) {
            return Promise.resolve(true);
        }

        this.sendQueued("flush ahead of a query");

        // Flushed synchronously: the edit is already written ahead of the
        // query, and the analyser serves requests in the order it reads them.
        if (this.pending_changes.size == 0) {
            return Promise.resolve(true);
        }

        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => {
                this.flushed_waiters = this.flushed_waiters.filter(w => w !== waiter);

                log("query proceeding without waiting further for the analyser to catch up");

                resolve(false);
            }, EditQueue.FLUSH_WAIT_TIMEOUT);

            const waiter = () => {
                clearTimeout(timer);

                resolve(true);
            };

            this.flushed_waiters.push(waiter);
        });
    }

    // A round trip has landed, so the queue can flush again. Release anything
    // that was waiting for the analyser to catch up, having first given it
    // the edits that accumulated while the round trip was out.
    private releaseFlushedWaiters() {
        if (this.flushed_waiters.length == 0) {
            return;
        }

        this.sendQueued("flush for a waiting query");

        const waiters = this.flushed_waiters;

        this.flushed_waiters = [];

        for (const waiter of waiters) {
            waiter();
        }
    }

    // Flush queued edits ahead of a query (completion / signature help) so the
    // analyser sees the current text before answering. Only meaningful while
    // WAITING with edits not yet sent: if a compile or heap check is already in
    // flight the pending edits ride out on its completion, and barging a second
    // #EDIT# in would leave the queue tracking two in-flight requests as one.
    sendQueued(_why: string = "send queued") {
        // Nothing queued, nothing to flush. An edit carrying no files is not a
        // cheap no-op at the other end: the analyser serves an edit
        // incrementally only when it names exactly one file, so an empty one
        // is declined and answered with a rebuild of the whole project.
        //
        // Semantic tokens flush before every request, and the
        // editor asks for those continuously while typing and scrolling — so
        // an idle queue turned each of them into a whole-project rebuild.
        if (this.pending_changes.size == 0) {
            return;
        }

        if (
            this.state != QueueState.WAITING_FOR_MORE_EDITS &&
            this.state != QueueState.WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE
        ) {
            return;
        }

        this.clearEditTimer();

        this.send_start_time = Date.now();

        let documents = <{ uri: string, source: string}[]>[];

        for (let change of this.pending_changes.values()) {            
            documents.push({uri: change.uri, source: change.text});
        }

        this.pending_changes.clear();

        this.state = QueueState.DOING_PARTIAL_COMPILE;

        // Held open across a burst rather than ended with each round trip:
        // typing produces one of these every few hundred milliseconds, and an
        // indicator that came and went at that rate would strobe. It ends
        // when the queue has absorbed everything, in onPartialCompileDone.
        // Delayed for the same reason every other activity is — an analysis
        // that lands inside the delay is never shown at all, which on a fast
        // project is most of them.
        this.progress?.report(Activity.Edit, ROUTINE_ANALYSIS_MESSAGE, {
            delay_ms: SLOW_ACTIVITY_DELAY_MS,
            fallback: true
        });

        if (!this.sendEdits(documents)) {
            // Every file was an undo back to text the analyser already
            // holds. Advance the state as though a compile had completed
            // with nothing to do, so the queue does not sit waiting for a
            // response that will never come.
            this.onPartialCompileDone(0);
        }
    }

    // Write the queued edits while a full compile is running, so the analyser
    // stops that compile at its next file boundary instead of finishing a
    // walk this edit has already invalidated. Two responses then come back:
    // the compile's, and this edit's.
    private sendSupersedingEdit() {
        if (this.pending_changes.size == 0) {
            return;
        }

        this.clearEditTimer();

        const documents = <{ uri: string, source: string}[]>[];

        for (const change of this.pending_changes.values()) {
            documents.push({uri: change.uri, source: change.text});
        }

        this.pending_changes.clear();

        if (!this.sendEdits(documents)) {
            // Nothing actually went out, so the compile is not superseded
            // and is left to finish.
            return;
        }

        this.send_start_time = Date.now();

        this.state = QueueState.DOING_FULL_COMPILE_SUPERSEDED;

        this.progress?.report(Activity.Edit, ROUTINE_ANALYSIS_MESSAGE, {
            delay_ms: SLOW_ACTIVITY_DELAY_MS,
            fallback: true
        });
    }

    // Send edits as deltas where the analyser can take them, and as full text
    // otherwise. One request either way — the queue expects a single response,
    // and a mix of edit and edit_delta would produce two. So if any file lacks
    // last-sent text the whole batch goes as full text; the common case is one
    // file that was sent before, and that one goes as a delta.
    //
    // Returns whether a request went out. It does not when every file turned
    // out to be unchanged — an undo back to what the analyser already holds —
    // and the caller then has no response to wait for.
    sendEdits(documents: { uri: string, source: string }[]): boolean {
        if (!this.response_handler.edit_deltas_supported) {
            this.sendMultiEdits(documents);

            return true;
        }

        const deltas: EditDelta[] = [];

        for (let doc of documents) {
            const path = normalizeFileUri(doc.uri);
            const lastSent = this.last_sent_text.get(path);

            if (!lastSent) {
                this.sendMultiEdits(documents);

                return true;
            }

            const span = computeSpan(lastSent, doc.source);

            if (!span) {
                // The text did not change — an undo back to what was sent.
                // The analyser already has it, so there is nothing to send.
                continue;
            }

            deltas.push({ path, ...span });

            this.last_sent_text.set(path, doc.source);
        }

        if (deltas.length === 0) {
            return false;
        }

        this.requester.sendEditDeltas(deltas);

        return true;
    }
}