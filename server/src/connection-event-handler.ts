
import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Command,
    DidChangeConfigurationParams,
    DidChangeWatchedFilesNotification,
    DidChangeWatchedFilesParams,
    WorkspaceFoldersChangeEvent,
    Definition,
    CompletionItem,
    Hover,
    Connection,
    InitializeResult,
    InitializedParams,
    TextDocumentPositionParams,
    SemanticTokens,
    SemanticTokensParams,
    InlayHint,
    InlayHintParams,
    SignatureHelp,
    CompletionParams,
    DocumentSymbolParams,
    SymbolInformation,
    ReferenceParams,
    Location,
    RenameParams,
    WorkspaceEdit,
    TextDocumentSyncKind,
    DocumentFormattingParams,
    DocumentRangeFormattingParams,
    TextEdit,
    TextDocuments,
    WorkspaceFolder,
    WorkspaceSymbolParams,
    CancellationToken,
    Range,
    DidCloseTextDocumentParams,
} from 'vscode-languageserver';

import { URI } from 'vscode-uri';

import { SEMANTIC_TOKENS_LEGEND } from './response-handler';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { log } from './log';
import { trace } from './request-trace';

import { ExtensionState, Use } from './extension-state';

import { CompilerQuickFixProvider } from './compiler-quick-fix-provider';

import { WorkspaceContext } from './workspace-context';

// Files whose changes affect analysis but which the editor does not
// necessarily have open: the project files and build properties that define
// the source set and compiler options, the source files themselves (a file
// can be created, renamed or deleted outside the editor), and the marker
// that suspends the compiler.
//
// The server asks the client to watch these rather than relying on the
// client to know which patterns matter, so every LSP client watches the
// same set.
export const WATCHED_FILE_GLOBS = [
    '**/*.ghul',
    '**/*.ghulproj',
    '**/Directory.Build.props',
    '**/Directory.Packages.props',
    '**/dotnet-tools.json',
    '**/ghul-project.json',
    '**/ghul-project.lock.json',
    '**/.block-compiler',
];

// `uri` names a document in the workspace whose analyser takes the assemblies.
interface AddReferencesParams {
    uri: string;
    paths: string[];
}

export class ConnectionEventHandler {
    extension_state: ExtensionState;
    connection: Connection;
    documents: TextDocuments<TextDocument>;

    constructor(
        extension_state: ExtensionState,
        connection: Connection,
        documents: TextDocuments<TextDocument>
    ) {
        this.extension_state = extension_state;
        this.connection = connection;
        this.documents = documents;

        connection.onInitialize((params: InitializedParams): InitializeResult =>
            this.onInitialize(params));

        connection.onShutdown(() =>
            this.onShutdown());

        connection.onExit(() =>
            this.onExit());

        connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) =>
            this.onDidChangeConfiguration(change));

        connection.onDidChangeWatchedFiles((change: DidChangeWatchedFilesParams) =>
            this.extension_state.onDidChangeWatchedFiles(change));

        connection.onDidCloseTextDocument((params: DidCloseTextDocumentParams) =>
            this.onDidCloseTextDocument(params));

        // onDidChangeWorkspaceFolders is NOT registered here — its getter
        // throws "Client doesn't support sending workspace folder change
        // events." until the client capabilities have been processed. We
        // register it in onInitialize, gated on the actual client capability.

        connection.onCompletion(
            (textDocumentPosition: CompletionParams, token: CancellationToken): Promise<CompletionItem[]> =>
                this.traced('completion', textDocumentPosition, () => this.onCompletion(textDocumentPosition, token)));

        connection.onHover(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<Hover> =>
                this.traced('hover', params, () => this.onHover(params, token)));

        connection.onDefinition(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<Definition> =>
                this.traced('definition', params, () => this.onDefinition(params, token)));

        connection.onDeclaration(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<Definition> =>
                this.traced('declaration', params, () => this.onDeclaration(params, token)));

        connection.onSignatureHelp(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<SignatureHelp> =>
                this.traced('signatureHelp', params, () => this.onSignatureHelp(params, token)));

        connection.onDocumentSymbol(
            (params: DocumentSymbolParams, token: CancellationToken): Promise<SymbolInformation[]> =>
                this.traced('documentSymbol', params, () => this.onDocumentSymbol(params, token)));

        connection.onWorkspaceSymbol(
            (_params: WorkspaceSymbolParams, token: CancellationToken): Promise<SymbolInformation[]> =>
                this.onWorkspaceSymbol(token));

        connection.onReferences(
            (params: ReferenceParams, token: CancellationToken): Promise<Location[]> =>
                this.traced('references', params, () => this.onReferences(params, token)));

        connection.onImplementation(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<Definition> =>
                this.traced('implementation', params, () => this.onImplementation(params, token)));

        connection.onTypeDefinition(
            (params: TextDocumentPositionParams, token: CancellationToken): Promise<Definition> =>
                this.traced('typeDefinition', params, () => this.onTypeDefinition(params, token)));

        connection.onRenameRequest(
             (params: RenameParams): Promise<WorkspaceEdit> =>
                this.traced('rename', params, () => this.onRenameRequest(params)));

        connection.onDocumentFormatting(
            (params: DocumentFormattingParams): Promise<TextEdit[]> =>
                this.traced('format', params, () => this.onDocumentFormatting(params)));

        connection.onDocumentRangeFormatting(
            (params: DocumentRangeFormattingParams): Promise<TextEdit[]> =>
                this.traced('formatRange', params, () => this.onDocumentRangeFormatting(params)));

        connection.languages.semanticTokens.on(
            (params: SemanticTokensParams, token: CancellationToken): Promise<SemanticTokens> =>
                this.traced('semanticTokens', params, () => this.onSemanticTokens(params, token)));

        connection.languages.inlayHint.on(
            (params: InlayHintParams, token: CancellationToken): Promise<InlayHint[]> =>
                this.traced('inlayHint', params, () => this.onInlayHint(params, token)));

        connection.onCodeAction(
            (params: CodeActionParams): Promise<(Command | CodeAction)[]> =>
                this.traced('codeAction', params, () => this.onCodeAction(params)));

        // Not part of LSP: the client's visible ghūl editors, which pin their
        // projects' analysers (see AnalyserPool).
        connection.onNotification('ghul/visibleDocuments',
            (params: { uris?: string[] }) =>
                this.extension_state.setVisibleDocuments(Array.isArray(params?.uris) ? params.uris : []));

        // Not part of LSP: an interactive session's host adds each cell it has
        // compiled to the reference set of the workspace holding its input.
        connection.onRequest('ghul/addReferences',
            (params: AddReferencesParams): Promise<{ message: string | null }> =>
                this.onAddReferences(params));
    }

    // Request tracing for measuring what the client sends: when
    // GHUL_REQUEST_TRACE names a file, one JSON line is appended per request
    // with the kind, the document and where it routes, without starting
    // anything.
    private traced<T>(kind: string, params: any, run: () => T): T {
        trace(kind, params?.textDocument?.uri, this.extension_state);
        return run();
    }

    async onAddReferences(params: AddReferencesParams): Promise<{ message: string | null }> {
        const workspace = params?.uri ? this.workspaceForUri(params.uri) : null;

        if (!workspace) {
            return { message: "no workspace holds that document" };
        }

        if (!Array.isArray(params.paths) || !params.paths.every(path => typeof path === "string")) {
            return { message: "paths must be a list of strings" };
        }

        return { message: await workspace.requester.sendAddReferences(params.paths) };
    }

    private compiler_quick_fix_provider: CompilerQuickFixProvider = new CompilerQuickFixProvider();

    // Routes per-URI requests to the workspace that owns the file. Returns
    // null when the URI lives outside every registered workspace (or when no
    // workspace is registered yet); the per-request handlers below treat that
    // as an empty result.
    private workspaceForUri(uri: string, use: Use = Use.INTERACTIVE): WorkspaceContext | null {
        return this.extension_state.getWorkspaceForUri(uri, use);
    }

    onInitialize(params: any): InitializeResult {
        // Modern VS Code clients send workspaceFolders for both single-root
        // and multi-root sessions. The legacy rootPath / rootUri fields are
        // still in the LSP spec but deprecated; honour them only as a
        // fallback in case an older client connects.
        // Before any workspace is registered: registerWorkspace copies this
        // onto each context, and setup reads settings only when it is set.
        this.extension_state.setClientSupportsConfiguration(
            !!params.capabilities?.workspace?.configuration
        );

        // Both refreshes are sent together, so both capabilities have to be
        // there before either is used.
        this.extension_state.setClientSupportsRefresh(
            !!params.capabilities?.workspace?.semanticTokens?.refreshSupport &&
            !!params.capabilities?.workspace?.inlayHint?.refreshSupport
        );

        const initial_cap = params.initializationOptions?.maxAnalysers;

        if (typeof initial_cap === 'number') {
            this.extension_state.setMaxAnalysers(initial_cap);
        }

        const roots = this.collectWorkspaceRoots(params);

        const workspaces: WorkspaceContext[] = [];

        // An open folder is a project only if its own marker says so. Whatever
        // else it holds is found and recorded, and starts when a file in it
        // is opened; a folder that is not a project is not an analyser root.
        for (const root of roots) {
            const own = this.extension_state.addFolder(root);

            if (own) {
                workspaces.push(own);
            }
        }

        const wants_folder_events = !!params.capabilities?.workspace?.workspaceFolders;

        const can_register_watchers =
            !!params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration;

        // Everything here is deferred to onInitialized rather than run
        // directly in onInitialize, and all of it goes through one handler
        // because registering onInitialized twice would replace the first
        // callback rather than add to it.
        //
        // Deferral matters for the folder subscription for the reason the
        // original comment gave: the library's `_notificationIsAutoRegistered`
        // flag is set from our returned server capabilities, so reading the
        // getter any earlier triggers a dynamic client/registerCapability
        // call before the client has accepted our initialize response.
        //
        // It matters just as much for workspace setup, which used to run
        // directly in onInitialize: initializeDetached() calls into
        // createWorkDoneProgress(), which sends the client a
        // window/workDoneProgress/create *request* — and the client's own
        // handler for that request is wired up as part of processing our
        // InitializeResult, which is not guaranteed to have happened yet at
        // the point onInitialize runs (the result hasn't even been returned
        // to it). Sent too early, the request lands on a client with no
        // handler registered for it yet and comes back "Unhandled method",
        // which is indistinguishable from a client that doesn't support
        // progress at all — the status bar this powers never appears, with
        // no error visible anywhere but the log. onInitialized fires once
        // the client confirms it has finished processing the response, so
        // waiting for it removes the race entirely.
        this.connection.onInitialized(() => {
            this.readMaxAnalysers();

            for (const workspace of workspaces) {
                // Deliberately not awaited: initialized still arrives well
                // before the client is done with its own start-up work (or
                // sends us the open documents), so setup has to proceed
                // alongside that rather than in front of it.
                workspace.initializeDetached();
            }

            if (wants_folder_events) {
                this.connection.workspace.onDidChangeWorkspaceFolders(
                    (event: WorkspaceFoldersChangeEvent) =>
                        this.onDidChangeWorkspaceFolders(event)
                );
            }

            if (can_register_watchers) {
                this.connection.client.register(DidChangeWatchedFilesNotification.type, {
                    watchers: WATCHED_FILE_GLOBS.map(globPattern => ({ globPattern })),
                });
            }
        });

        return {
            capabilities: {
                textDocumentSync: {
                    openClose: true,
                    change: TextDocumentSyncKind.Incremental
                },
                completionProvider: {
                    // `:` opens a type-position request (let / property /
                    // argument / generic constraint / class-or-trait
                    // inheritance / `(name: type, ...)` tuple element).
                    // The analyser returns no candidates for non-type
                    // `:` contexts (case-when labels, `::` range
                    // operator, tuple-literal `name: value`), so the
                    // popup stays hidden in those cases without any
                    // VSCE-side filtering.
                    triggerCharacters: ['.', ':'],
                    resolveProvider: false,
                },
                documentSymbolProvider: true,
                workspaceSymbolProvider: true,
                hoverProvider: true,
                definitionProvider: true,
                declarationProvider: true,
                referencesProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ["(", "["]
                },
                implementationProvider: true,
                typeDefinitionProvider: true,
                renameProvider: true,
                documentFormattingProvider: true,
                documentRangeFormattingProvider: true,
                semanticTokensProvider: {
                    legend: SEMANTIC_TOKENS_LEGEND,
                    full: true,
                    range: false,
                },
                inlayHintProvider: true,
                codeActionProvider: {
                    // Quick-fixes for diagnostics, authored by the compiler
                    // and carried with each diagnostic over the analysis
                    // protocol.
                    codeActionKinds: [CodeActionKind.QuickFix],
                },
                workspace: {
                    workspaceFolders: {
                        // Tell VS Code we expect to see workspaceFolders in
                        // the initialize params and want notifications when
                        // the user adds or removes a folder at runtime.
                        supported: true,
                        changeNotifications: true,
                    }
                }
            }
        }
    }

    // Resolve the set of workspace folder paths the client is opening.
    // Preference order:
    //   1. params.workspaceFolders — modern, plural, supports multi-root.
    //   2. params.rootUri          — single-root, URI form.
    //   3. params.rootPath         — single-root, plain filesystem path.
    private collectWorkspaceRoots(params: any): string[] {
        const folders: WorkspaceFolder[] | null | undefined = params.workspaceFolders;

        if (folders && folders.length > 0) {
            return folders
                .map(folder => this.folderUriToPath(folder.uri))
                .filter((p): p is string => !!p);
        }

        if (params.rootUri) {
            const path = this.folderUriToPath(params.rootUri);
            if (path) {
                return [path];
            }
        }

        if (params.rootPath) {
            return [params.rootPath];
        }

        return [];
    }

    private folderUriToPath(uri: string): string | null {
        try {
            const parsed = URI.parse(uri);
            return parsed.fsPath || null;
        } catch (e) {
            log(`could not parse workspace folder uri '${uri}': ${e}`);
            return null;
        }
    }

    onDidChangeWorkspaceFolders(event: WorkspaceFoldersChangeEvent) {
        // Removals first: VS Code can deliver a remove+add for the same
        // folder in one event (a folder toggled out and back in); the
        // remove must land first so the re-add isn't a no-op against the
        // stale registration.
        for (const folder of event.removed) {
            const root = this.folderUriToPath(folder.uri);
            if (root) {
                log(`workspace folder removed: ${root}`);
                this.extension_state.removeFolder(root);
            }
        }

        for (const folder of event.added) {
            const root = this.folderUriToPath(folder.uri);
            if (!root) {
                continue;
            }

            log(`workspace folder added: ${root}`);
            this.extension_state.addFolder(root)?.initializeDetached();
        }
    }

    onShutdown() {
        log("language extension: shutting down...");

        for (const workspace of this.extension_state.allWorkspaces()) {
            workspace.dispose();
        }
    }

    onExit() {
        log("language extension: exit");
    }

    // The cap on running analysers is an editor-wide setting, read here rather
    // than per workspace. A client that cannot be asked keeps the default, or
    // the cap it was started with.
    private readMaxAnalysers() {
        if (!this.extension_state.clientSupportsConfiguration() || !this.connection?.workspace?.getConfiguration) {
            return;
        }

        Promise.race([
            this.connection.workspace.getConfiguration('ghul.analysers.max'),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 5000).unref?.())
        ]).then(value => {
            if (typeof value === 'number') {
                this.extension_state.setMaxAnalysers(value);
            }
        }).catch(e => log(`could not read ghul.analysers.max: ${e}`));
    }

    // Settings are read during workspace setup and turned into the analyser's
    // command line, so a change only takes effect by going round again — which
    // restarts the compiler, since some of them (incremental analysis) are
    // launch flags it cannot be told about afterwards.
    //
    // The notification carries the changed values on some clients and nothing
    // useful on others, so it is treated purely as a signal to re-read rather
    // than as a source of values.
    onDidChangeConfiguration(_change: DidChangeConfigurationParams) {
        log("language extension: configuration changed");

        this.readMaxAnalysers();

        for (const workspace of this.extension_state.allWorkspaces()) {
            workspace.reinitialize();
        }
    }

    async onCompletion(textDocumentPosition: CompletionParams, token?: CancellationToken): Promise<CompletionItem[]> {
        const workspace = this.workspaceForUri(textDocumentPosition.textDocument.uri);

        if (!workspace) {
            return [];
        }

        const is_member_trigger = textDocumentPosition.context.triggerCharacter == '.';

        // A member completion is about a `.` the analyser has to have seen,
        // so it waits for the queue to catch the analyser up with the editor
        // before asking. Any other completion is about a position that reads
        // the same either way, and is not worth a wait.
        if (is_member_trigger) {
            await workspace.edit_queue.whenFlushed();
        }

        return workspace.requester.sendCompletion(
            textDocumentPosition.textDocument.uri,
            textDocumentPosition.position.line,
            textDocumentPosition.position.character,
            is_member_trigger,
            token
        );
    }

    onHover(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Hover> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve(null);
        }

        return workspace.requester.sendHover(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onDefinition(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Definition> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendDefinition(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onDeclaration(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Definition> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendDeclaration(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onSignatureHelp(params: TextDocumentPositionParams, token?: CancellationToken): Promise<SignatureHelp> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve(null);
        }

        workspace.edit_queue.sendQueued();

        return workspace.requester.sendSignature(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onDocumentSymbol(params: DocumentSymbolParams, token?: CancellationToken): Promise<SymbolInformation[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri, Use.PASSIVE);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendDocumentSymbol(params.textDocument.uri, token);
    }

    // Workspace-symbol queries aren't URI-scoped, so run them against every
    // registered workspace in parallel and flatten the results. A workspace
    // whose analyser is still warming up or has crashed returns a null or
    // empty array; we coerce both to [] so a single misbehaving workspace
    // can't hide the symbols from the rest.
    async onWorkspaceSymbol(token?: CancellationToken): Promise<SymbolInformation[]> {
        const workspaces = this.extension_state.allWorkspaces();

        if (workspaces.length === 0) {
            return [];
        }

        const per_workspace = await Promise.all(
            workspaces.map(w => w.requester.sendWorkspaceSymbol(token) ?? Promise.resolve([]))
        );

        return per_workspace.reduce<SymbolInformation[]>(
            (all, symbols) => symbols ? all.concat(symbols) : all,
            []
        );
    }

    onReferences(params: ReferenceParams, token?: CancellationToken): Promise<Location[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendReferences(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onImplementation(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Location[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendImplementation(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onTypeDefinition(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Definition> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        return workspace.requester.sendTypeDefinition(params.textDocument.uri, params.position.line, params.position.character, token);
    }

    onRenameRequest(params: RenameParams): Promise<WorkspaceEdit> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve(null);
        }

        return workspace.requester.sendRenameRequest(params.textDocument.uri, params.position.line, params.position.character, params.newName);
    }

    onDocumentFormatting(params: DocumentFormattingParams): Promise<TextEdit[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        let document = this.documents.get(params.textDocument.uri);

        if (!document) {
            return Promise.resolve([]);
        }

        // The whole document is replaced; the analyser reparses the buffer we
        // send, so flushing pending edits first is not required for correctness.
        let whole_document = {
            start: { line: 0, character: 0 },
            end: { line: document.lineCount + 1, character: 0 }
        };

        return workspace.requester.sendDocumentFormatting(
            params.textDocument.uri,
            document.getText(),
            whole_document
        );
    }

    async onCodeAction(params: CodeActionParams): Promise<(Command | CodeAction)[]> {
        const document = this.documents.get(params.textDocument.uri);

        if (!document) {
            return [];
        }

        const workspace = this.workspaceForUri(params.textDocument.uri, Use.PASSIVE);

        if (!workspace) {
            return [];
        }

        // Fixes are asked for here rather than carried on the diagnostics:
        // synthesizing them sweeps the AST of every file holding a warning,
        // which on the edit path is the whole project on every keystroke.
        // Wire order is presentation order (removal fix first, then
        // suppressions).
        const diagnostics = await workspace.requester.sendCodeActions(
            params.textDocument.uri,
            params.range
        );

        return this.compiler_quick_fix_provider.provide(
            document,
            params.textDocument.uri,
            diagnostics
        );
    }

    onSemanticTokens(params: SemanticTokensParams, token?: CancellationToken): Promise<SemanticTokens> {
        const workspace = this.workspaceForUri(params.textDocument.uri, Use.PASSIVE);

        if (!workspace) {
            return Promise.resolve({ data: [] });
        }

        // Flush queued edits so the analyser's hover map reflects the
        // current document text before we ask for tokens.
        workspace.edit_queue.sendQueued();

        return workspace.requester.sendSemanticTokens(params.textDocument.uri, token);
    }

    // Every hint fetched for a document, accumulated across the ranges the
    // editor has asked about. Inlay hints occupy horizontal space, so a set
    // that appears and disappears reflows the lines it sits on; while the
    // analyser is busy catching up on edits, the previous hints are a better
    // answer than an empty one, and VS Code keeps the rendered hints until a
    // response arrives, so answering from here re-affirms what is on screen.
    //
    // Accumulated rather than replaced because a fetch answers one range: a
    // viewport that has moved since the last fetch would otherwise find the
    // cache scoped to the range before it and go empty exactly where the
    // fallback is meant to hold the previous hints steady. A later fetch of a
    // range replaces that range's entries, so a hint the analyser has dropped
    // does not survive a re-fetch covering it.
    // Evicted on didClose so the map stays bounded by currently-open documents.
    private last_inlay_hints = new Map<string, InlayHint[]>();

    async onInlayHint(params: InlayHintParams, token?: CancellationToken): Promise<InlayHint[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri, Use.PASSIVE);

        if (!workspace) {
            return Promise.resolve([]);
        }

        // Inlay hints are the least latency-sensitive query the analyser
        // serves, so wait for the edit queue to reach a lull rather than
        // forcing a flush ahead of the ask — a forced flush pre-empted the
        // queue's own debounce, so inlay polling drove compiles while
        // typing. Bounded: if the lull does not arrive because a long
        // compile is running, answer from the cache rather than holding.
        const flushed = await workspace.edit_queue.whenFlushed();

        if (!flushed || token?.isCancellationRequested) {
            return this.cachedInlayHints(params.textDocument.uri, params.range);
        }

        const hints =
            await workspace.requester.sendInlayHints(params.textDocument.uri, params.range, token);

        // A request withdrawn while the analyser was still coming up, or one
        // that timed out waiting for it, resolves to the empty fallback
        // rather than to an answer about the document. Remembering that would
        // overwrite real hints with nothing and leave the next fallback for
        // this range empty, which is the reflow the cache exists to prevent.
        if (token?.isCancellationRequested) {
            return this.cachedInlayHints(params.textDocument.uri, params.range);
        }

        this.rememberInlayHints(params.textDocument.uri, params.range, hints);

        return hints;
    }

    // Fold a freshly-fetched range into the document's hints: drop what the
    // cache held for that range, keep everything outside it, and add what
    // came back.
    private rememberInlayHints(uri: string, range: Range, hints: InlayHint[]) {
        const outside = (this.last_inlay_hints.get(uri) ?? [])
            .filter(h => !ConnectionEventHandler.withinRange(h, range));

        this.last_inlay_hints.set(uri, [...outside, ...hints]);
    }

    // The document's accumulated hints narrowed to the requested range.
    private cachedInlayHints(uri: string, range: Range): InlayHint[] {
        return (this.last_inlay_hints.get(uri) ?? [])
            .filter(h => ConnectionEventHandler.withinRange(h, range));
    }

    // Start-inclusive, end-exclusive, the same convention the analyser
    // filters ranges by.
    private static withinRange(hint: InlayHint, range: Range): boolean {
        return (hint.position.line > range.start.line
                || (hint.position.line == range.start.line
                    && hint.position.character >= range.start.character))
            && (hint.position.line < range.end.line
                || (hint.position.line == range.end.line
                    && hint.position.character < range.end.character));
    }

    onDidCloseTextDocument(params: DidCloseTextDocumentParams) {
        this.last_inlay_hints.delete(params.textDocument.uri);
    }

    onDocumentRangeFormatting(params: DocumentRangeFormattingParams): Promise<TextEdit[]> {
        const workspace = this.workspaceForUri(params.textDocument.uri);

        if (!workspace) {
            return Promise.resolve([]);
        }

        let document = this.documents.get(params.textDocument.uri);

        if (!document) {
            return Promise.resolve([]);
        }

        // The analyser snaps the requested range out to whole enclosing
        // definitions/statements and replies with the exact span it formatted.
        return workspace.requester.sendDocumentRangeFormatting(
            params.textDocument.uri,
            document.getText(),
            params.range
        );
    }
}
