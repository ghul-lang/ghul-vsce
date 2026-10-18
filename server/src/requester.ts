import {
    CompletionItem,
    Definition,
    Hover,
    SemanticTokens,
    InlayHint,
    SignatureHelp,
    SymbolInformation,
    Location,
    WorkspaceEdit,
    TextEdit,
    Range,
    CancellationToken
} from 'vscode-languageserver';

import { log } from './log';

import { ChildProcess } from 'child_process';

import { normalizeFileUri } from './normalize-file-uri';

import { ServerEventEmitter } from './server-event-emitter';

import { DiagnosticDto, ResponseHandler } from './response-handler';
import { EditDelta } from './edit-delta';
import { Watchdog } from './watchdog';

const version = require('./version') as string;

// Long enough to cover a cold start on a machine that has to fetch and JIT the
// compiler first, short enough that a query against a compiler which will
// never answer does not hang indefinitely.
const ANALYSED_WAIT_TIMEOUT_MS = 60000;

export class Requester {
    // True once the compiler has analysed the project at least once since it
    // (re)started. Queries sent before that would reach an analyser with no
    // source files registered: it can't answer them usefully, and the
    // query-driven recompile of an empty project corrupts its reflected-type
    // state. Every query sender below goes through whenAnalysed, which holds
    // the query until this turns true. The edit queue sets it when a compile
    // round-trip completes.
    get analysed(): boolean {
        return this._analysed;
    }

    set analysed(value: boolean) {
        this._analysed = value;

        if (value) {
            this.releaseAnalysedWaiters();
        }
    }

    // Every assembly added to the reference set, so that a fresh analyser -
    // after a crash, a recycle or an idle exit - can be given them again. It
    // starts from the workspace's own references and would otherwise lose them.
    private added_references: string[] = [];

    private _analysed: boolean;
    private analysed_waiters: (() => void)[] = [];

    stream: any;

    response_handler: ResponseHandler;
    watchdog: Watchdog;

    // Wakes a compiler that exited while idle. Every send calls it; it does
    // nothing unless the compiler is actually away.
    ensure_running: () => void;

    watchdog_timer: NodeJS.Timer;

    constructor(
        server_event_emitter: ServerEventEmitter,
        response_handler: ResponseHandler,
        watchdog: Watchdog,
        ensure_running: () => void = () => {}
    ) {
        this.response_handler = response_handler;
        this.watchdog = watchdog;
        this.ensure_running = ensure_running;
        this.analysed = false;

        server_event_emitter.onStarting(() => {
            // A fresh compiler child starts with no project state; hold
            // queries until its first compile completes.
            this.analysed = false;
        });

        server_event_emitter.onRunning((child: ChildProcess) => {
            log(`ghūl language extension v${version}: initialized`);
            this.stream = child.stdin;
        });

        server_event_emitter.onListening(() => {
            if (this.added_references.length > 0 && this.response_handler.add_references_supported) {
                this.send({ kind: "add_references", paths: this.added_references });

                this.response_handler.expectAddReferences()
                    .then(message => { if (message) log(`could not add references again: ${message}`); })
                    .catch(reason => log(`adding references again failed: ${reason}`));
            }
        });
    }

    // Hold a query that arrived before the analyser could answer it until it
    // can, rather than answering it with nothing. An empty answer is
    // indistinguishable from a real one: the client caches it and does not ask
    // again until the document changes, so a hover tried once during start-up
    // stays blank long after the analyser is ready, and reads as a feature
    // that does not work.
    //
    // Bounded, because the analyser might never arrive — a compiler that
    // cannot start, or one the watchdog is still recovering. Falling back to
    // the empty answer then is no worse than giving it immediately.
    private whenAnalysed<T>(
        send: () => Promise<T>,
        fallback: T = null,
        token?: CancellationToken
    ): Promise<T> {
        // A query is exactly the "something to ask" an idle exit was waiting
        // for. Waking here rather than on a timer is the point of the idle
        // exit: the relaunch is paid for by a request that wants an answer.
        // The wait below then covers the cold start, as it already does for a
        // compiler that is starting for any other reason.
        this.ensure_running();

        if (this.analysed) {
            this.watchdog.startWatchdogIfNotRunning();

            return send();
        }

        return new Promise<T>(resolve => {
            const drop = () => {
                this.analysed_waiters = this.analysed_waiters.filter(w => w !== waiter);

                clearTimeout(timer);
            };

            const timer = setTimeout(() => {
                drop();

                log("query timed out waiting for the analyser to become ready");

                resolve(fallback);
            }, ANALYSED_WAIT_TIMEOUT_MS);

            // The client withdraws a query as soon as it stops wanting the
            // answer — a hover the pointer has moved off, a completion the
            // user dismissed. Sending it when the analyser eventually comes up
            // would spend a round trip on an answer nobody reads, and every
            // such query released at once lands exactly when the analyser is
            // busiest with its first compile.
            token?.onCancellationRequested(() => {
                drop();

                resolve(fallback);
            });

            const waiter = () => {
                clearTimeout(timer);

                this.watchdog.startWatchdogIfNotRunning();

                resolve(send());
            };

            this.analysed_waiters.push(waiter);
        });
    }

    // Resolves once the analyser completes its first compile since this
    // requester was created — immediately, if that has already happened.
    // Distinct from whenAnalysed: this holds no query and sends nothing of
    // its own, so it has no fallback and no timeout of its own — it exists so
    // start-up progress reporting can stay open through the analyser's first
    // compile rather than ending the moment it spawns; the caller bounds it.
    untilFirstAnalysed(): Promise<void> {
        if (this.analysed) {
            return Promise.resolve();
        }

        return new Promise(resolve => this.analysed_waiters.push(resolve));
    }

    // Release everything waiting on the analyser. Called when the first
    // compile lands; the send and the matching expect stay adjacent within
    // each waiter, so the response handler's queues keep their pairing.
    private releaseAnalysedWaiters() {
        const waiters = this.analysed_waiters;

        this.analysed_waiters = [];

        for (const waiter of waiters) {
            waiter();
        }
    }

    write(text: String) {
        try {
            this.stream.write(text);
        } catch(ex) {
            log("caught exception trying to send request data: compiler may have died:" + ex);
            this.response_handler.rejectAllAndThrow(ex);
        }
    }

    // Serialize one request object to a single JSONL line (newline-terminated).
    // JSON escapes any embedded newlines, so one line is always one message.
    // The request is tagged under `kind`; analysers before 66.0.0 read the
    // tag from `command` instead, so it is written under both, and each
    // analyser ignores the field it does not read.
    send(request: { kind: string, [field: string]: unknown }) {
        this.write(JSON.stringify({ ...request, command: request.kind }) + '\n');
    }

    sendDocuments(documents: { uri: string, source: string }[]) {
        // Editing is the other way work arrives. A relaunch re-primes the
        // analyser with the open documents on its own, so the wake matters
        // here even though this particular edit may land on a stream that is
        // already gone.
        this.ensure_running();

        this.watchdog.startWatchdogIfNotRunning();

        this.send({
            kind: "edit",
            files: documents.map(({ uri, source }) => ({
                path: normalizeFileUri(uri),
                source: source
            }))
        });
    }

    sendEditDeltas(deltas: EditDelta[]) {
        this.ensure_running();

        this.watchdog.startWatchdogIfNotRunning();

        this.send({
            kind: "edit_delta",
            files: deltas
        });
    }

    // Declare the client's currently-open files. Fire-and-forget: the analyser
    // records the set and only produces editor-only hints (invisible for a file
    // the user is not viewing) for these paths. There is no response frame, so
    // this must not arm the watchdog. Dropped silently before the child is
    // running — the cold-start analyse re-sends the set once it is.
    sendOpenFiles(uris: string[]) {
        if (!this.stream) {
            return;
        }

        this.send({
            kind: "set_open_files",
            paths: uris.map(uri => normalizeFileUri(uri))
        });
    }

    // Quick fixes for the diagnostics of one file overlapping one range.
    // Gated on the compiler advertising "code-actions": an analyser that
    // does not know the command would leave the request unanswered and
    // wedge the queue until the watchdog killed it, so an older compiler
    // means no quick fixes rather than a hang.
    sendCodeActions(uri: string, range: Range, token?: CancellationToken): Promise<DiagnosticDto[]> {
        if (!this.response_handler.code_actions_supported) {
            return Promise.resolve([]);
        }

        return this.whenAnalysed(() => {
            this.send({
                kind: "code_actions",
                path: normalizeFileUri(uri),
                start_line: range.start.line + 1,
                start_column: range.start.character + 1,
                end_line: range.end.line + 1,
                end_column: range.end.character + 1
            });

            return this.response_handler.expectCodeActions();
        }, [], token);
    }

    sendHover(uri: string, line: number, character: number, token?: CancellationToken): Promise<Hover> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "hover",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectHover();
        }, null, token);
    }

    sendDefinition(uri: string, line: number, character: number, token?: CancellationToken): Promise<Definition> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "definition",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectDefinition();
        }, null, token);
    }

    sendDeclaration(uri: string, line: number, character: number, token?: CancellationToken): Promise<Definition> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "declaration",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectDeclaration();
        }, null, token);
    }

    // is_member_trigger says the user typed a `.`, so the only useful answer
    // is the members of what precedes it. An analyser that finds no member
    // access there is holding text older than the editor's and says nothing,
    // rather than falling back to the enclosing scope. Older analysers ignore
    // the field and answer as they always did.
    sendCompletion(
        uri: string,
        line: number,
        character: number,
        is_member_trigger: boolean = false,
        token?: CancellationToken
    ): Promise<CompletionItem[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "complete",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1,
                is_member_trigger: is_member_trigger
            });

            return this.response_handler.expectCompletion();
        }, null, token);
    }

    sendSignature(uri: string, line: number, character: number, token?: CancellationToken): Promise<SignatureHelp> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "signature",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectSignature();
        }, null, token);
    }

    sendDocumentSymbol(uri: string, token?: CancellationToken): Promise<SymbolInformation[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "symbols",
                path: normalizeFileUri(uri)
            });

            return this.response_handler.expectSymbols();
        }, null, token);
    }

    sendWorkspaceSymbol(token?: CancellationToken): Promise<SymbolInformation[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "symbols",
                path: ""
            });

            return this.response_handler.expectSymbols();
        }, null, token);
    }

    sendReferences(uri: string, line: number, character: number, token?: CancellationToken): Promise<Location[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "references",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectReferences();
        }, null, token);
    }

    sendImplementation(uri: string, line: number, character: number, token?: CancellationToken): Promise<Location[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "implementation",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectImplementation();
        }, null, token);
    }

    sendTypeDefinition(uri: string, line: number, character: number, token?: CancellationToken): Promise<Definition> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "type_definition",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1
            });

            return this.response_handler.expectTypeDefinition();
        }, null, token);
    }

    sendRenameRequest(uri: string, line: number, character: number, newName: string): Promise<WorkspaceEdit> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "rename",
                path: normalizeFileUri(uri),
                line: line + 1,
                column: character + 1,
                new_name: newName
            });

            return this.response_handler.expectRenameRequest();
        });
    }

    sendSemanticTokens(uri: string, token?: CancellationToken): Promise<SemanticTokens> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "semantic_tokens",
                path: normalizeFileUri(uri)
            });

            return this.response_handler.expectSemanticTokens();
        }, null, token);
    }

    sendInlayHints(uri: string, range: Range, token?: CancellationToken): Promise<InlayHint[]> {
        return this.whenAnalysed(() => {
            // The analyser filters the answer to the range — the editor's
            // viewport — so a kind with a hint on nearly every line does not
            // pay transport and parsing for a whole file. 1-based, end
            // position exclusive, matching every other range on the wire.
            let request: any = {
                kind: "inlay_hints",
                path: normalizeFileUri(uri)
            };

            if (this.response_handler.inlay_hint_ranges_supported) {
                request = {
                    ...request,
                    start_line: range.start.line + 1,
                    start_column: range.start.character + 1,
                    end_line: range.end.line + 1,
                    end_column: range.end.character + 1,
                };
            }

            this.send(request);

            return this.response_handler.expectInlayHints();
        }, [], token);
    }

    sendDocumentFormatting(uri: string, source: string, range: Range): Promise<TextEdit[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "format",
                path: normalizeFileUri(uri),
                source: source
            });

            return this.response_handler.expectDocumentFormatting(range);
        });
    }

    sendDocumentRangeFormatting(uri: string, source: string, range: Range): Promise<TextEdit[]> {
        return this.whenAnalysed(() => {
            this.send({
                kind: "format_range",
                path: normalizeFileUri(uri),
                start_line: range.start.line + 1,
                start_column: range.start.character + 1,
                end_line: range.end.line + 1,
                end_column: range.end.character + 1,
                source: source
            });

            return this.response_handler.expectDocumentRangeFormatting();
        });
    }

    sendFullCompileRequest() {
        this.watchdog.startWatchdogIfNotRunning();

        this.send({ kind: "compile" });
    }

    // Ask the analyser to sample the heap. The EditQueue sends this during a
    // lull in editing, so the watchdog's forced GC stays off the latency path
    // of interactive requests.
    sendHeapCheckRequest() {
        this.watchdog.startWatchdogIfNotRunning();

        this.send({ kind: "heap_check" });
    }

    // Ask the analyser for its work counters. Cheap — it walks a map and
    // writes what it finds — and nothing waits on the answer, so this is sent
    // after a compile has already completed rather than on the latency path of
    // one. Deliberately does not start the watchdog: a request this trivial
    // going unanswered says nothing about the analyser's health that the
    // compile before it has not already said.
    // Adds assemblies, by path, to the analyser's reference set: the earlier
    // cells of an interactive session, which exist only once the session has
    // compiled them. Answers why they could not be added, or null. The next
    // build after an addition is a whole-project rebuild.
    sendAddReferences(paths: string[]): Promise<string | null> {
        if (!this.response_handler.add_references_supported) {
            return Promise.resolve("the analyser cannot add references");
        }

        return this.whenAnalysed(() => {
            this.send({ kind: "add_references", paths });

            return this.response_handler.expectAddReferences().then(message => {
                if (message == null) {
                    for (const path of paths) {
                        if (!this.added_references.includes(path)) {
                            this.added_references.push(path);
                        }
                    }
                }

                return message;
            });
        }, "the analyser did not become ready");
    }

    sendStatsRequest() {
        this.send({ kind: "stats" });
    }

    sendRestart() {
        if (this.analysed) {
            this.watchdog.startWatchdogIfNotRunning();

            this.send({ kind: "restart" });
        }
    }
}
