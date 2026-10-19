import {
    CancellationToken,
    CompletionParams,
    Connection,
    DidChangeWatchedFilesNotification,
    DocumentSymbolParams,
    ReferenceParams,
    TextDocumentPositionParams,
    TextDocuments,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { ConnectionEventHandler } from '../src/connection-event-handler';
import { ExtensionState } from '../src/extension-state';
import { WorkspaceContext } from '../src/workspace-context';
import { Requester } from '../src/requester';
import { EditQueue } from '../src/edit-queue';
import { SEMANTIC_TOKENS_LEGEND } from '../src/response-handler';

// ConnectionEventHandler is the thin router between the LSP Connection and
// the per-workspace state held by each WorkspaceContext. Most of the work
// happens in WorkspaceContext / WorkspaceContext.initialize, covered in
// workspace-context.test.ts; here we pin (1) that every connection.onX hook
// is registered, (2) that per-URI requests are dispatched to the workspace
// the URI belongs to, and (3) that requests with no owning workspace come
// back with an empty result rather than blowing up.

const hooks = [
    'onInitialize',
    'onShutdown',
    'onExit',
    'onDidChangeConfiguration',
    'onDidChangeWatchedFiles',
    'onCompletion',
    'onHover',
    'onDefinition',
    'onDeclaration',
    'onSignatureHelp',
    'onDocumentSymbol',
    'onWorkspaceSymbol',
    'onReferences',
    'onImplementation',
    'onTypeDefinition',
    'onRenameRequest',
    'onDocumentFormatting',
    'onDocumentRangeFormatting',
    'onCodeAction',
    'onDidCloseTextDocument',
] as const;

function makeMockConnection(): Connection {
    const conn: any = {};
    for (const h of hooks) {
        conn[h] = jest.fn();
    }
    conn.onInitialized = jest.fn();
    conn.onRequest = jest.fn();
    conn.onNotification = jest.fn();
    conn.languages = {
        semanticTokens: { on: jest.fn() },
        inlayHint: { on: jest.fn() },
    };
    conn.window = {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
    };
    // Workspace folder change notifications live on the `workspace` namespace
    // rather than on the bare Connection object.
    conn.workspace = {
        onDidChangeWorkspaceFolders: jest.fn(),
    };
    conn.client = {
        register: jest.fn(),
    };
    return conn as Connection;
}

function makeMockRequester(): Requester {
    return {
        sendCompletion: jest.fn().mockResolvedValue([]),
        sendHover: jest.fn().mockResolvedValue(null),
        sendDefinition: jest.fn().mockResolvedValue([]),
        sendDeclaration: jest.fn().mockResolvedValue([]),
        sendSignature: jest.fn().mockResolvedValue(null),
        sendDocumentSymbol: jest.fn().mockResolvedValue([]),
        sendWorkspaceSymbol: jest.fn().mockResolvedValue([]),
        sendReferences: jest.fn().mockResolvedValue([]),
        sendImplementation: jest.fn().mockResolvedValue([]),
        sendTypeDefinition: jest.fn().mockResolvedValue(null),
        sendRenameRequest: jest.fn().mockResolvedValue(null),
        sendSemanticTokens: jest.fn().mockResolvedValue({ data: [] }),
        sendDocumentFormatting: jest.fn().mockResolvedValue([]),
        sendDocumentRangeFormatting: jest.fn().mockResolvedValue([]),
        sendInlayHints: jest.fn().mockResolvedValue([]),
        sendAddReferences: jest.fn().mockResolvedValue(null),
    } as unknown as Requester;
}

function makeMockEditQueue(): EditQueue {
    return {
        sendQueued: jest.fn(),
        whenFlushed: jest.fn().mockResolvedValue(true),
        queueEdit: jest.fn(),
    } as unknown as EditQueue;
}

function makeMockWorkspace(requester: Requester, edit_queue: EditQueue): WorkspaceContext {
    return {
        requester,
        edit_queue,
    } as unknown as WorkspaceContext;
}

describe('ConnectionEventHandler', () => {
    let connection: Connection;
    let documents: TextDocuments<TextDocument>;
    let extensionState: ExtensionState;
    let workspace: WorkspaceContext;
    let requester: Requester;
    let editQueue: EditQueue;
    let handler: ConnectionEventHandler;

    beforeEach(() => {
        connection = makeMockConnection();
        documents = {
            get: jest.fn(),
        } as unknown as TextDocuments<TextDocument>;

        requester = makeMockRequester();
        editQueue = makeMockEditQueue();
        workspace = makeMockWorkspace(requester, editQueue);

        // The handler reaches into ExtensionState for routing. Stub only the
        // methods it actually calls so each test can decide whether a
        // workspace owns the URI.
        extensionState = {
            getWorkspaceForUri: jest.fn().mockReturnValue(workspace),
            defaultWorkspace: jest.fn().mockReturnValue(workspace),
            addFolder: jest.fn().mockReturnValue({
                initializeDetached: jest.fn(),
            }),
            removeFolder: jest.fn(),
            setClientSupportsConfiguration: jest.fn(),
            clientSupportsConfiguration: jest.fn().mockReturnValue(false),
            setMaxAnalysers: jest.fn(),
            setVisibleDocuments: jest.fn(),
            setClientSupportsRefresh: jest.fn(),
            allWorkspaces: jest.fn().mockReturnValue([]),
            onDidChangeWatchedFiles: jest.fn(),
        } as unknown as ExtensionState;

        handler = new ConnectionEventHandler(extensionState, connection, documents);
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    describe('constructor', () => {
        it.each(hooks)('registers a handler for connection.%s', hook => {
            expect((connection as any)[hook]).toHaveBeenCalled();
        });

        it('registers the ghul/addReferences request', () => {
            expect((connection as any).onRequest).toHaveBeenCalledWith('ghul/addReferences', expect.any(Function));
        });

        it('registers a semantic tokens handler', () => {
            expect((connection as any).languages.semanticTokens.on).toHaveBeenCalled();
        });
    });

    describe('onInitialize', () => {
        it('registers one workspace per entry in params.workspaceFolders', () => {
            const initializeA = jest.fn();
            const initializeB = jest.fn();
            (extensionState.addFolder as jest.Mock)
                .mockReturnValueOnce({ initializeDetached: initializeA })
                .mockReturnValueOnce({ initializeDetached: initializeB });

            handler.onInitialize({
                workspaceFolders: [
                    { uri: 'file:///workspace/a', name: 'a' },
                    { uri: 'file:///workspace/b', name: 'b' },
                ],
            } as any);

            expect(extensionState.addFolder).toHaveBeenCalledTimes(2);
            expect(extensionState.addFolder).toHaveBeenNthCalledWith(1, '/workspace/a');
            expect(extensionState.addFolder).toHaveBeenNthCalledWith(2, '/workspace/b');

            // Workspace setup is deferred to onInitialized — see the race it
            // avoids in connection-event-handler.ts — so it hasn't run yet.
            expect(initializeA).not.toHaveBeenCalled();
            expect(initializeB).not.toHaveBeenCalled();

            (connection as any).onInitialized.mock.calls[0][0]();

            expect(initializeA).toHaveBeenCalled();
            expect(initializeB).toHaveBeenCalled();
        });

        it('starts only a folder that is a project of its own, and still hands every folder over', () => {
            const initialize = jest.fn();
            (extensionState.addFolder as jest.Mock).mockImplementation((root: string) =>
                root === '/workspace/ghul-project' ? { initializeDetached: initialize } : null);

            handler.onInitialize({
                workspaceFolders: [
                    { uri: 'file:///workspace/ghul-project', name: 'ghul-project' },
                    { uri: 'file:///workspace/just-docs', name: 'just-docs' },
                ],
            } as any);

            expect(extensionState.addFolder).toHaveBeenCalledTimes(2);

            (connection as any).onInitialized.mock.calls[0][0]();

            expect(initialize).toHaveBeenCalledTimes(1);
        });

        it('falls back to params.rootUri when workspaceFolders is absent', () => {
            handler.onInitialize({ rootUri: 'file:///legacy/root' } as any);

            expect(extensionState.addFolder).toHaveBeenCalledWith('/legacy/root');
        });

        it('falls back to params.rootPath when neither workspaceFolders nor rootUri is set', () => {
            handler.onInitialize({ rootPath: '/legacy/root' } as any);

            expect(extensionState.addFolder).toHaveBeenCalledWith('/legacy/root');
        });

        it('registers nothing when the client opens a single file outside any workspace', () => {
            handler.onInitialize({} as any);

            expect(extensionState.addFolder).not.toHaveBeenCalled();
        });

        it('defers workspace folder change subscription until onInitialized fires', () => {
            // The library's onDidChangeWorkspaceFolders getter performs a
            // dynamic client/registerCapability when the auto-registered
            // flag is still false, which is the case during onInitialize
            // — the flag is only set when the library processes the
            // capabilities we return. Subscribing then races the not-yet
            // sent initialize response and crashes the server on every
            // start; the subscription must wait until onInitialized.
            handler.onInitialize({
                capabilities: { workspace: { workspaceFolders: true } },
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            expect((connection as any).workspace.onDidChangeWorkspaceFolders).not.toHaveBeenCalled();
            expect((connection as any).onInitialized).toHaveBeenCalled();

            const initializedCallback =
                (connection as any).onInitialized.mock.calls[0][0];
            initializedCallback();

            expect((connection as any).workspace.onDidChangeWorkspaceFolders).toHaveBeenCalled();
        });

        it('does not subscribe when the client did not declare workspace folder support', () => {
            handler.onInitialize({
                capabilities: {},
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            // onInitialized is now always registered — workspace setup
            // (initializeDetached) defers through it too, regardless of
            // folder/watcher support — but the folder-change subscription
            // itself still only fires when the client declared support.
            expect((connection as any).onInitialized).toHaveBeenCalled();

            (connection as any).onInitialized.mock.calls[0][0]();

            expect((connection as any).workspace.onDidChangeWorkspaceFolders).not.toHaveBeenCalled();
        });

        it('registers file watchers for the project and source patterns once initialized', () => {
            handler.onInitialize({
                capabilities: {
                    workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
                },
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            expect((connection as any).client.register).not.toHaveBeenCalled();

            (connection as any).onInitialized.mock.calls[0][0]();

            expect((connection as any).client.register).toHaveBeenCalledWith(
                DidChangeWatchedFilesNotification.type,
                {
                    watchers: [
                        { globPattern: '**/*.ghul' },
                        { globPattern: '**/*.ghulproj' },
                        { globPattern: '**/Directory.Build.props' },
                        { globPattern: '**/Directory.Packages.props' },
                        { globPattern: '**/dotnet-tools.json' },
                        { globPattern: '**/ghul-project.json' },
                        { globPattern: '**/ghul-project.lock.json' },
                        { globPattern: '**/.block-compiler' },
                    ],
                },
            );
        });

        it('does not register file watchers when the client cannot register dynamically', () => {
            handler.onInitialize({
                capabilities: { workspace: { workspaceFolders: true } },
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            (connection as any).onInitialized.mock.calls[0][0]();

            expect((connection as any).client.register).not.toHaveBeenCalled();
            expect((connection as any).workspace.onDidChangeWorkspaceFolders).toHaveBeenCalled();
        });

        it('subscribes to both folder changes and watched files from one onInitialized handler', () => {
            // Registering onInitialized twice would replace the first
            // callback, so a client supporting both features must still get
            // both subscriptions.
            handler.onInitialize({
                capabilities: {
                    workspace: {
                        workspaceFolders: true,
                        didChangeWatchedFiles: { dynamicRegistration: true },
                    },
                },
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            expect((connection as any).onInitialized).toHaveBeenCalledTimes(1);

            (connection as any).onInitialized.mock.calls[0][0]();

            expect((connection as any).workspace.onDidChangeWorkspaceFolders).toHaveBeenCalled();
            expect((connection as any).client.register).toHaveBeenCalled();
        });

        it('advertises full LSP capabilities including workspace folder change notifications', () => {
            const result = handler.onInitialize({
                workspaceFolders: [{ uri: 'file:///x', name: 'x' }],
            } as any);

            expect(result.capabilities).toEqual(expect.objectContaining({
                completionProvider: { triggerCharacters: ['.', ':'], resolveProvider: false },
                documentSymbolProvider: true,
                workspaceSymbolProvider: true,
                hoverProvider: true,
                definitionProvider: true,
                declarationProvider: true,
                referencesProvider: true,
                signatureHelpProvider: { triggerCharacters: ['(', '['] },
                implementationProvider: true,
                typeDefinitionProvider: true,
                renameProvider: true,
                documentFormattingProvider: true,
                documentRangeFormattingProvider: true,
                semanticTokensProvider: expect.objectContaining({
                    legend: SEMANTIC_TOKENS_LEGEND,
                    full: true,
                    range: false,
                }),
                inlayHintProvider: true,
                workspace: {
                    workspaceFolders: {
                        supported: true,
                        changeNotifications: true,
                    },
                },
            }));
        });
    });

    describe('onDidChangeWorkspaceFolders', () => {
        it('registers and initialises every added folder that looks ghūl-ish', () => {
            const initializeA = jest.fn();
            const initializeB = jest.fn();
            (extensionState.addFolder as jest.Mock)
                .mockReturnValueOnce({ initializeDetached: initializeA })
                .mockReturnValueOnce({ initializeDetached: initializeB });

            handler.onDidChangeWorkspaceFolders({
                added: [
                    { uri: 'file:///workspace/new-a', name: 'new-a' },
                    { uri: 'file:///workspace/new-b', name: 'new-b' },
                ],
                removed: [],
            });

            expect(extensionState.addFolder).toHaveBeenCalledTimes(2);
            expect(extensionState.addFolder).toHaveBeenNthCalledWith(1, '/workspace/new-a');
            expect(extensionState.addFolder).toHaveBeenNthCalledWith(2, '/workspace/new-b');
            expect(initializeA).toHaveBeenCalled();
            expect(initializeB).toHaveBeenCalled();
        });

        it('does not start an added folder that is not a project of its own', () => {
            (extensionState.addFolder as jest.Mock).mockReturnValue(null);

            handler.onDidChangeWorkspaceFolders({
                added: [{ uri: 'file:///workspace/docs', name: 'docs' }],
                removed: [],
            });

            expect(extensionState.addFolder).toHaveBeenCalledWith('/workspace/docs');
        });

        it('unregisters every removed folder', () => {
            handler.onDidChangeWorkspaceFolders({
                added: [],
                removed: [
                    { uri: 'file:///workspace/gone-a', name: 'gone-a' },
                    { uri: 'file:///workspace/gone-b', name: 'gone-b' },
                ],
            });

            expect(extensionState.removeFolder).toHaveBeenCalledTimes(2);
            expect(extensionState.removeFolder).toHaveBeenCalledWith('/workspace/gone-a');
            expect(extensionState.removeFolder).toHaveBeenCalledWith('/workspace/gone-b');
        });

        it('processes removals before additions so a re-added folder rebuilds cleanly', () => {
            // VS Code itself can deliver a remove+add for the same folder in
            // one event (e.g. the user toggles a folder out and back in). The
            // remove must land first so the second add doesn't no-op against
            // the stale registration.
            const order: string[] = [];
            (extensionState.removeFolder as jest.Mock).mockImplementation((root: string) => {
                order.push(`remove:${root}`);
            });
            (extensionState.addFolder as jest.Mock).mockImplementation((root: string) => {
                order.push(`add:${root}`);
                return { initializeDetached: jest.fn() };
            });

            handler.onDidChangeWorkspaceFolders({
                added: [{ uri: 'file:///workspace/x', name: 'x' }],
                removed: [{ uri: 'file:///workspace/x', name: 'x' }],
            });

            expect(order).toEqual(['remove:/workspace/x', 'add:/workspace/x']);
        });
    });

    describe('onShutdown', () => {
        it('disposes every registered workspace', () => {
            const disposeA = jest.fn();
            const disposeB = jest.fn();
            (extensionState.allWorkspaces as jest.Mock).mockReturnValue([
                { dispose: disposeA },
                { dispose: disposeB },
            ]);

            handler.onShutdown();

            expect(disposeA).toHaveBeenCalled();
            expect(disposeB).toHaveBeenCalled();
        });
    });

    describe('per-URI request routing', () => {
        const URI = 'file:///workspace/file.ghul';

        // Forwarded to the requester so a query held during start-up can be
        // dropped when the client stops wanting the answer.
        const TOKEN = CancellationToken.None;

        it('onCompletion with `.` trigger waits for the analyser to catch up and routes via the URI', async () => {
            const params: CompletionParams = {
                textDocument: { uri: URI },
                position: { line: 1, character: 2 },
                context: { triggerCharacter: '.', triggerKind: 1 },
            };

            await handler.onCompletion(params, TOKEN);

            expect(extensionState.getWorkspaceForUri).toHaveBeenCalledWith(URI, 2);
            expect(editQueue.whenFlushed).toHaveBeenCalled();

            // the trigger travels with the query: an analyser that finds no
            // member access at the position must not answer from scope
            expect(requester.sendCompletion).toHaveBeenCalledWith(URI, 1, 2, true, TOKEN);
        });

        it('onCompletion without `.` trigger does not wait', async () => {
            const params: CompletionParams = {
                textDocument: { uri: URI },
                position: { line: 1, character: 2 },
                context: { triggerCharacter: '@', triggerKind: 1 },
            };

            await handler.onCompletion(params, TOKEN);

            expect(editQueue.whenFlushed).not.toHaveBeenCalled();
            expect(requester.sendCompletion).toHaveBeenCalledWith(URI, 1, 2, false, TOKEN);
        });

        it('onHover routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 3, character: 4 },
            };

            await handler.onHover(params, TOKEN);

            expect(requester.sendHover).toHaveBeenCalledWith(URI, 3, 4, TOKEN);
        });

        it('onDefinition routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 0, character: 0 },
            };

            await handler.onDefinition(params, TOKEN);

            expect(requester.sendDefinition).toHaveBeenCalledWith(URI, 0, 0, TOKEN);
        });

        it('onDeclaration routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 0, character: 0 },
            };

            await handler.onDeclaration(params, TOKEN);

            expect(requester.sendDeclaration).toHaveBeenCalledWith(URI, 0, 0, TOKEN);
        });

        it('onSignatureHelp flushes the queue and routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 1, character: 2 },
            };

            await handler.onSignatureHelp(params, TOKEN);

            expect(editQueue.sendQueued).toHaveBeenCalled();
            expect(requester.sendSignature).toHaveBeenCalledWith(URI, 1, 2, TOKEN);
        });

        it('onDocumentSymbol routes via the URI', async () => {
            const params: DocumentSymbolParams = { textDocument: { uri: URI } };

            await handler.onDocumentSymbol(params, TOKEN);

            expect(requester.sendDocumentSymbol).toHaveBeenCalledWith(URI, TOKEN);
        });

        it('onReferences routes via the URI', async () => {
            const params: ReferenceParams = {
                textDocument: { uri: URI },
                position: { line: 5, character: 6 },
                context: { includeDeclaration: true },
            };

            await handler.onReferences(params, TOKEN);

            expect(requester.sendReferences).toHaveBeenCalledWith(URI, 5, 6, TOKEN);
        });

        it('onImplementation routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 0, character: 0 },
            };

            await handler.onImplementation(params, TOKEN);

            expect(requester.sendImplementation).toHaveBeenCalledWith(URI, 0, 0, TOKEN);
        });

        it('onTypeDefinition routes via the URI', async () => {
            const params: TextDocumentPositionParams = {
                textDocument: { uri: URI },
                position: { line: 0, character: 0 },
            };

            await handler.onTypeDefinition(params, TOKEN);

            expect(requester.sendTypeDefinition).toHaveBeenCalledWith(URI, 0, 0, TOKEN);
        });

        it('onRenameRequest routes via the URI and passes the new name', async () => {
            await handler.onRenameRequest({
                textDocument: { uri: URI },
                position: { line: 1, character: 2 },
                newName: 'NewName',
            } as any);

            expect(requester.sendRenameRequest).toHaveBeenCalledWith(URI, 1, 2, 'NewName');
        });

        it('onSemanticTokens flushes the queue and routes via the URI', async () => {
            await handler.onSemanticTokens({
                textDocument: { uri: URI },
            } as any, TOKEN);

            expect(editQueue.sendQueued).toHaveBeenCalled();
            expect(requester.sendSemanticTokens).toHaveBeenCalledWith(URI, TOKEN);
        });

        it('onDocumentFormatting routes via the URI when the buffer is known', async () => {
            (documents.get as jest.Mock).mockReturnValue({
                getText: () => 'source',
                lineCount: 3,
            });

            await handler.onDocumentFormatting({ textDocument: { uri: URI } } as any);

            expect(requester.sendDocumentFormatting).toHaveBeenCalledWith(
                URI,
                'source',
                expect.objectContaining({ start: { line: 0, character: 0 } })
            );
        });

        it('onDocumentRangeFormatting routes via the URI when the buffer is known', async () => {
            (documents.get as jest.Mock).mockReturnValue({
                getText: () => 'source',
                lineCount: 9,
            });
            const range = { start: { line: 3, character: 4 }, end: { line: 5, character: 0 } };

            await handler.onDocumentRangeFormatting({
                textDocument: { uri: URI },
                range,
            } as any);

            expect(requester.sendDocumentRangeFormatting).toHaveBeenCalledWith(URI, 'source', range);
        });
    });

    describe('untracked URIs short-circuit', () => {
        beforeEach(() => {
            (extensionState.getWorkspaceForUri as jest.Mock).mockReturnValue(null);
        });

        it('onCompletion returns an empty list when no workspace owns the URI', async () => {
            const result = await handler.onCompletion({
                textDocument: { uri: 'file:///outside.ghul' },
                position: { line: 0, character: 0 },
                context: { triggerCharacter: '.', triggerKind: 1 },
            });

            expect(result).toEqual([]);
            expect(requester.sendCompletion).not.toHaveBeenCalled();
        });

        it('onHover returns null when no workspace owns the URI', async () => {
            const result = await handler.onHover({
                textDocument: { uri: 'file:///outside.ghul' },
                position: { line: 0, character: 0 },
            });

            expect(result).toBeNull();
            expect(requester.sendHover).not.toHaveBeenCalled();
        });

        it('onDocumentFormatting returns an empty list when no workspace owns the URI', async () => {
            const result = await handler.onDocumentFormatting({
                textDocument: { uri: 'file:///outside.ghul' },
            } as any);

            expect(result).toEqual([]);
            expect(requester.sendDocumentFormatting).not.toHaveBeenCalled();
        });
    });

    describe('configuration changes', () => {
        it('re-reads settings for every workspace when the editor reports a change', () => {
            // Settings become the analyser's command line at spawn time, so a
            // change only takes effect by going round again — nothing can be
            // told to a running compiler about a launch flag.
            const a = { reinitialize: jest.fn() };
            const b = { reinitialize: jest.fn() };

            (extensionState.allWorkspaces as jest.Mock).mockReturnValue([a, b]);

            handler.onDidChangeConfiguration({ settings: {} });

            expect(a.reinitialize).toHaveBeenCalled();
            expect(b.reinitialize).toHaveBeenCalled();
        });
    });

    describe('workspace-wide requests', () => {
        it('onWorkspaceSymbol fans out across every workspace and concatenates results', async () => {
            const symbolsA = [{ name: 'A1' }, { name: 'A2' }];
            const symbolsB = [{ name: 'B1' }];

            (extensionState.allWorkspaces as jest.Mock).mockReturnValue([
                { requester: { sendWorkspaceSymbol: jest.fn().mockResolvedValue(symbolsA) } },
                { requester: { sendWorkspaceSymbol: jest.fn().mockResolvedValue(symbolsB) } },
            ]);

            const result = await handler.onWorkspaceSymbol();

            expect(result).toEqual([...symbolsA, ...symbolsB]);
        });

        it('onWorkspaceSymbol returns an empty list when no workspace is registered', async () => {
            (extensionState.allWorkspaces as jest.Mock).mockReturnValue([]);

            const result = await handler.onWorkspaceSymbol();

            expect(result).toEqual([]);
        });

        it('onWorkspaceSymbol tolerates a workspace that returns null or undefined', async () => {
            // A workspace whose analyser is still warming up returns null
            // from sendWorkspaceSymbol; one bad response shouldn't drop the
            // symbols from the rest of the workspaces.
            (extensionState.allWorkspaces as jest.Mock).mockReturnValue([
                { requester: { sendWorkspaceSymbol: jest.fn().mockReturnValue(null) } },
                { requester: { sendWorkspaceSymbol: jest.fn().mockResolvedValue([{ name: 'B' }]) } },
            ]);

            const result = await handler.onWorkspaceSymbol();

            expect(result).toEqual([{ name: 'B' }]);
        });
    });
    describe('onInlayHint', () => {
        const uri = 'file:///a.ghul';

        function range(startLine: number, endLine: number) {
            return {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: 0 },
            };
        }

        function hint(line: number, label: string) {
            return { position: { line, character: 4 }, label } as any;
        }

        it('asks the analyser for the requested range', async () => {
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            expect(requester.sendInlayHints).toHaveBeenCalledWith(uri, range(0, 10), undefined);
        });

        it('waits for the edit queue to reach a lull rather than forcing a flush', async () => {
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            expect(editQueue.whenFlushed).toHaveBeenCalled();
            expect(editQueue.sendQueued).not.toHaveBeenCalled();
        });

        it('answers from the cache when the queue does not reach a lull', async () => {
            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(3, 'first')]);

            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            (editQueue.whenFlushed as jest.Mock).mockResolvedValue(false);

            const result = await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any);

            expect(result).toEqual([hint(3, 'first')]);
            expect(requester.sendInlayHints).toHaveBeenCalledTimes(1);
        });

        // A fetch answers one range, so a cache that replaced its contents
        // each time would hold only the last range asked about — and the
        // fallback for a viewport that has since scrolled elsewhere would
        // come back empty, dropping hints from the screen, which is the
        // reflow this cache exists to prevent.
        it('keeps hints from ranges fetched earlier when the viewport moves', async () => {
            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(3, 'top')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(53, 'bottom')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(50, 60) } as any);

            (editQueue.whenFlushed as jest.Mock).mockResolvedValue(false);

            expect(await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any))
                .toEqual([hint(3, 'top')]);

            expect(await handler.onInlayHint(
                { textDocument: { uri }, range: range(50, 60) } as any))
                .toEqual([hint(53, 'bottom')]);
        });

        // A re-fetch of a range is the analyser's current answer for it, so a
        // hint it no longer reports must not survive in the cache.
        it('replaces a range rather than accumulating stale hints within it', async () => {
            (requester.sendInlayHints as jest.Mock)
                .mockResolvedValue([hint(3, 'before'), hint(4, 'also before')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(3, 'after')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            (editQueue.whenFlushed as jest.Mock).mockResolvedValue(false);

            expect(await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any))
                .toEqual([hint(3, 'after')]);
        });

        // whenAnalysed resolves a cancelled or timed-out request with its
        // empty fallback rather than an answer about the document, so
        // remembering it would replace real hints with nothing.
        it('does not cache the empty answer a cancelled request resolves to', async () => {
            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(3, 'real')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            const cancelled = { isCancellationRequested: false } as any;

            (requester.sendInlayHints as jest.Mock).mockImplementation(async () => {
                cancelled.isCancellationRequested = true;

                return [];
            });

            const result = await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any, cancelled);

            expect(result).toEqual([hint(3, 'real')]);

            (editQueue.whenFlushed as jest.Mock).mockResolvedValue(false);

            expect(await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any))
                .toEqual([hint(3, 'real')]);
        });

        it('forgets a document\'s hints when it closes', async () => {
            (requester.sendInlayHints as jest.Mock).mockResolvedValue([hint(3, 'first')]);
            await handler.onInlayHint({ textDocument: { uri }, range: range(0, 10) } as any);

            handler.onDidCloseTextDocument({ textDocument: { uri } } as any);

            (editQueue.whenFlushed as jest.Mock).mockResolvedValue(false);

            expect(await handler.onInlayHint(
                { textDocument: { uri }, range: range(0, 10) } as any))
                .toEqual([]);
        });
    });
});

describe('ConnectionEventHandler.onAddReferences', () => {
    let requester: Requester;
    let handler: ConnectionEventHandler;
    let getWorkspaceForUri: jest.Mock;

    beforeEach(() => {
        requester = makeMockRequester();
        getWorkspaceForUri = jest.fn().mockReturnValue(makeMockWorkspace(requester, makeMockEditQueue()));

        const extensionState = {
            getWorkspaceForUri,
            defaultWorkspace: jest.fn(),
            addFolder: jest.fn().mockReturnValue({ initializeDetached: jest.fn() }),
            removeFolder: jest.fn(),
            setClientSupportsConfiguration: jest.fn(),
            clientSupportsConfiguration: jest.fn().mockReturnValue(false),
            setMaxAnalysers: jest.fn(),
            setVisibleDocuments: jest.fn(),
            setClientSupportsRefresh: jest.fn(),
            allWorkspaces: jest.fn().mockReturnValue([]),
            onDidChangeWatchedFiles: jest.fn(),
        } as unknown as ExtensionState;

        handler = new ConnectionEventHandler(
            extensionState, makeMockConnection(), { get: jest.fn() } as unknown as TextDocuments<TextDocument>);
    });

    it('passes the paths to the workspace holding the document', async () => {
        const result = await handler.onAddReferences({ uri: 'file:///w/input.ghul', paths: ['/cells/a.dll'] });

        expect(getWorkspaceForUri).toHaveBeenCalledWith('file:///w/input.ghul', 2);
        expect(requester.sendAddReferences).toHaveBeenCalledWith(['/cells/a.dll']);
        expect(result).toEqual({ message: null });
    });

    it('answers with the analyser\'s reason when it refuses', async () => {
        (requester.sendAddReferences as jest.Mock).mockResolvedValue('cell1 is already referenced');

        const result = await handler.onAddReferences({ uri: 'file:///w/input.ghul', paths: ['/cells/a.dll'] });

        expect(result).toEqual({ message: 'cell1 is already referenced' });
    });

    it('refuses a document no workspace holds', async () => {
        getWorkspaceForUri.mockReturnValue(null);

        const result = await handler.onAddReferences({ uri: 'file:///elsewhere/x.ghul', paths: ['/cells/a.dll'] });

        expect(result.message).toBeTruthy();
        expect(requester.sendAddReferences).not.toHaveBeenCalled();
    });

    it('refuses paths that are not a list of strings', async () => {
        const result = await handler.onAddReferences({ uri: 'file:///w/input.ghul', paths: [42 as unknown as string] });

        expect(result.message).toBeTruthy();
        expect(requester.sendAddReferences).not.toHaveBeenCalled();
    });
});
