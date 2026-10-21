import { TextDocumentChangeEvent } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { EditQueue } from '../src/edit-queue';
import { Requester } from '../src/requester';
import { ResponseHandler } from '../src/response-handler';
import { Watchdog } from '../src/watchdog';
import { Activity, ActivityProgress, ROUTINE_ANALYSIS_MESSAGE, SLOW_ACTIVITY_DELAY_MS } from '../src/activity-progress';
import { MetricsReporter } from '../src/metrics-reporter';

// A minimal Requester stand-in that records every send for assertion.
// We use a class rather than jest.fn() so the test reads like a script.
class RecordingRequester {
    sendDocumentsCalls: Array<{ uri: string; source: string }[]> = [];
    sendEditDeltasCalls: Array<any[]> = [];
    sendFullCompileRequestCalls = 0;
    sendHeapCheckRequestCalls = 0;
    sendStatsRequestCalls = 0;
    sendMemoryUsageRequestCalls = 0;

    // Mirrors the real Requester field the queue flips once a compile
    // round-trip completes; starts false as on a fresh compiler child.
    analysed = false;

    sendDocuments(documents: { uri: string; source: string }[]) {
        this.sendDocumentsCalls.push(documents);
    }
    sendEditDeltas(deltas: any[]) {
        this.sendEditDeltasCalls.push(deltas);
    }
    sendFullCompileRequest() {
        this.sendFullCompileRequestCalls += 1;
    }
    sendHeapCheckRequest() {
        this.sendHeapCheckRequestCalls += 1;
    }
    sendStatsRequest() {
        this.sendStatsRequestCalls += 1;
    }
    sendMemoryUsageRequest() {
        this.sendMemoryUsageRequestCalls += 1;
    }
}

function makeChange(uri: string, version: number, text: string): TextDocumentChangeEvent<TextDocument> {
    return {
        document: TextDocument.create(uri, 'ghul', version, text),
    };
}

describe('EditQueue', () => {
    let recorder: RecordingRequester;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        watchdog = new Watchdog(10000, () => {});
        // The EditQueue only ever asks ResponseHandler to rejectAllAndThrow
        // — every other code path bypasses it. A stub with that one method
        // is enough for the steady-state tests below.
        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
        } as unknown as ResponseHandler;

        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            watchdog
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('queueEdit3', () => {
        it('stores pending changes without sending when in START state', () => {
            queue.queueEdit3('file:///a.ghul', 1, 'text');

            expect(queue.pending_changes.size).toBe(1);
            expect(recorder.sendDocumentsCalls).toEqual([]);
        });

        it('schedules an edit timer when transitioning out of IDLE', () => {
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'text');

            // 100ms is PARTIAL_BUILD_EDIT_TIMEOUT; let the timer fire:
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendDocumentsCalls).toHaveLength(1);
            expect(recorder.sendDocumentsCalls[0]).toEqual([
                { uri: 'file:///a.ghul', source: 'text' },
            ]);
        });

        it('coalesces multiple edits for the same uri into one send', () => {
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'first');
            queue.queueEdit3('file:///a.ghul', 2, 'second');

            // After the timer fires, only one send goes out and it carries
            // the latest text — Map keying by uri does the coalescing:
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendDocumentsCalls).toHaveLength(1);
            expect(recorder.sendDocumentsCalls[0]).toEqual([
                { uri: 'file:///a.ghul', source: 'second' },
            ]);
        });

        it('assigns a synthetic negative version when given a null version', () => {
            queue.queueEdit3('file:///a.ghul', null, 'text');

            const change = queue.pending_changes.get('file:///a.ghul');
            expect(change!.version).toBe(-1);
        });

        it('assigns a unique synthetic version each time', () => {
            queue.queueEdit3('file:///a.ghul', null, 't1');
            queue.queueEdit3('file:///b.ghul', null, 't2');

            const va = queue.pending_changes.get('file:///a.ghul')!.version;
            const vb = queue.pending_changes.get('file:///b.ghul')!.version;
            expect(va).toBe(-1);
            expect(vb).toBe(-2);
        });

        it('does not start a new timer when a partial compile is in flight', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 'text' }]);
            // start() puts us into DOING_PARTIAL_COMPILE — another edit
            // should NOT trigger an immediate send:
            const sendsBefore = recorder.sendDocumentsCalls.length;

            queue.queueEdit3('file:///a.ghul', 2, 'newtext');
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT * 2);

            expect(recorder.sendDocumentsCalls.length).toBe(sendsBefore);
            expect(queue.pending_changes.size).toBe(1);
        });
    });

    describe('queueEdit (TextDocumentChangeEvent overload)', () => {
        it('normalises the uri and queues the document text', () => {
            queue.reset();
            queue.queueEdit(makeChange('file:///dir/a.ghul', 1, 'hello'));

            const change = queue.pending_changes.get('file:///dir/a.ghul');
            expect(change!.text).toBe('hello');
        });
    });

    describe('onPartialCompileDone', () => {
        it('releases a query held while the first compile ends, not a compile later', async () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

            // The requester's analysed setter releases the queries that
            // arrived before the first compile finished, and each of them,
            // against an analyser that cannot answer mid-compile, asks the
            // queue to wait out the compile. That ask happens inside the
            // setter, while the queue is still on its way out of the
            // compile state.
            let late_waiter: Promise<void> | null = null;

            Object.defineProperty(recorder, 'analysed', {
                set: () => { late_waiter = queue.whenNotCompiling(); },
                get: () => false,
                configurable: true,
            });

            queue.onPartialCompileDone(50);

            expect(late_waiter).not.toBeNull();

            // Resolves with the compile that just ended; before the fix it
            // sat in the waiter list until some later compile finished.
            await late_waiter;
        });

        it('moves to WAITING_FOR_MORE_EDITS_AFTER_PARTIAL_COMPILE when nothing is pending', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

            queue.onPartialCompileDone(50);

            // After the watchdog-timeout interval, requestFullCompile should fire:
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
            expect(recorder.sendFullCompileRequestCalls).toBe(1);
        });

        it('moves to WAITING_FOR_MORE_EDITS when there are pending changes', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            // start() emits its own send; capture the count so we can check
            // exactly one further send follows the partial-done timer:
            const sendsAfterStart = recorder.sendDocumentsCalls.length;

            // Queue another edit while in DOING_PARTIAL_COMPILE — it just queues:
            queue.queueEdit3('file:///b.ghul', 1, 'b');

            queue.onPartialCompileDone(50);

            // 50 * 1.5 = 75ms timeout after this transition. Let it fire:
            jest.advanceTimersByTime(75);

            expect(recorder.sendDocumentsCalls).toHaveLength(sendsAfterStart + 1);
            expect(recorder.sendDocumentsCalls[recorder.sendDocumentsCalls.length - 1]).toEqual([
                { uri: 'file:///b.ghul', source: 'b' },
            ]);
        });

        it('bumps edit_timeout based on observed compile time', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

            queue.onPartialCompileDone(200);
            expect(queue.edit_timeout).toBe(300); // 200 * 1.5
        });

        it('marks the requester analysed so queries can be answered', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            expect(recorder.analysed).toBe(false);

            queue.onPartialCompileDone(50);

            expect(recorder.analysed).toBe(true);
        });
    });

    describe('onFullCompileDone', () => {
        it('returns to IDLE when nothing is pending', () => {
            queue.reset();
            queue.forceScheduleFullCompile();
            // jump straight to DOING_FULL_COMPILE:
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
            expect(recorder.sendFullCompileRequestCalls).toBe(1);

            queue.onFullCompileDone(100);

            // No further sends should occur:
            jest.advanceTimersByTime(10_000);
            expect(recorder.sendDocumentsCalls).toEqual([]);
        });

        it('clamps full_build_timeout to at least edit_timeout', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            queue.onPartialCompileDone(1000); // edit_timeout becomes 1500
            // simulate that we're in DOING_FULL_COMPILE before the next call:
            queue.forceScheduleFullCompile();
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);

            queue.onFullCompileDone(100); // would set full_build_timeout = 150
            expect(queue.full_build_timeout).toBe(queue.edit_timeout);
        });

        it('marks the requester analysed so queries can be answered', () => {
            queue.reset();
            queue.forceScheduleFullCompile();
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
            expect(recorder.analysed).toBe(false);

            queue.onFullCompileDone(100);

            expect(recorder.analysed).toBe(true);
        });
    });

    describe('sendQueued', () => {
        it('drains pending_changes into a single send', () => {
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'a');
            queue.queueEdit3('file:///b.ghul', 1, 'b');

            queue.sendQueued('test');

            expect(queue.pending_changes.size).toBe(0);
            expect(recorder.sendDocumentsCalls).toHaveLength(1);
            const docs = recorder.sendDocumentsCalls[0];
            expect(docs.map(d => d.uri).sort()).toEqual(['file:///a.ghul', 'file:///b.ghul']);
        });
    });

    describe('onDiagnosticsReceived', () => {
        it('transitions from START to IDLE', () => {
            expect(queue.state).toBeDefined();
            queue.onDiagnosticsReceived();

            // Calling onDiagnosticsReceived in any other state is a no-op,
            // so this is provable via behaviour: queueing now schedules a timer.
            queue.queueEdit3('file:///a.ghul', 1, 't');
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendDocumentsCalls).toHaveLength(1);
        });
    });

    describe('heap check', () => {
        // Drive the queue to IDLE the way a real session does — through a
        // full compile — so the idle timer is armed.
        function reachIdleAfterFullCompile() {
            queue.reset();
            queue.forceScheduleFullCompile();
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
            queue.onFullCompileDone(100);
        }

        it('sends a heap check request after a long idle period following a full compile', () => {
            reachIdleAfterFullCompile();

            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);

            expect(recorder.sendHeapCheckRequestCalls).toBe(1);
        });

        it('does not send a heap check before the idle period elapses', () => {
            reachIdleAfterFullCompile();

            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT - 1);

            expect(recorder.sendHeapCheckRequestCalls).toBe(0);
        });

        it('an edit during the idle period cancels the heap check', () => {
            reachIdleAfterFullCompile();

            queue.queueEdit3('file:///a.ghul', 1, 'text');
            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);

            expect(recorder.sendHeapCheckRequestCalls).toBe(0);
        });

        it('skips the heap check and re-arms while another request is outstanding', () => {
            reachIdleAfterFullCompile();

            // A query request (hover, completion, …) bypasses the EditQueue;
            // the watchdog running stands in for "a request is in flight".
            watchdog.setTimeout(10_000_000);
            watchdog.startWatchdog();

            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);
            expect(recorder.sendHeapCheckRequestCalls).toBe(0);

            // Once the request completes, the re-armed timer sends it.
            watchdog.clearWatchdog();
            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);
            expect(recorder.sendHeapCheckRequestCalls).toBe(1);
        });

        it('returns to IDLE after the heap check completes', () => {
            reachIdleAfterFullCompile();
            jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);
            expect(recorder.sendHeapCheckRequestCalls).toBe(1);

            queue.onHeapCheckDone();

            // Back in IDLE: a fresh edit schedules an edit timer and sends.
            queue.queueEdit3('file:///a.ghul', 1, 'text');
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);
            expect(recorder.sendDocumentsCalls).toHaveLength(1);
        });
    });

    // Regression cover for the edit-queue desync: an edit timer that outlived
    // the state that armed it would fire onEditTimeout in an unrelated state,
    // and the "unexpected queue state" branches would fall through and arm yet
    // another timer — a self-sustaining cascade of spurious compiles.
    describe('timer discipline', () => {
        it('reset() cancels the pending edit timer (compiler recycle)', () => {
            // An edit arms the edit timer...
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'text');

            // ...then the compiler recycles: reset() returns the queue to IDLE.
            queue.reset();

            // A fresh analysis runs and reaches WAITING_..._AFTER_PARTIAL_COMPILE,
            // which arms its own (much longer) full-build timer.
            queue.start([{ uri: 'file:///a.ghul', source: 'text' }]);
            queue.onPartialCompileDone(0);

            // Had reset() left the first timer alive it would fire here and
            // escalate to a full compile ~900ms early.
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendFullCompileRequestCalls).toBe(0);
        });

        it('start() cancels the pending edit timer', () => {
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'text');

            // start() drives straight into DOING_PARTIAL_COMPILE without going
            // through reset() first — it must still cancel the edit timer.
            queue.start([{ uri: 'file:///a.ghul', source: 'text' }]);
            queue.onPartialCompileDone(0);

            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendFullCompileRequestCalls).toBe(0);
        });

        it('drops a stray PARTIAL DONE without arming a timer', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            queue.onPartialCompileDone(0);
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);
            expect(recorder.sendFullCompileRequestCalls).toBe(1);

            // A stray PARTIAL DONE arrives while the #COMPILE# is still in
            // flight — it must not arm an edit timer that escalates again.
            queue.onPartialCompileDone(0);
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendFullCompileRequestCalls).toBe(1);
        });

        it('drops a stray FULL DONE without leaving its waiting state', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            queue.onPartialCompileDone(0);

            // No #COMPILE# has been sent, so this FULL DONE is stray.
            queue.onFullCompileDone(0);

            // The queue must still be waiting to escalate to a full compile.
            jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);

            expect(recorder.sendFullCompileRequestCalls).toBe(1);
        });

        it('sendQueued does nothing while a compile is already in flight', () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            const sendsAfterStart = recorder.sendDocumentsCalls.length;

            // An edit lands during DOING_PARTIAL_COMPILE, then a completion
            // trigger flushes the queue. The flush must not barge a second
            // #EDIT# in alongside the one already in flight.
            queue.queueEdit3('file:///b.ghul', 1, 'b');
            queue.sendQueued('completion trigger');

            expect(recorder.sendDocumentsCalls).toHaveLength(sendsAfterStart);
            expect(queue.pending_changes.size).toBe(1);

            // The queued edit rides out on the in-flight compile completing.
            queue.onPartialCompileDone(0);
            jest.advanceTimersByTime(EditQueue.PARTIAL_BUILD_EDIT_TIMEOUT);
            expect(recorder.sendDocumentsCalls).toHaveLength(sendsAfterStart + 1);
        });
    });

    // A query about a `.` means nothing unless the analyser has seen the
    // `.`. sendQueued alone cannot promise that: it declines to flush while
    // a round trip is in flight, and the query then goes out ahead of the
    // edits and is answered against text the user has already moved past.
    describe('whenFlushed', () => {
        it('resolves immediately when the analyser is already current', async () => {
            queue.reset();

            await expect(queue.whenFlushed()).resolves.toBe(true);

            expect(recorder.sendDocumentsCalls).toHaveLength(0);
        });

        it('flushes and resolves immediately when the queue is between round trips', async () => {
            queue.reset();
            queue.queueEdit3('file:///a.ghul', 1, 'a');

            await expect(queue.whenFlushed()).resolves.toBe(true);

            expect(queue.pending_changes.size).toBe(0);
            expect(recorder.sendDocumentsCalls).toHaveLength(1);
        });

        it('waits for the in-flight round trip, then flushes before resolving', async () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
            const sendsAfterStart = recorder.sendDocumentsCalls.length;

            queue.queueEdit3('file:///b.ghul', 1, 'b');

            let resolved = false;
            const flushed = queue.whenFlushed().then(() => { resolved = true; });

            // Still in flight: the edit has not gone out and the query is held.
            await Promise.resolve();
            expect(resolved).toBe(false);
            expect(recorder.sendDocumentsCalls).toHaveLength(sendsAfterStart);

            queue.onPartialCompileDone(0);

            await flushed;

            expect(resolved).toBe(true);
            expect(queue.pending_changes.size).toBe(0);
            expect(recorder.sendDocumentsCalls).toHaveLength(sendsAfterStart + 1);
        });

        it('gives up waiting rather than holding the query indefinitely', async () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

            queue.queueEdit3('file:///b.ghul', 1, 'b');

            const flushed = queue.whenFlushed();

            // The round trip never lands — a compiler wedged, or one whose
            // analysis is far slower than the wait.
            jest.advanceTimersByTime(EditQueue.FLUSH_WAIT_TIMEOUT);

            await expect(flushed).resolves.toBe(false);
        });

        it('releases a waiting query when the compiler is replaced', async () => {
            queue.reset();
            queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

            queue.queueEdit3('file:///b.ghul', 1, 'b');

            const flushed = queue.whenFlushed();

            // Nothing is going to report the in-flight request done: the
            // compiler it belonged to is gone.
            queue.reset();

            await expect(flushed).resolves.toBe(true);
        });
    });
});

// The queue is the only place that knows when the analyser is busy and how
// long it took, so it is where both the spinner and the reported latencies
// come from.
describe('EditQueue reporting', () => {
    let recorder: RecordingRequester;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let progress: { report: jest.Mock; end: jest.Mock };
    let metrics: { report: jest.Mock };
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        watchdog = new Watchdog(10000, () => {});
        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
            incremental_analysis_requested: false,
        } as unknown as ResponseHandler;

        progress = { report: jest.fn(), end: jest.fn() };
        metrics = { report: jest.fn() };

        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            watchdog,
            progress as unknown as ActivityProgress,
            metrics as unknown as MetricsReporter
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Drive the queue to the point where the next edit timeout requests a
    // full compile: one partial compile completed with nothing left pending.
    function reachFullCompile() {
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);
        jest.advanceTimersByTime(queue.full_build_timeout);
    }

    it('reports a full analysis as routine, so it shows as a spinner alone', () => {
        reachFullCompile();

        expect(recorder.sendFullCompileRequestCalls).toBe(1);
        expect(progress.report).toHaveBeenCalledWith(
            Activity.Compile,
            ROUTINE_ANALYSIS_MESSAGE,
            { delay_ms: SLOW_ACTIVITY_DELAY_MS, fallback: true });

        queue.onFullCompileDone(200);

        expect(progress.end).toHaveBeenCalledWith(Activity.Compile);
    });

    it('reports an edit being digested, as routine', () => {
        // Nothing reported this at all before: the analyser answered every
        // keystroke with the status bar sitting at rest, so the one part of
        // its work the user is actually waiting on was the one part it never
        // admitted to.
        queue.reset();
        progress.end.mockClear();

        queue.queueEdit3('file:///a.ghul', 1, 'text');
        jest.advanceTimersByTime(queue.edit_timeout);

        expect(progress.report).toHaveBeenCalledWith(
            Activity.Edit,
            ROUTINE_ANALYSIS_MESSAGE,
            { delay_ms: SLOW_ACTIVITY_DELAY_MS, fallback: true });

        queue.onPartialCompileDone(10);

        expect(progress.end).toHaveBeenCalledWith(Activity.Edit);
    });

    it('holds the indicator up across a burst rather than blinking it per round trip', () => {
        // Typing produces a partial compile every few hundred milliseconds.
        // An indicator ended with each one would strobe for as long as the
        // user kept typing, which reads as a fault rather than as progress.
        queue.reset();
        progress.end.mockClear();

        queue.queueEdit3('file:///a.ghul', 1, 'text');
        jest.advanceTimersByTime(queue.edit_timeout);

        queue.queueEdit3('file:///a.ghul', 2, 'more text');
        queue.onPartialCompileDone(10);

        expect(progress.end).not.toHaveBeenCalledWith(Activity.Edit);
    });

    it('says the analyser is garbage collecting while the heap check runs', () => {
        // The heap check is mechanism, not something the user asked for, but
        // it can hold the analyser up — so it is named for what it costs them.
        queue.reset();
        jest.advanceTimersByTime(0);
        queue.startIdleTimer();
        jest.advanceTimersByTime(EditQueue.HEAP_CHECK_IDLE_TIMEOUT);

        expect(recorder.sendHeapCheckRequestCalls).toBe(1);
        expect(progress.report).toHaveBeenCalledWith(
            Activity.Heap,
            'garbage collecting',
            { delay_ms: SLOW_ACTIVITY_DELAY_MS, done_message: 'garbage collected' });

        queue.onHeapCheckDone();

        expect(progress.end).toHaveBeenCalledWith(Activity.Heap);
    });

    it('takes the spinner down when the compiler goes away mid-compile', () => {
        reachFullCompile();

        queue.reset();

        expect(progress.end).toHaveBeenCalledWith(Activity.Compile);
        expect(progress.end).toHaveBeenCalledWith(Activity.Heap);
    });

    // Drive one real edit through the queue: an initial whole-project analysis
    // followed by a keystroke, which is the only thing that counts as an edit.
    function typeOneEdit(uri: string, text: string, took: number) {
        queue.queueEdit3(uri, 2, text);
        queue.sendQueued();
        jest.advanceTimersByTime(took);
        queue.onPartialCompileDone(10);
    }

    it('does not count the initial whole-project analysis as an edit', () => {
        // It is every file in the project, not the one being typed in, and it
        // takes seconds. Averaged in as a keystroke it dominates the reported
        // figure for the next twenty edits, and every compiler recycle puts it
        // back — which reads as a huge latency regression that is not there.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

        jest.advanceTimersByTime(4500);
        queue.onPartialCompileDone(10);

        expect(queue.edit_latency_ms).toBeNull();
        expect(metrics.report).not.toHaveBeenCalled();

        typeOneEdit('file:///a.ghul', 'u', 20);

        // The first real edit is the first measurement, not a correction to a
        // four-and-a-half-second one.
        expect(queue.edit_latency_ms).toBe(20);
    });

    it('does not flush an empty queue', () => {
        // Semantic tokens and inlay hints flush before every request, and the
        // editor asks for those continuously. An edit naming no files is
        // declined by the analyser and answered with a whole-project rebuild,
        // so an idle queue turned each of those requests into one.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        const sends = recorder.sendDocumentsCalls.length;

        // The state a moment after typing stops, with nothing left pending.
        queue.sendQueued('semantic tokens');
        queue.sendQueued('inlay hints');

        expect(recorder.sendDocumentsCalls).toHaveLength(sends);
    });

    it('still flushes a queue that has something in it', () => {
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        queue.queueEdit3('file:///a.ghul', 2, 'u');

        const sends = recorder.sendDocumentsCalls.length;

        queue.sendQueued('completion');

        expect(recorder.sendDocumentsCalls).toHaveLength(sends + 1);
        expect(recorder.sendDocumentsCalls[sends]).toEqual([
            { uri: 'file:///a.ghul', source: 'u' },
        ]);
    });

    it('leaves the debounced full compile to happen on its own', () => {
        // Declining to flush must not also cancel the timer that asks for the
        // full compile once typing has stopped.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        queue.sendQueued('inlay hints');

        jest.advanceTimersByTime(queue.full_build_timeout);

        expect(recorder.sendFullCompileRequestCalls).toBe(1);
    });

    it('drops an in-flight edit clock when the compiler goes away', () => {
        // A recycle or crash mid-edit leaves a timestamp behind. The next
        // compiler's whole-project analysis would then complete against it
        // and report the span between the two as a keystroke.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        queue.queueEdit3('file:///a.ghul', 2, 'u');
        queue.sendQueued();

        jest.advanceTimersByTime(3000);

        // The compiler dies with the edit outstanding, and a fresh one starts.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 'u' }]);

        jest.advanceTimersByTime(4500);
        queue.onPartialCompileDone(10);

        expect(queue.edit_latency_ms).toBeNull();
        expect(metrics.report).not.toHaveBeenCalled();
    });

    it('measures the round trip rather than taking the analyser\'s own figure', () => {
        // What the analyser reports is a maximum of its lifetime mean and its
        // moving average — right for sizing the timeouts, wrong as a latency
        // readout, because a cold start keeps it high long after the project
        // has become fast. The wire figure here (9999) must not be what shows.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        typeOneEdit('file:///a.ghul', 'u', 100);

        expect(queue.edit_latency_ms).toBe(100);
        expect(metrics.report).toHaveBeenLastCalledWith(100, null, false, null, null);
    });

    it('smooths later measurements so a single slow compile does not dominate', () => {
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        typeOneEdit('file:///a.ghul', 'u', 100);
        typeOneEdit('file:///a.ghul', 'v', 1100);

        // 100 + 0.3 * (1100 - 100)
        expect(queue.edit_latency_ms).toBeCloseTo(400);
    });

    it('reports edit and full compile latency separately', () => {
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        typeOneEdit('file:///a.ghul', 'u', 40);

        jest.advanceTimersByTime(queue.full_build_timeout);
        expect(recorder.sendFullCompileRequestCalls).toBe(1);

        jest.advanceTimersByTime(2000);
        queue.onFullCompileDone(10);

        expect(queue.edit_latency_ms).toBe(40);
        expect(queue.compile_latency_ms).toBe(2000);
        expect(metrics.report).toHaveBeenLastCalledWith(40, 2000, false, null, null);
    });

    it('ignores a completion with no matching send', () => {
        // A stray frame, or one belonging to a compiler that has since been
        // replaced, must not be reported as the time since some unrelated
        // request happened to go out.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        typeOneEdit('file:///a.ghul', 'u', 40);

        const reports = metrics.report.mock.calls.length;

        queue.state = 3 as any; // DOING_PARTIAL_COMPILE
        queue.onPartialCompileDone(10);

        expect(metrics.report).toHaveBeenCalledTimes(reports);
        expect(queue.edit_latency_ms).toBe(40);
    });
});

describe('EditQueue incremental statistics', () => {
    let recorder: RecordingRequester;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let metrics: { report: jest.Mock };
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        watchdog = new Watchdog(10000, () => {});
        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
            incremental_analysis_requested: true,
            stats_supported: true,
        } as unknown as ResponseHandler;

        metrics = { report: jest.fn() };

        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            watchdog,
            { report: jest.fn(), end: jest.fn() } as unknown as ActivityProgress,
            metrics as unknown as MetricsReporter
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('asks for the work counters once a compile has completed', () => {
        // After, not before: the counters are only worth having once there is
        // an edit to attribute, and asking on the way in would put the request
        // in front of work the user is waiting on.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);

        expect(recorder.sendStatsRequestCalls).toBe(0);

        queue.onPartialCompileDone(10);

        expect(recorder.sendStatsRequestCalls).toBe(1);
    });

    it('does not ask again within the reporting interval', () => {
        // Typing produces a compile every few hundred milliseconds; the figure
        // is only shown every couple of seconds, so asking per compile would
        // spend a round trip refreshing something nothing displays any sooner.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        queue.start([{ uri: 'file:///a.ghul', source: 'tt' }]);
        queue.onPartialCompileDone(10);

        expect(recorder.sendStatsRequestCalls).toBe(1);

        jest.advanceTimersByTime(EditQueue.STATS_INTERVAL);

        queue.start([{ uri: 'file:///a.ghul', source: 'ttt' }]);
        queue.onPartialCompileDone(10);

        expect(recorder.sendStatsRequestCalls).toBe(2);
    });

    it('asks nothing of an analyser that does not advertise the counters', () => {
        // An analyser that does not know the command answers with an error
        // frame, and an unrecognised frame aborts the compiler — so asking
        // anyway would restart it on every attempt rather than simply going
        // unanswered.
        (responseHandler as unknown as { stats_supported: boolean }).stats_supported = false;

        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 't' }]);
        queue.onPartialCompileDone(10);

        expect(recorder.sendStatsRequestCalls).toBe(0);
    });

    it('reports what the analyser said it did with the edits', () => {
        queue.onStatsReceived([
            { name: 'edit-path-body-rewalk', count: 3, moving_average_ms: 0 },
            { name: 'edit-path-interface-incremental', count: 1, moving_average_ms: 0 },
            { name: 'edit-path-full-rebuild', count: 1, moving_average_ms: 0 },
            { name: 'edit-declined-not-eligible', count: 1, moving_average_ms: 0 },
        ]);

        expect(metrics.report).toHaveBeenLastCalledWith(
            null,
            null,
            true,
            expect.objectContaining({
                body_rewalk: 3,
                interface_incremental: 1,
                full_rebuild: 1,
                total: 5,
                top_decline_reason: 'not-eligible',
            }),
            null);
    });

    it('drops the counters when the compiler goes away', () => {
        // They are cumulative for one analyser's lifetime, so a set belonging
        // to a process that has died would otherwise be reported as if it
        // described the one that replaced it.
        queue.onStatsReceived([
            { name: 'edit-path-body-rewalk', count: 3, moving_average_ms: 0 },
        ]);

        queue.reset();
        metrics.report.mockClear();
        queue.onStatsReceived([]);

        expect(metrics.report).toHaveBeenLastCalledWith(null, null, true, expect.objectContaining({ total: 0 }), null);
    });
});

describe('EditQueue edit deltas', () => {
    let recorder: RecordingRequester;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        watchdog = new Watchdog(10000, () => {});
        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
            incremental_analysis_requested: true,
            stats_supported: true,
            edit_deltas_supported: true,
        } as unknown as ResponseHandler;

        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            watchdog,
            { report: jest.fn(), end: jest.fn() } as unknown as ActivityProgress,
            { report: jest.fn() } as unknown as MetricsReporter
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function queueAndFlushEdit(uri: string, initialText: string, editText: string) {
        queue.reset();
        queue.start([{ uri, source: initialText }]);
        queue.onPartialCompileDone(10);

        queue.queueEdit3(uri, 2, editText);
        jest.advanceTimersByTime(queue.edit_timeout);
    }

    it('sends a delta when the analyser supports deltas and the file was sent before', () => {
        queueAndFlushEdit('file:///a.ghul', 'original', 'changed text');

        expect(recorder.sendEditDeltasCalls).toHaveLength(1);
        expect(recorder.sendDocumentsCalls).toHaveLength(1); // the start() seed
    });

    it('falls back to full text when the analyser does not support deltas', () => {
        (responseHandler as unknown as { edit_deltas_supported: boolean }).edit_deltas_supported = false;

        queueAndFlushEdit('file:///a.ghul', 'original', 'changed text');

        expect(recorder.sendEditDeltasCalls).toHaveLength(0);
        expect(recorder.sendDocumentsCalls).toHaveLength(2); // start + the edit
    });

    it('falls back to full text for a file it has not sent before', () => {
        // The first time a file is edited, there is no retained text to delta
        // against, so it goes as full text.
        queue.reset();
        queue.start([{ uri: 'file:///seed.ghul', source: 'seed' }]);
        queue.onPartialCompileDone(10);

        queue.queueEdit3('file:///new.ghul', 1, 'new file');
        jest.advanceTimersByTime(queue.edit_timeout);

        expect(recorder.sendDocumentsCalls).toHaveLength(2);
        expect(recorder.sendEditDeltasCalls).toHaveLength(0);
    });

    it('sends the expected_length matching the previously sent text', () => {
        // start() sends 'seed' (4 chars), then an edit to the same file sends
        // a delta whose expected_length must be 4.
        queueAndFlushEdit('file:///seed.ghul', 'seed', 'seeded');

        const delta = recorder.sendEditDeltasCalls[0][0];
        expect(delta.expected_length).toBe(4);
        expect(delta.path).toBe('file:///seed.ghul');
    });

    it('clears retained text on reset, so start re-sends full text', () => {
        queueAndFlushEdit('file:///a.ghul', 'original', 'changed');
        expect(recorder.sendEditDeltasCalls).toHaveLength(1);

        // Reset simulates an analyser restart: retained text is gone, so
        // start() after reset sends full text (the second sendDocuments),
        // and populates last_sent_text so the edit after it is a delta.
        queue.reset();
        queue.start([{ uri: 'file:///a.ghul', source: 'changed' }]);
        queue.onPartialCompileDone(10);

        queue.queueEdit3('file:///a.ghul', 3, 'changed again');
        jest.advanceTimersByTime(queue.edit_timeout);

        expect(recorder.sendDocumentsCalls).toHaveLength(2);
        expect(recorder.sendEditDeltasCalls).toHaveLength(2);
    });
});

// An edit made while a full compile is running is written to the analyser
// rather than held until the compile answers. The analyser stops the compile
// at its next file boundary, so the queue then has two responses coming: the
// shortened compile's, and the edit's.
describe('EditQueue superseding a full compile', () => {
    let recorder: RecordingRequester;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        watchdog = new Watchdog(10000, () => {});
        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
            compile_abort_supported: true,
        } as unknown as ResponseHandler;

        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            watchdog,
            { report: jest.fn(), end: jest.fn() } as unknown as ActivityProgress
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Leaves the queue in DOING_FULL_COMPILE with the compile request sent.
    function startFullCompile() {
        queue.reset();
        queue.forceScheduleFullCompile();
        jest.advanceTimersByTime(EditQueue.FULL_BUILD_EDIT_TIMEOUT);

        expect(recorder.sendFullCompileRequestCalls).toBe(1);
    }

    it('writes an edit made during a full compile once the debounce expires', () => {
        startFullCompile();

        queue.queueEdit3('file:///a.ghul', 1, 'edited');

        expect(recorder.sendDocumentsCalls).toHaveLength(0);

        jest.advanceTimersByTime(queue.edit_timeout);

        expect(recorder.sendDocumentsCalls).toEqual([
            [{ uri: 'file:///a.ghul', source: 'edited' }]
        ]);
        expect(queue.pending_changes.size).toBe(0);
    });

    it('holds the edit when the analyser cannot abandon a compile', () => {
        (responseHandler as unknown as { compile_abort_supported: boolean })
            .compile_abort_supported = false;

        startFullCompile();

        queue.queueEdit3('file:///a.ghul', 1, 'edited');
        jest.advanceTimersByTime(10_000);

        expect(recorder.sendDocumentsCalls).toHaveLength(0);
        expect(queue.pending_changes.size).toBe(1);
    });

    it('waits for the edit response after the shortened compile answers', () => {
        startFullCompile();

        queue.queueEdit3('file:///a.ghul', 1, 'edited');
        jest.advanceTimersByTime(queue.edit_timeout);

        // The compile's own response. It is the first of two, so it must not
        // return the queue to IDLE or arm a timer.
        queue.onFullCompileDone(100);

        jest.advanceTimersByTime(10_000);

        expect(recorder.sendFullCompileRequestCalls).toBe(1);
        expect(recorder.sendDocumentsCalls).toHaveLength(1);

        // The edit's response completes the round trip and the queue carries
        // on as it does after any edit.
        queue.onPartialCompileDone(10);

        expect(recorder.analysed).toBe(true);
    });

    it('further edits during the superseded compile wait for the round trip', () => {
        startFullCompile();

        queue.queueEdit3('file:///a.ghul', 1, 'edited');
        jest.advanceTimersByTime(queue.edit_timeout);

        queue.queueEdit3('file:///b.ghul', 1, 'also edited');
        jest.advanceTimersByTime(10_000);

        expect(recorder.sendDocumentsCalls).toHaveLength(1);
        expect(queue.pending_changes.size).toBe(1);

        queue.onFullCompileDone(100);
        queue.onPartialCompileDone(10);

        jest.advanceTimersByTime(queue.edit_timeout);

        expect(recorder.sendDocumentsCalls).toHaveLength(2);
    });
});

describe('EditQueue memory usage', () => {
    let recorder: RecordingRequester;
    let responseHandler: ResponseHandler;
    let metrics: { report: jest.Mock };
    let queue: EditQueue;

    beforeEach(() => {
        jest.useFakeTimers();

        responseHandler = {
            rejectAllAndThrow: (message: string) => { throw message; },
            incremental_analysis_requested: true,
            memory_usage_supported: true,
        } as unknown as ResponseHandler;

        metrics = { report: jest.fn() };
        recorder = new RecordingRequester();
        queue = new EditQueue(
            recorder as unknown as Requester,
            responseHandler,
            new Watchdog(10000, () => {}),
            { report: jest.fn(), end: jest.fn() } as unknown as ActivityProgress,
            metrics as unknown as MetricsReporter
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function compileOnce(text: string) {
        queue.start([{ uri: 'file:///a.ghul', source: text }]);
        queue.onPartialCompileDone(10);
    }

    it('asks for the memory once a compile has completed, and not again within the interval', () => {
        queue.reset();
        compileOnce('t');
        compileOnce('tt');

        expect(recorder.sendMemoryUsageRequestCalls).toBe(1);

        jest.advanceTimersByTime(EditQueue.STATS_INTERVAL);
        compileOnce('ttt');

        expect(recorder.sendMemoryUsageRequestCalls).toBe(2);
    });

    it('asks nothing of an analyser that does not advertise it', () => {
        (responseHandler as unknown as { memory_usage_supported: boolean }).memory_usage_supported = false;

        queue.reset();
        compileOnce('t');

        expect(recorder.sendMemoryUsageRequestCalls).toBe(0);
    });

    it('reports the figure with the metrics', () => {
        queue.reset();
        queue.onMemoryUsageReceived(750 * 1024 * 1024);

        const call = metrics.report.mock.calls[metrics.report.mock.calls.length - 1];

        expect(call[call.length - 1]).toBe(750 * 1024 * 1024);
    });

    it('reports nothing for an analyser that answers 0', () => {
        queue.reset();
        queue.onMemoryUsageReceived(0);

        const call = metrics.report.mock.calls[metrics.report.mock.calls.length - 1];

        expect(call[call.length - 1]).toBeNull();
    });

    it('forgets the figure when the compiler goes away', () => {
        queue.onMemoryUsageReceived(1024);
        queue.reset();
        queue.onStatsReceived([]);

        const call = metrics.report.mock.calls[metrics.report.mock.calls.length - 1];

        expect(call[call.length - 1]).toBeNull();
    });
});
