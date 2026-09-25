export {}

import { Connection } from 'vscode-languageserver';
import { ResponseHandler, parseInlayHints } from '../src/response-handler';
import { ConfigEventEmitter } from '../src/config-event-emitter';
import { GhulConfig } from '../src/ghul-config';
import { ServerManager } from '../src/server-manager';
import { EditQueue } from '../src/edit-queue';

jest.mock('../src/config-event-emitter');

describe('ResponseHandler', () => {
    let connection: Connection;
    let configEventEmitter: ConfigEventEmitter;
    let responseHandler: ResponseHandler;

    beforeEach(() => {
        connection = {} as Connection;
        configEventEmitter = new ConfigEventEmitter();
        responseHandler = new ResponseHandler(connection, configEventEmitter);
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    it('should be constructable', () => {
        expect(responseHandler).toBeInstanceOf(ResponseHandler);
    });

    it('should set want_plaintext_hover when config is available', () => {
        const config: GhulConfig = {
            block: false,
            compiler: [''],
            source: [],
            arguments: [],
            want_plaintext_hover: true,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        };

        responseHandler.onConfigAvailable('workspace', config);

        expect(responseHandler.want_plaintext_hover).toBe(true);
    });

    it('should remove all pending promises', () => {
        responseHandler._hover_promise_queue.enqueue();
        responseHandler._definition_promise_queue.enqueue();
        responseHandler._declaration_promise_queue.enqueue();
        responseHandler._completion_promise_queue.enqueue();
        responseHandler._signature_promise_queue.enqueue();
        responseHandler._symbols_promise_queue.enqueue();
        responseHandler._references_promise_queue.enqueue();
        responseHandler._implementation_promise_queue.enqueue();

        responseHandler.resolveAllPendingPromises();

        expect(responseHandler._hover_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._definition_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._declaration_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._completion_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._signature_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._symbols_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._references_promise_queue.isEmpty()).toBe(true);
        expect(responseHandler._implementation_promise_queue.isEmpty()).toBe(true);
    });

    it('should resolve all pending promises to no result', async () => {
        let hover_promise = responseHandler._hover_promise_queue.enqueue();
        let definition_promise = responseHandler._definition_promise_queue.enqueue();
        let declaration_promise = responseHandler._declaration_promise_queue.enqueue();
        let completion_promise = responseHandler._completion_promise_queue.enqueue();
        let signature_promise = responseHandler._signature_promise_queue.enqueue();
        let symbols_promise = responseHandler._symbols_promise_queue.enqueue();
        let references_promise = responseHandler._references_promise_queue.enqueue();
        let implementation_promise = responseHandler._implementation_promise_queue.enqueue();
        let rename_promise = responseHandler._rename_promise_queue.enqueue();

        responseHandler.resolveAllPendingPromises();

        expect(await hover_promise).toBe(null);
        expect(await definition_promise).toEqual([]);
        expect(await declaration_promise).toEqual([]);
        expect(await completion_promise).toEqual([]);
        expect(await signature_promise).toBe(null);
        expect(await symbols_promise).toEqual([]);
        expect(await references_promise).toEqual([]);
        expect(await implementation_promise).toEqual([]);
        expect(await rename_promise).toBe(null);
    });

    it('should reject all pending promises', async () => {
        let hover_promise = responseHandler._hover_promise_queue.enqueue();
        let definition_promise = responseHandler._definition_promise_queue.enqueue();
        let declaration_promise = responseHandler._declaration_promise_queue.enqueue();
        let completion_promise = responseHandler._completion_promise_queue.enqueue();
        let signature_promise = responseHandler._signature_promise_queue.enqueue();
        let symbols_promise = responseHandler._symbols_promise_queue.enqueue();
        let references_promise = responseHandler._references_promise_queue.enqueue();
        let implementation_promise = responseHandler._implementation_promise_queue.enqueue();
        let rename_promise = responseHandler._rename_promise_queue.enqueue();

        const errorMessage = 'Error occurred';
        responseHandler.rejectAllPendingPromises(errorMessage);

        let results = await Promise.allSettled([
            hover_promise,
            definition_promise,
            declaration_promise,
            completion_promise,
            signature_promise,
            symbols_promise,
            references_promise,
            implementation_promise,
            rename_promise
        ]);

        results.forEach(result => {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected') {
                expect(result.reason).toBe(errorMessage);
            }
        });
    });

    // The editor can have more than one request of a kind outstanding — a
    // go-to-declaration issued while the previous one is still unanswered.
    // Each queue must let go of all of them when the compiler dies, or the
    // extras are left waiting on a process that is gone and that feature
    // never answers again.
    it('rejects every pending promise of a kind, not just the first', async () => {
        const declarations = [
            responseHandler._declaration_promise_queue.enqueue(),
            responseHandler._declaration_promise_queue.enqueue(),
        ];

        const renames = [
            responseHandler._rename_promise_queue.enqueue(),
            responseHandler._rename_promise_queue.enqueue(),
        ];

        responseHandler.rejectAllPendingPromises('compiler died');

        const results = await Promise.allSettled([...declarations, ...renames]);

        results.forEach(result => expect(result.status).toBe('rejected'));
    });

    it('should set the server manager', () => {
        const serverManager: ServerManager = {} as ServerManager;
        responseHandler.setServerManager(serverManager);
        expect(responseHandler.server_manager).toBe(serverManager);
    });

    it('should set the edit queue', () => {
        const editQueue: EditQueue = {} as EditQueue;
        responseHandler.setEditQueue(editQueue);
        expect(responseHandler.edit_queue).toBe(editQueue);
    });

    it('should start listening on handleListen', () => {
        responseHandler.server_manager = {
            startListening: () => {}
        } as ServerManager;

        const startListeningSpy = jest.spyOn(responseHandler.server_manager, 'startListening');
        responseHandler.handleListen();
        expect(startListeningSpy).toHaveBeenCalled();
    });

    describe('handleListen capability check', () => {
        const installStubManager = () => {
            responseHandler.server_manager = {
                startListening: () => {}
            } as ServerManager;
        };

        let logSpy: jest.SpyInstance;

        beforeEach(() => {
            installStubManager();
            logSpy = jest.spyOn(require('../src/log'), 'log').mockImplementation(() => {});
        });

        afterEach(() => {
            logSpy.mockRestore();
        });

        it('warns when the setting is on but capability is absent', () => {
            responseHandler.incremental_analysis_requested = true;
            responseHandler.handleListen({ capabilities: [] });
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('incremental_analysis'));
        });

        it('warns when the setting is on and the listen frame has no capabilities field at all', () => {
            responseHandler.incremental_analysis_requested = true;
            responseHandler.handleListen({});
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('incremental_analysis'));
        });

        it('does not warn when the setting is on and capability is advertised', () => {
            responseHandler.incremental_analysis_requested = true;
            responseHandler.handleListen({ capabilities: ['incremental-analysis'] });
            expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('incremental_analysis'));
        });

        it('records the code-actions capability when the compiler advertises it', () => {
            responseHandler.handleListen({ capabilities: ['incremental-analysis', 'code-actions'] });
            expect(responseHandler.code_actions_supported).toBe(true);
        });

        it('leaves code-actions unsupported when the compiler does not advertise it', () => {
            responseHandler.code_actions_supported = true;
            responseHandler.handleListen({ capabilities: ['incremental-analysis'] });
            expect(responseHandler.code_actions_supported).toBe(false);
        });

        it('does not warn when the setting is off, even if capability is absent', () => {
            responseHandler.incremental_analysis_requested = false;
            responseHandler.handleListen({ capabilities: [] });
            expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('incremental_analysis'));
        });
    });

    it('handleDiagnostics sends one sendDiagnostics call per checked path with its diagnostics', () => {
        responseHandler.connection = {
            sendDiagnostics: () => {}
        } as any;
        responseHandler.edit_queue = {
            onDiagnosticsReceived: () => {},
            onFullCompileDone: () => {},
            onPartialCompileDone: () => {},
        } as any;

        const onDiagnosticsReceivedSpy = jest.spyOn(responseHandler.edit_queue, 'onDiagnosticsReceived');
        const sendDiagnosticsSpy = jest.spyOn(responseHandler.connection, 'sendDiagnostics');

        responseHandler.handleDiagnostics({
            kind: 'diagnostics',
            checked_paths: ['file:///test.ghul'],
            diagnostics: [
                { path: 'file:///test.ghul', start_line: 1, start_column: 20, end_line: 2, end_column: 30, severity: 1, message: 'Diagnostic 1' },
                { path: 'file:///test.ghul', start_line: 1, start_column: 20, end_line: 2, end_column: 30, severity: 2, message: 'Diagnostic 2' },
                { path: 'file:///test.ghul', start_line: 1, start_column: 20, end_line: 2, end_column: 30, severity: 3, message: 'Diagnostic 3' },
                { path: 'file:///test.ghul', start_line: 1, start_column: 20, end_line: 2, end_column: 30, severity: 4, message: 'Diagnostic 4' },
            ],
            phase: 'query',
            elapsed_ms: 0,
            compile_needed: false,
        } as any);

        expect(sendDiagnosticsSpy).toHaveBeenCalledWith({
            uri: 'file:///test.ghul',
            diagnostics: [
                { severity: 1, range: { start: { line: 0, character: 19 }, end: { line: 1, character: 29 } }, message: 'Diagnostic 1', source: 'ghūl' },
                { severity: 2, range: { start: { line: 0, character: 19 }, end: { line: 1, character: 29 } }, message: 'Diagnostic 2', source: 'ghūl' },
                { severity: 3, range: { start: { line: 0, character: 19 }, end: { line: 1, character: 29 } }, message: 'Diagnostic 3', source: 'ghūl' },
                { severity: 4, range: { start: { line: 0, character: 19 }, end: { line: 1, character: 29 } }, message: 'Diagnostic 4', source: 'ghūl' },
            ]
        });
        expect(onDiagnosticsReceivedSpy).toHaveBeenCalled();
    });

    it('handleDiagnostics publishes what the analyser reported', () => {
        responseHandler.connection = { sendDiagnostics: () => {} } as any;
        responseHandler.edit_queue = {
            onDiagnosticsReceived: () => {},
            onFullCompileDone: () => {},
            onPartialCompileDone: () => {},
        } as any;

        const onDiagnosticsReceivedSpy = jest.spyOn(responseHandler.edit_queue, 'onDiagnosticsReceived');
        const sendDiagnosticsSpy = jest.spyOn(responseHandler.connection, 'sendDiagnostics');

        responseHandler.handleDiagnostics({
            kind: 'diagnostics',
            checked_paths: ['file:///test.ghul'],
            diagnostics: [
                { path: 'file:///test.ghul', start_line: 1, start_column: 20, end_line: 2, end_column: 30, severity: 1, message: 'Diagnostic 1' },
            ],
            phase: 'query',
            elapsed_ms: 0,
            compile_needed: false,
        } as any);

        expect(sendDiagnosticsSpy).toHaveBeenCalledWith({
            uri: 'file:///test.ghul',
            diagnostics: [expect.objectContaining({ message: 'Diagnostic 1' })],
        });

        expect(onDiagnosticsReceivedSpy).toHaveBeenCalled();
    });

    it('handleDiagnostics with phase=full drives the edit queue via onFullCompileDone', () => {
        responseHandler.connection = { sendDiagnostics: () => {} } as any;
        responseHandler.edit_queue = {
            onDiagnosticsReceived: () => {},
            onFullCompileDone: () => {},
            onPartialCompileDone: () => {},
        } as any;

        const fullSpy = jest.spyOn(responseHandler.edit_queue, 'onFullCompileDone');
        const partialSpy = jest.spyOn(responseHandler.edit_queue, 'onPartialCompileDone');

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'full', elapsed_ms: 1000, compile_needed: false,
        } as any);

        expect(fullSpy).toHaveBeenCalledWith(1000);
        expect(partialSpy).not.toHaveBeenCalled();
    });

    it('handleDiagnostics with phase=partial drives the edit queue via onPartialCompileDone', () => {
        responseHandler.connection = { sendDiagnostics: () => {} } as any;
        responseHandler.edit_queue = {
            onDiagnosticsReceived: () => {},
            onFullCompileDone: () => {},
            onPartialCompileDone: () => {},
        } as any;

        const fullSpy = jest.spyOn(responseHandler.edit_queue, 'onFullCompileDone');
        const partialSpy = jest.spyOn(responseHandler.edit_queue, 'onPartialCompileDone');

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'partial', elapsed_ms: 500, compile_needed: true,
        } as any);

        expect(partialSpy).toHaveBeenCalledWith(500);
        expect(fullSpy).not.toHaveBeenCalled();
    });

    it('handleDiagnostics with phase=query applies diagnostics but does not drive the state machine', () => {
        responseHandler.connection = { sendDiagnostics: () => {} } as any;
        responseHandler.edit_queue = {
            onDiagnosticsReceived: () => {},
            onFullCompileDone: () => {},
            onPartialCompileDone: () => {},
        } as any;

        const fullSpy = jest.spyOn(responseHandler.edit_queue, 'onFullCompileDone');
        const partialSpy = jest.spyOn(responseHandler.edit_queue, 'onPartialCompileDone');

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'query', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(fullSpy).not.toHaveBeenCalled();
        expect(partialSpy).not.toHaveBeenCalled();
    });

    // The whole-document views the analyser feeds are answered from whatever
    // it held when the request arrived, and the editor re-asks only when the
    // document changes — so an answer computed against text a keystroke behind
    // stays on screen once the typing stops. A compile landing with the queue
    // drained is the point at which the client is asked to come back for the
    // current one.
    const refreshingConnection = () => ({
        sendDiagnostics: () => {},
        languages: {
            semanticTokens: { refresh: jest.fn().mockResolvedValue(undefined) },
            inlayHint: { refresh: jest.fn().mockResolvedValue(undefined) },
        },
    } as any);

    const drainedQueue = (pending: boolean) => ({
        onDiagnosticsReceived: () => {},
        onFullCompileDone: () => {},
        onPartialCompileDone: () => {},
        hasPendingEdits: () => pending,
    } as any);

    it('asks the client to re-fetch tokens and hints once a compile lands with nothing queued', () => {
        responseHandler.connection = refreshingConnection();
        responseHandler.edit_queue = drainedQueue(false);
        responseHandler.client_supports_refresh = true;

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'partial', elapsed_ms: 5, compile_needed: true,
        } as any);

        expect(responseHandler.connection.languages.semanticTokens.refresh).toHaveBeenCalled();
        expect(responseHandler.connection.languages.inlayHint.refresh).toHaveBeenCalled();
    });

    it('does not ask while edits are still queued, since the answer would be as stale', () => {
        responseHandler.connection = refreshingConnection();
        responseHandler.edit_queue = drainedQueue(true);
        responseHandler.client_supports_refresh = true;

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'partial', elapsed_ms: 5, compile_needed: true,
        } as any);

        expect(responseHandler.connection.languages.semanticTokens.refresh).not.toHaveBeenCalled();
        expect(responseHandler.connection.languages.inlayHint.refresh).not.toHaveBeenCalled();
    });

    it('does not ask a client that has not declared it will act on the request', () => {
        responseHandler.connection = refreshingConnection();
        responseHandler.edit_queue = drainedQueue(false);

        responseHandler.handleDiagnostics({
            kind: 'diagnostics', checked_paths: [], diagnostics: [],
            phase: 'full', elapsed_ms: 5, compile_needed: false,
        } as any);

        expect(responseHandler.connection.languages.semanticTokens.refresh).not.toHaveBeenCalled();
        expect(responseHandler.connection.languages.inlayHint.refresh).not.toHaveBeenCalled();
    });

    it('should enqueue and resolve hover promise on expectHover and handleHover', async () => {
        const hoverPromise = responseHandler.expectHover();

        responseHandler.handleHover({
            kind: 'hover',
            signature: 'Foo.bar: int',
            kind_label: 'instance property',
        } as any);

        const hoverResult = await hoverPromise;
        expect(hoverResult).toEqual({
            contents: {
                kind: 'markdown',
                value: '```ghul\nFoo.bar: int\n```\n\n_instance property_',
            },
        });
    });

    it('handleHover omits the classifier line when kind_label is null', async () => {
        const p = responseHandler.expectHover();

        responseHandler.handleHover({
            kind: 'hover',
            signature: 'class Foo',
            kind_label: null,
        } as any);

        await expect(p).resolves.toEqual({
            contents: { kind: 'markdown', value: '```ghul\nclass Foo\n```' },
        });
    });

    it('handleHover appends the doc comment below a rule', async () => {
        const p = responseHandler.expectHover();

        responseHandler.handleHover({
            kind: 'hover',
            signature: 'grow() -> void',
            kind_label: 'method',
            doc: 'Doubles the size.\n\n- by: how much',
        } as any);

        await expect(p).resolves.toEqual({
            contents: {
                kind: 'markdown',
                value: '```ghul\ngrow() -> void\n```\n\n_method_\n\n---\n\nDoubles the size.\n\n- by: how much',
            },
        });
    });

    it('should enqueue and resolve definition promise on expectDefinition and handleDefinition', async () => {
        const definitionPromise = responseHandler.expectDefinition();

        responseHandler.handleDefinition({
            locations: [
                { file: 'file:///path/to/file', start_line: 1, start_column: 20, end_line: 2, end_column: 30 },
            ],
        } as any);

        // Single location → resolves with the Location directly.
        expect(await definitionPromise).toEqual({
            uri: 'file:///path/to/file',
            range: {
                start: { line: 0, character: 19 },
                // end_column passes through without -1, matching the
                // protocol's parseLocations end-column handling.
                end: { line: 1, character: 30 },
            },
        });
    });

    it('should enqueue and resolve declaration promise on expectDeclaration and handleDeclaration', async () => {
        const declarationPromise = responseHandler.expectDeclaration();

        responseHandler.handleDeclaration({
            locations: [
                { file: 'file:///path/to/file', start_line: 1, start_column: 20, end_line: 2, end_column: 30 },
            ],
        } as any);

        expect(await declarationPromise).toEqual([
            {
                uri: 'file:///path/to/file',
                range: {
                    start: { line: 0, character: 19 },
                    end: { line: 1, character: 30 },
                },
            },
        ]);
    });

    it('should enqueue and resolve completion promise on expectCompletion and handleCompletion', async () => {
        const completionPromise = responseHandler.expectCompletion();

        responseHandler.handleCompletion({
            kind: 'completion',
            items: [
                { name: 'item1', kind: 1, description: 'Detail 1' },
                { name: 'item2', kind: 2, description: 'Detail 2' },
            ],
        } as any);

        expect(await completionPromise).toEqual([
            { label: 'item1', kind: 1, detail: 'Detail 1' },
            { label: 'item2', kind: 2, detail: 'Detail 2' },
        ]);
    });

    it('handleCompletion surfaces kind_label as italic documentation, and omits it when absent', async () => {
        const completionPromise = responseHandler.expectCompletion();

        responseHandler.handleCompletion({
            kind: 'completion',
            items: [
                { name: 'meth', kind: 2, description: 'FOO.meth() -> void', kind_label: 'pure method' },
                { name: 'plain', kind: 1, description: 'x: int' },
            ],
        } as any);

        expect(await completionPromise).toEqual([
            {
                label: 'meth',
                kind: 2,
                detail: 'FOO.meth() -> void',
                documentation: { kind: 'markdown', value: '_pure method_' },
            },
            { label: 'plain', kind: 1, detail: 'x: int' },
        ]);
    });

    it('handleCompletion puts the doc comment after the kind label', async () => {
        const completionPromise = responseHandler.expectCompletion();

        responseHandler.handleCompletion({
            kind: 'completion',
            items: [
                { name: 'grow', kind: 2, description: 'grow() -> void', kind_label: 'method', doc: 'Doubles the size.' },
                { name: 'size', kind: 10, description: 'size: int', doc: 'How big it is.' },
            ],
        } as any);

        expect(await completionPromise).toEqual([
            {
                label: 'grow',
                kind: 2,
                detail: 'grow() -> void',
                documentation: { kind: 'markdown', value: '_method_\n\nDoubles the size.' },
            },
            {
                label: 'size',
                kind: 10,
                detail: 'size: int',
                documentation: { kind: 'markdown', value: 'How big it is.' },
            },
        ]);
    });

    it('should enqueue and resolve signature promise on expectSignature and handleSignature', async () => {
        const signaturePromise = responseHandler.expectSignature();

        responseHandler.handleSignature({
            kind: 'signature',
            best_signature_index: 1,
            current_parameter_index: 2,
            signatures: [
                { label: 'function1', parameters: ['f1 param1', 'f1 param2', 'f1 param3'] },
                { label: 'function2', parameters: ['f2 param1', 'f2 param2', 'f2 param3'] },
            ],
        } as any);

        expect(await signaturePromise).toEqual({
            signatures: [
                { label: 'function1', parameters: [{ label: 'f1 param1' }, { label: 'f1 param2' }, { label: 'f1 param3' }] },
                { label: 'function2', parameters: [{ label: 'f2 param1' }, { label: 'f2 param2' }, { label: 'f2 param3' }] },
            ],
            activeSignature: 1,
            activeParameter: 2,
        });
    });

    it('should enqueue and resolve symbols promise on expectSymbols and handleSymbols', async () => {
        const symbolsPromise = responseHandler.expectSymbols();

        responseHandler.handleSymbols({
            kind: 'symbols',
            files: [
                {
                    path: 'file:///path/to/file',
                    symbols: [
                        { search_description: 'symbol1', kind: 1, start_line: 1, start_column: 1, end_line: 1, end_column: 1, qualifier: 'container1' },
                        { search_description: 'symbol2', kind: 2, start_line: 2, start_column: 2, end_line: 2, end_column: 2, qualifier: 'container2' },
                    ],
                },
            ],
        } as any);

        expect(await symbolsPromise).toEqual([
            {
                name: 'symbol1', kind: 1,
                location: {
                    uri: 'file:///path/to/file',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                },
                containerName: 'container1',
            },
            {
                name: 'symbol2', kind: 2,
                location: {
                    uri: 'file:///path/to/file',
                    range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
                },
                containerName: 'container2',
            },
        ]);
    });

    it('should enqueue and resolve references promise on expectReferences and handleReferences', async () => {
        const referencesPromise = responseHandler.expectReferences();

        responseHandler.handleReferences({
            locations: [
                { file: 'file:///path/to/file', start_line: 1, start_column: 20, end_line: 2, end_column: 30 },
            ],
        } as any);

        expect(await referencesPromise).toEqual([
            {
                uri: 'file:///path/to/file',
                range: { start: { line: 0, character: 19 }, end: { line: 1, character: 30 } },
            },
        ]);
    });

    it('handleImplementation parses locations like handleReferences', async () => {
        const p = responseHandler.expectImplementation();
        responseHandler.handleImplementation({
            locations: [
                { file: 'file:///a.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 10 },
                { file: 'file:///b.ghul', start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
            ],
        } as any);

        await expect(p).resolves.toEqual([
            { uri: 'file:///a.ghul', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } },
            { uri: 'file:///b.ghul', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        ]);
    });

    it('handleRenameRequest groups edits by uri', async () => {
        const p = responseHandler.expectRenameRequest();
        responseHandler.handleRenameRequest({
            kind: 'rename',
            edits: [
                { file: 'file:///a.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, new_name: 'newA1' },
                { file: 'file:///a.ghul', start_line: 2, start_column: 1, end_line: 2, end_column: 5, new_name: 'newA2' },
                { file: 'file:///b.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, new_name: 'newB' },
            ],
        } as any);

        const result = await p;
        expect(result.changes!['file:///a.ghul']).toHaveLength(2);
        expect(result.changes!['file:///b.ghul']).toHaveLength(1);
        expect(result.changes!['file:///b.ghul']![0].newText).toBe('newB');
    });

    it('handleRenameRequest resolves with an empty changes object when given no edits', async () => {
        const p = responseHandler.expectRenameRequest();
        responseHandler.handleRenameRequest({ kind: 'rename', edits: [] } as any);

        await expect(p).resolves.toEqual({ changes: {} });
    });

    it('handleHover returns plaintext when want_plaintext_hover is set', async () => {
        responseHandler.want_plaintext_hover = true;
        const p = responseHandler.expectHover();

        responseHandler.handleHover({
            kind: 'hover',
            signature: 'some hover text',
            kind_label: 'local variable',
        } as any);

        await expect(p).resolves.toEqual({
            contents: { kind: 'plaintext', value: 'some hover text // local variable' },
        });
    });

    it('handleHover resolves to null on an empty signature', async () => {
        const p = responseHandler.expectHover();

        responseHandler.handleHover({ kind: 'hover', signature: '', kind_label: null } as any);

        await expect(p).resolves.toBeNull();
    });

    it('handleHover resolves to null on a null description', async () => {
        const p = responseHandler.expectHover();

        responseHandler.handleHover({ kind: 'hover', description: null } as any);

        await expect(p).resolves.toBeNull();
    });

    it('handleHover falls back to description when the analyser omits signature', async () => {
        const p = responseHandler.expectHover();

        responseHandler.handleHover({
            kind: 'hover',
            description: 'Foo.bar: int',
        } as any);

        await expect(p).resolves.toEqual({
            contents: { kind: 'markdown', value: '```ghul\nFoo.bar: int\n```' },
        });
    });

    it('handleDefinition resolves to null when no locations are given', async () => {
        const p = responseHandler.expectDefinition();

        responseHandler.handleDefinition({ locations: [] } as any);

        await expect(p).resolves.toBeNull();
    });

    it('handleDeclaration resolves to [] when no locations are given', async () => {
        const p = responseHandler.expectDeclaration();

        responseHandler.handleDeclaration({ locations: [] } as any);

        await expect(p).resolves.toEqual([]);
    });

    it('handleCompletion resolves to [] when items is empty', async () => {
        const p = responseHandler.expectCompletion();

        responseHandler.handleCompletion({ kind: 'completion', items: [] } as any);

        await expect(p).resolves.toEqual([]);
    });

    it('handleSymbols filters out internal/reflected sentinel uris', async () => {
        const p = responseHandler.expectSymbols();

        responseHandler.handleSymbols({
            kind: 'symbols',
            files: [
                { path: 'internal', symbols: [{ search_description: 'symbolA', kind: 1, start_line: 1, start_column: 1, end_line: 1, end_column: 1, qualifier: 'container' }] },
                { path: 'reflected', symbols: [{ search_description: 'symbolB', kind: 1, start_line: 1, start_column: 1, end_line: 1, end_column: 1, qualifier: 'container' }] },
                { path: 'file:///real.ghul', symbols: [{ search_description: 'symbolC', kind: 1, start_line: 1, start_column: 1, end_line: 1, end_column: 1, qualifier: 'container' }] },
            ],
        } as any);

        const result = await p;
        expect(result.find(s => s.location.uri === 'internal')).toBeUndefined();
        expect(result.find(s => s.location.uri === 'reflected')).toBeUndefined();
        expect(result.map(s => s.name).sort()).toEqual(['symbolC']);
    });

    it('handleSymbols clamps entries with end_column 0 (compiler EOF span) to a valid range', async () => {
        const p = responseHandler.expectSymbols();

        responseHandler.handleSymbols({
            kind: 'symbols',
            files: [
                {
                    path: 'file:///a.ghul',
                    symbols: [
                        { search_description: 'trailing_semicolon', kind: 1, start_line: 7, start_column: 1, end_line: 8, end_column: 0, qualifier: 'container' },
                        { search_description: 'normal', kind: 1, start_line: 1, start_column: 1, end_line: 1, end_column: 6, qualifier: 'container' },
                    ],
                },
            ],
        } as any);

        const result = await p;
        expect(result.map(s => s.name).sort()).toEqual(['normal', 'trailing_semicolon']);

        const clamped = result.find(s => s.name === 'trailing_semicolon')!;
        expect(clamped.location.range.end).toEqual({ line: 7, character: 0 });
    });

    it('handleSignature handles negative active_signature by leaving it undefined', async () => {
        const p = responseHandler.expectSignature();

        responseHandler.handleSignature({
            kind: 'signature',
            best_signature_index: -1,
            current_parameter_index: 0,
            signatures: [{ label: 'fn', parameters: ['param'] }],
        } as any);

        const result = await p;
        expect(result.activeSignature).toBeUndefined();
        expect(result.activeParameter).toBe(0);
        expect(result.signatures).toHaveLength(1);
    });

    it('handleSignature returns an empty signature set when given no signatures', async () => {
        const p = responseHandler.expectSignature();

        responseHandler.handleSignature({
            kind: 'signature', best_signature_index: 0, current_parameter_index: 0, signatures: [],
        } as any);

        const result = await p;
        expect(result.signatures).toEqual([]);
    });

    it('handleRestart notes the recycle and resets the edit queue', () => {
        const reset = jest.fn();
        const noteRecycle = jest.fn();
        responseHandler.edit_queue = { reset } as any;
        responseHandler.server_manager = { noteRecycle } as any;

        responseHandler.handleRestart();

        expect(noteRecycle).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it('handleUnexpected calls server_manager.abort', () => {
        const abort = jest.fn();
        responseHandler.server_manager = { abort } as any;

        responseHandler.handleUnexpected();

        expect(abort).toHaveBeenCalledTimes(1);
    });

    it('setServerManager throws on a second assignment', () => {
        responseHandler.server_manager = { startListening: jest.fn() } as any;

        expect(() => responseHandler.setServerManager({} as any)).toThrow();
    });

    it('setEditQueue throws on a second assignment', () => {
        responseHandler.edit_queue = { reset: jest.fn() } as any;

        expect(() => responseHandler.setEditQueue({} as any)).toThrow();
    });

    it('parseDiagnostics tolerates non-file uri prefixes and adds file://', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                { path: '/abs/path/x.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'message' },
            ],
            phase: 'query', elapsed_ms: 0, compile_needed: false,
        } as any);
        const uris = Array.from(result.keys());
        expect(uris[0].startsWith('file://')).toBe(true);
    });

    it('parseDiagnostics drops internal and reflected paths', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                { path: 'internal', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'msg' },
                { path: 'reflected', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'msg' },
                { path: 'file:///real.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'msg' },
            ],
            phase: 'query', elapsed_ms: 0, compile_needed: false,
        } as any);
        const uris = Array.from(result.keys());
        expect(uris).toEqual(['file:///real.ghul']);
    });

    it('parseDiagnostics carries a code through to Diagnostic.code when present', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                { path: 'file:///a.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 2, message: 'msg', code: 'non-exception-throw' },
                { path: 'file:///b.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'msg' },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(result.get('file:///a.ghul')![0].code).toBe('non-exception-throw');
        expect(result.get('file:///b.ghul')![0].code).toBeUndefined();
    });

    it('parseDiagnostics ignores fixes a compiler still sends with a diagnostic', () => {
        // Fixes belong on the code_actions response. A compiler that still
        // attaches them to reported diagnostics is not a reason to carry
        // per-keystroke payload the code-action path no longer reads.
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                {
                    path: 'file:///a.ghul', start_line: 3, start_column: 9, end_line: 3, end_column: 11,
                    severity: 2, message: "'!' is redundant here", code: 'redundant-unwrap',
                    fixes: [
                        {
                            title: "Remove redundant '!'",
                            is_preferred: true,
                            edits: [
                                { start_line: 3, start_column: 10, end_line: 3, end_column: 11, replaces: '!', new_text: '' },
                            ],
                        },
                    ],
                },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(result.get('file:///a.ghul')![0].data).toBeUndefined();
    });

    it('parseDiagnostics maps related locations to Diagnostic.relatedInformation', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                {
                    path: 'file:///a.ghul', start_line: 3, start_column: 9, end_line: 3, end_column: 11,
                    severity: 2, message: 'hides HasPropertyTest.test: int (case A)', code: 'hides-inherited',
                    related: [
                        {
                            location: { file: 'file:///b.ghul', start_line: 7, start_column: 5, end_line: 7, end_column: 9 },
                            message: 'hidden declaration',
                        },
                    ],
                },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        const related = result.get('file:///a.ghul')![0].relatedInformation!;
        expect(related).toHaveLength(1);
        expect(related[0].message).toBe('hidden declaration');
        expect(related[0].location.uri).toBe('file:///b.ghul');
        expect(related[0].location.range).toEqual({
            start: { line: 6, character: 4 },
            end: { line: 6, character: 8 },
        });
    });

    it('parseDiagnostics drops a related location under internal/reflected, keeping the diagnostic', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                {
                    path: 'file:///a.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5,
                    severity: 2, message: 'msg', code: 'hides-inherited',
                    related: [
                        { location: { file: 'internal', start_line: 1, start_column: 1, end_line: 1, end_column: 1 }, message: 'built-in' },
                    ],
                },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(result.get('file:///a.ghul')).toHaveLength(1);
        expect(result.get('file:///a.ghul')![0].relatedInformation).toBeUndefined();
    });

    it('parseDiagnostics tolerates a response with no related field (older compiler)', () => {
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: [],
            diagnostics: [
                { path: 'file:///a.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 2, message: 'msg' },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(result.get('file:///a.ghul')![0].relatedInformation).toBeUndefined();
    });

    it('parseDiagnostics seeds an empty entry for every clean checked_paths url', () => {
        // The diagnostics "clear errors for a clean file" signal is now
        // explicit: a path that appears in checked_paths but carries no
        // diagnostic entries should still produce a key in the map with
        // an empty array, so the client can clear stale squiggles.
        const result = responseHandler.parseDiagnostics({
            kind: 'diagnostics',
            checked_paths: ['file:///clean.ghul', 'file:///dirty.ghul'],
            diagnostics: [
                { path: 'file:///dirty.ghul', start_line: 1, start_column: 1, end_line: 1, end_column: 5, severity: 1, message: 'msg' },
            ],
            phase: 'full', elapsed_ms: 0, compile_needed: false,
        } as any);

        expect(result.get('file:///clean.ghul')).toEqual([]);
        expect(result.get('file:///dirty.ghul')).toHaveLength(1);
    });
});

describe('parseInlayHints', () => {
    it('converts a 1-based hint to a 0-based position with a fenced ghul tooltip', () => {
        const hints = parseInlayHints([
            { line: 3, column: 5, label: '▸', detail: '▸ Cat', code: 'narrowing-presence' },
        ]);

        expect(hints).toEqual([
            {
                position: { line: 2, character: 4 },
                label: '▸',
                kind: 1, // InlayHintKind.Type
                tooltip: { kind: 'markdown', value: '```ghul\n▸ Cat\n```' },
            },
        ]);
    });

    it('preserves the per-edge line breaks of a merged pair inside the fence', () => {
        const [hint] = parseInlayHints([
            { line: 1, column: 1, label: '▸', detail: '▸ CONS[int]\n▹ NIL', code: 'narrowing-isa' },
        ]);

        expect(hint.tooltip).toEqual({
            kind: 'markdown',
            value: '```ghul\n▸ CONS[int]\n▹ NIL\n```',
        });
    });

    it('emits a plaintext tooltip verbatim when the client wants plaintext', () => {
        const [hint] = parseInlayHints(
            [{ line: 1, column: 1, label: '▸', detail: '▸ CONS[int]\n▹ NIL', code: 'narrowing-isa' }],
            true,
        );

        expect(hint.tooltip).toEqual({ kind: 'plaintext', value: '▸ CONS[int]\n▹ NIL' });
    });

    it('omits the tooltip when there is no detail', () => {
        const [hint] = parseInlayHints([
            { line: 1, column: 1, label: '▸', detail: '', code: 'narrowing-presence' },
        ]);

        expect(hint.tooltip).toBeUndefined();
    });

    it('splits a kill hint into a fenced body and a prose reason', () => {
        const [hint] = parseInlayHints([
            { line: 4, column: 2, label: '◂', detail: 'v\n    ◂ Animal\n\na call here may change it', code: 'narrowing-killed' },
        ]);

        expect(hint.tooltip).toEqual({
            kind: 'markdown',
            value: '```ghul\nv\n    ◂ Animal\n```\n\na call here may change it',
        });
    });

    it('fences the whole detail when there is no blank-line separated note', () => {
        const [hint] = parseInlayHints([
            { line: 1, column: 1, label: '▸', detail: '▸ Cat', code: 'narrowing-presence' },
        ]);

        expect(hint.tooltip).toEqual({ kind: 'markdown', value: '```ghul\n▸ Cat\n```' });
    });
});
