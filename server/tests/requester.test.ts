import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import { CancellationTokenSource } from 'vscode-languageserver';

import { Requester } from '../src/requester';
import { ResponseHandler } from '../src/response-handler';
import { ServerEventEmitter } from '../src/server-event-emitter';
import { Watchdog } from '../src/watchdog';

class CapturingStream extends EventEmitter {
    written: string[] = [];
    write(text: string): boolean {
        this.written.push(text);
        return true;
    }
    joined(): string { return this.written.join(''); }
}

// Records each expectX call so tests can match write order against promise
// allocation order. Returns a fresh resolved promise per call:
class RecordingResponseHandler {
    expectations: string[] = [];

    expectHover() { this.expectations.push('hover'); return Promise.resolve(null); }
    expectDefinition() { this.expectations.push('definition'); return Promise.resolve(null); }
    expectDeclaration() { this.expectations.push('declaration'); return Promise.resolve([]); }
    expectCompletion() { this.expectations.push('completion'); return Promise.resolve([]); }
    expectSignature() { this.expectations.push('signature'); return Promise.resolve(null); }
    expectSymbols() { this.expectations.push('symbols'); return Promise.resolve([]); }
    expectReferences() { this.expectations.push('references'); return Promise.resolve([]); }
    expectImplementation() { this.expectations.push('implementation'); return Promise.resolve([]); }
    expectTypeDefinition() { this.expectations.push('type_definition'); return Promise.resolve(null); }
    expectRenameRequest() { this.expectations.push('rename'); return Promise.resolve(null); }
    expectSemanticTokens() { this.expectations.push('semantic_tokens'); return Promise.resolve({ data: [] }); }
    expectCodeActions() { this.expectations.push('code_actions'); return Promise.resolve([]); }

    add_references_reply: string | null = null;
    expectAddReferences() { this.expectations.push('add_references'); return Promise.resolve(this.add_references_reply); }

    code_actions_supported: boolean = true;
    add_references_supported: boolean = true;
}

function makeRunningChild(stream: CapturingStream): ChildProcess {
    return { pid: 1, stdin: stream } as unknown as ChildProcess;
}

// Each send call serializes one JSON object on one line.
// stream.written is an array of write() chunks; the first chunk is the
// full JSON line including its trailing newline.
function parseOnlyRequest(stream: CapturingStream): any {
    expect(stream.written.length).toBeGreaterThan(0);
    const line = stream.written[0];
    expect(line.endsWith('\n')).toBe(true);
    const request = JSON.parse(line.slice(0, -1));
    // Every request carries its tag under both names; see `send`.
    expect(request.command).toEqual(request.kind);
    delete request.command;
    return request;
}

describe('Requester', () => {
    let events: ServerEventEmitter;
    let response: RecordingResponseHandler;
    let stream: CapturingStream;
    let watchdog: Watchdog;
    let requester: Requester;

    beforeEach(() => {
        watchdog = new Watchdog(10000, () => {});

        events = new ServerEventEmitter();
        response = new RecordingResponseHandler();
        stream = new CapturingStream();

        requester = new Requester(
            events,
            response as unknown as ResponseHandler,
            watchdog
        );

        // onRunning is wired in the constructor; fire it now so the stream
        // is in place for write tests:
        events.running(makeRunningChild(stream));

        // The write-behaviour tests below exercise a ready analyser: mark it
        // analysed, as a completed compile round-trip would. The lifecycle
        // itself (default false, gated senders) is covered by its own tests.
        requester.analysed = true;
    });

    afterEach(() => {
        // send* methods arm the watchdog; if we leave the timer alive past
        // test end it fires into a torn-down test and crashes the worker.
        watchdog.clearWatchdog();
    });

    it('sendCodeActions writes the requested range in 1-based wire coordinates', async () => {
        await requester.sendCodeActions('file:///x.ghul', {
            start: { line: 4, character: 0 },
            end: { line: 4, character: 12 }
        });

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'code_actions',
            path: 'file:///x.ghul',
            start_line: 5,
            start_column: 1,
            end_line: 5,
            end_column: 13
        });
    });

    it('sendCodeActions sends nothing to a compiler that does not advertise the capability', async () => {
        // An analyser that does not know the command never answers it, so
        // the promise queue would stall behind a request that can only end
        // in a watchdog kill.
        response.code_actions_supported = false;

        const fixes = await requester.sendCodeActions('file:///x.ghul', {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
        });

        expect(fixes).toEqual([]);
        expect(stream.written).toEqual([]);
        expect(response.expectations).toEqual([]);
    });

    it('sendAddReferences writes the paths and answers with the analyser\'s reply', async () => {
        expect(await requester.sendAddReferences(['/cells/a.dll'])).toBeNull();

        expect(parseOnlyRequest(stream)).toEqual({ kind: 'add_references', paths: ['/cells/a.dll'] });
    });

    it('sendAddReferences sends nothing to a compiler that does not advertise the capability', async () => {
        response.add_references_supported = false;

        expect(await requester.sendAddReferences(['/cells/a.dll'])).toBeTruthy();
        expect(stream.written).toEqual([]);
    });

    it('gives a fresh analyser every reference added to the one before it', async () => {
        await requester.sendAddReferences(['/cells/a.dll']);
        await requester.sendAddReferences(['/cells/b.dll', '/cells/a.dll']);

        stream.written = [];
        events.listening();

        expect(parseOnlyRequest(stream)).toEqual({ kind: 'add_references', paths: ['/cells/a.dll', '/cells/b.dll'] });
    });

    it('does not remember references the analyser refused', async () => {
        response.add_references_reply = 'a different cell1 is already referenced';
        await requester.sendAddReferences(['/cells/a.dll']);

        stream.written = [];
        events.listening();

        expect(stream.written).toEqual([]);
    });

    it('starts un-analysed: a fresh Requester holds queries until a compile completes', () => {
        // A fresh compiler child has no project state, so the constructor
        // default is false; the edit queue flips it true when a compile
        // round-trip completes.
        const fresh = new Requester(
            new ServerEventEmitter(),
            response as unknown as ResponseHandler,
            watchdog
        );

        expect(fresh.analysed).toBe(false);
    });

    it('a spawn (onStarting) resets analysed to false so queries wait for the new child', () => {
        expect(requester.analysed).toBe(true);

        events.starting();

        expect(requester.analysed).toBe(false);
    });

    it('sendDocuments writes one EDIT JSON line carrying every document', () => {
        requester.sendDocuments([
            { uri: 'file:///a.ghul', source: 'aaa' },
            { uri: 'file:///b.ghul', source: 'bbb' },
        ]);

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'edit',
            files: [
                { path: 'file:///a.ghul', source: 'aaa' },
                { path: 'file:///b.ghul', source: 'bbb' },
            ],
        });
    });

    it('sendHover writes a hover JSON line with 1-based line/column and enqueues a hover promise', async () => {
        const promise = requester.sendHover('file:///x.ghul', 0, 5);

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'hover',
            path: 'file:///x.ghul',
            line: 1,        // 0-based 0 → 1-based 1
            column: 6,      // 0-based 5 → 1-based 6
        });
        expect(response.expectations).toEqual(['hover']);
        await promise;
    });

    it.each([
        ['sendDefinition',     'definition',      'definition'],
        ['sendDeclaration',    'declaration',     'declaration'],
        ['sendSignature',      'signature',       'signature'],
        ['sendReferences',     'references',      'references'],
        ['sendImplementation', 'implementation',  'implementation'],
        ['sendTypeDefinition', 'type_definition', 'type_definition'],
    ])('%s serializes its command JSON and enqueues the matching expect', async (method, command, expectation) => {
        await (requester as any)[method]('file:///x.ghul', 2, 3);

        expect(parseOnlyRequest(stream)).toEqual({
            kind: command,
            path: 'file:///x.ghul',
            line: 3,
            column: 4,
        });
        expect(response.expectations).toEqual([expectation]);
    });

    // Carries one field the other position queries do not: whether the user
    // typed a `.`, which decides whether an analyser holding older text may
    // answer from the enclosing scope.
    it.each([
        [false],
        [true],
    ])('sendCompletion reports is_member_trigger %s', async (is_member_trigger) => {
        await requester.sendCompletion('file:///x.ghul', 2, 3, is_member_trigger);

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'complete',
            path: 'file:///x.ghul',
            line: 3,
            column: 4,
            is_member_trigger,
        });
        expect(response.expectations).toEqual(['completion']);
    });

    it('sendDocumentSymbol writes a symbols JSON line with the uri', async () => {
        await requester.sendDocumentSymbol('file:///x.ghul');

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'symbols',
            path: 'file:///x.ghul',
        });
        expect(response.expectations).toEqual(['symbols']);
    });

    it('sendWorkspaceSymbol writes a symbols JSON line with an empty path', async () => {
        await requester.sendWorkspaceSymbol();

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'symbols',
            path: '',
        });
        expect(response.expectations).toEqual(['symbols']);
    });

    it('sendSemanticTokens writes a semantic_tokens JSON line with the uri', async () => {
        await requester.sendSemanticTokens('file:///x.ghul');

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'semantic_tokens',
            path: 'file:///x.ghul',
        });
        expect(response.expectations).toEqual(['semantic_tokens']);
    });

    it('sendRenameRequest writes a rename JSON line with the new name', async () => {
        await requester.sendRenameRequest('file:///x.ghul', 1, 2, 'newName');

        expect(parseOnlyRequest(stream)).toEqual({
            kind: 'rename',
            path: 'file:///x.ghul',
            line: 2,
            column: 3,
            new_name: 'newName',
        });
        expect(response.expectations).toEqual(['rename']);
    });

    it('sendFullCompileRequest writes a bare compile JSON line', () => {
        requester.sendFullCompileRequest();

        expect(parseOnlyRequest(stream)).toEqual({ kind: 'compile' });
    });

    it('sendRestart writes a bare restart JSON line', () => {
        requester.sendRestart();

        expect(parseOnlyRequest(stream)).toEqual({ kind: 'restart' });
    });

    it('sendHeapCheckRequest writes a bare heap_check JSON line', () => {
        requester.sendHeapCheckRequest();

        expect(parseOnlyRequest(stream)).toEqual({ kind: 'heap_check' });
    });

    describe('queries arriving before the analyser is ready', () => {
        const URI = 'file:///x.ghul';

        // Held queries arm a timeout apiece. Fake timers keep those from
        // firing into a torn-down test; clearAllTimers drops any a test
        // deliberately leaves outstanding.
        beforeEach(() => {
            jest.useFakeTimers();
            requester.analysed = false;
        });

        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
        });

        it('sends nothing until the analyser is ready', () => {
            requester.sendHover(URI, 0, 0);
            requester.sendDefinition(URI, 0, 0);
            requester.sendDeclaration(URI, 0, 0);
            requester.sendCompletion(URI, 0, 0);
            requester.sendSignature(URI, 0, 0);
            requester.sendDocumentSymbol(URI);
            requester.sendWorkspaceSymbol();
            requester.sendReferences(URI, 0, 0);
            requester.sendImplementation(URI, 0, 0);
            requester.sendTypeDefinition(URI, 0, 0);
            requester.sendRenameRequest(URI, 0, 0, 'n');
            requester.sendSemanticTokens(URI);

            expect(stream.written).toEqual([]);
        });

        it('holds a query and sends it once the analyser is ready', async () => {
            const hover = requester.sendHover(URI, 0, 0);

            expect(stream.written).toEqual([]);

            requester.analysed = true;

            await hover;

            expect(parseOnlyRequest(stream).kind).toEqual('hover');
        });

        it('keeps each held send adjacent to its own expectation', async () => {
            const queries = [
                requester.sendHover(URI, 0, 0),
                requester.sendDefinition(URI, 0, 0),
                requester.sendCompletion(URI, 0, 0),
            ];

            requester.analysed = true;

            await Promise.all(queries);

            expect(stream.written.map(line => JSON.parse(line.slice(0, -1)).kind))
                .toEqual(['hover', 'definition', 'complete']);
            expect(response.expectations).toEqual(['hover', 'definition', 'completion']);
        });

        it('falls back to an empty answer when the analyser never becomes ready', async () => {
            const hover = requester.sendHover(URI, 0, 0);

            jest.advanceTimersByTime(60000);

            await expect(hover).resolves.toBeNull();
            expect(stream.written).toEqual([]);
        });

        it('drops a held query the client has withdrawn', async () => {
            // The pointer moved off the hover, the completion was dismissed:
            // sending it when the analyser comes up would spend a round trip
            // on an answer nobody reads.
            const source = new CancellationTokenSource();

            const hover = requester.sendHover(URI, 0, 0, source.token);

            source.cancel();

            await expect(hover).resolves.toBeNull();

            requester.analysed = true;

            expect(stream.written).toEqual([]);
        });

        it('still sends held queries the client has not withdrawn', async () => {
            const cancelled = new CancellationTokenSource();
            const live = new CancellationTokenSource();

            const dropped = requester.sendHover(URI, 0, 0, cancelled.token);
            const kept = requester.sendDefinition(URI, 0, 0, live.token);

            cancelled.cancel();

            await expect(dropped).resolves.toBeNull();

            requester.analysed = true;

            await kept;

            expect(stream.written.map(line => JSON.parse(line.slice(0, -1)).kind))
                .toEqual(['definition']);
        });
    });
});
