import { pathToFileURL } from 'url';

import { existsSync } from 'fs';

import {
    Connection,
    Disposable,
    DidChangeWatchedFilesNotification,
    TextDocuments
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { log } from './log';

import { ConfigEventEmitter } from './config-event-emitter';
import { ServerEventEmitter } from './server-event-emitter';
import { ResponseHandler } from './response-handler';
import { Requester } from './requester';
import { EditQueue } from './edit-queue';
import { ResponseParser } from './response-parser';
import { ServerManager } from './server-manager';
import { DocumentChangeTracker, rootedGlob } from './document-change-tracker';
import { GhulAnalyser } from './ghul-analyser';
import { Watchdog } from './watchdog';
import { Activity, ActivityProgress, ROUTINE_ANALYSIS_MESSAGE, SLOW_ACTIVITY_DELAY_MS } from './activity-progress';
import { MetricsReporter } from './metrics-reporter';

import { EditorSettings, getGhulConfig, GhulConfig } from './ghul-config';
import { restoreDotNetTools } from './restore-dotnet-tools';
import { generateAssembliesJson } from './generate-assemblies-json';
import { generateGhulOptionsJson } from './generate-ghul-options-json';
import { generateResponseFile } from './generate-response-file';
import { generateManifestResponseFile, isManifestProject, manifestCompiler } from './manifest-project';
import { TempDirectory } from './temp-directory';

// How long to wait for the client to answer for its settings before falling
// back to the project's own configuration. Setup cannot proceed without an
// answer, so an unbounded wait is a workspace that never gets a compiler.
const CONFIGURATION_TIMEOUT_MS = 5_000;

// A setting the user has expressed no preference on comes back as null, and a
// client that does not know the setting at all comes back with undefined — both
// mean "unset". Anything that is not a boolean is treated the same way rather
// than coerced, so a mistyped setting falls back rather than silently reading
// as true.
function asOptionalBoolean(value: unknown): boolean | null {
    return typeof value == 'boolean' ? value : null;
}

// Bounds only the status bar, not correctness: whenAnalysed already holds
// queries safely no matter how long the first compile takes. This only stops
// the progress notification from spinning forever if the compiler never
// spawns or never completes a first compile at all.
const FIRST_COMPILE_PROGRESS_TIMEOUT_MS = 300_000;

// All compiler-facing state for a single workspace folder: one compiler child,
// its watchdog, its edit queue and the response handler that fans replies back
// out to LSP. Multiple instances can coexist in the same extension host so the
// server can later host one .ghulproj per workspace folder; ExtensionState owns
// the registry and routes per-URI requests to the right context.
export class WorkspaceContext {
    workspace_root: string;
    config: GhulConfig;

    server_event_emitter: ServerEventEmitter;
    config_event_emitter: ConfigEventEmitter;

    response_handler: ResponseHandler;
    requester: Requester;
    edit_queue: EditQueue;
    response_parser: ResponseParser;
    server_manager: ServerManager;
    document_change_tracker: DocumentChangeTracker;
    ghul_analyser: GhulAnalyser;
    watchdog: Watchdog;
    progress: ActivityProgress;
    metrics: MetricsReporter;

    private connection: Connection;
    private documents: TextDocuments<TextDocument>;

    private temp_directory: TempDirectory;

    // Set by ExtensionState from the client's declared capabilities. See the
    // note there: a client that has not declared this never answers the
    // request, so asking one that has not would stall setup outright.
    client_supports_configuration: boolean = false;

    private missing_assembly_watch: Promise<Disposable> | null = null;

    // Directories under this workspace that belong to some other root, as
    // globs relative to it, left out of its own sources. Set by the registry
    // from the roots it knows of.
    boundary_excludes: string[] = [];

    // Whether setup has been asked for. A project discovered under an open
    // folder is registered when a file in it is first opened, so most of what
    // a large tree holds never starts a compiler.
    started: boolean = false;

    private initialize_running: Promise<void> | null = null;
    private initialize_queued: Promise<void> | null = null;

    // Counts compiler starts, so the wait for one compiler's first compile
    // cannot close the progress belonging to the compiler that replaced it.
    private compiler_generation: number = 0;

    // Whether a compiler start is currently being reported. A compiler that
    // was never resolved never starts, and must not have its later lifecycle
    // events reopen a notification nothing will close.
    private reporting_compiler_startup: boolean = false;

    constructor(
        workspace_root: string,
        connection: Connection,
        documents: TextDocuments<TextDocument>
    ) {
        this.workspace_root = workspace_root;
        this.connection = connection;
        this.documents = documents;

        this.temp_directory = new TempDirectory();

        this.server_event_emitter = new ServerEventEmitter();
        this.config_event_emitter = new ConfigEventEmitter();

        this.progress = new ActivityProgress(connection);
        this.metrics = new MetricsReporter(connection, workspace_root);

        this.response_handler = new ResponseHandler(connection, this.config_event_emitter);

        // Created before the requester/edit_queue so they can be handed a live
        // watchdog reference; the on_timeout callback closes over `this` and
        // forwards to the server manager once it's constructed below.
        this.watchdog = new Watchdog(
            10000,
            () => this.server_manager.recoverFromHang(),
            busy => this.reportOutstandingRequest(busy)
        );

        // Same late-bound shape as the watchdog callback above: the requester
        // is built before the server manager, and only ever calls this once
        // a request is actually in hand.
        this.requester = new Requester(
            this.server_event_emitter,
            this.response_handler,
            this.watchdog,
            () => this.server_manager?.ensureRunning()
        );

        // Late-bound like the ensure_running hook above: the queue is built
        // after the requester. Queries hold on it only while the analyser
        // cannot answer mid-compile.
        this.requester.wait_for_quiet = () => this.edit_queue?.whenNotCompiling() ?? Promise.resolve();
        this.requester.quiet_now = () => this.edit_queue?.isCompiling() !== true;

        this.edit_queue = new EditQueue(
            this.requester,
            this.response_handler,
            this.watchdog,
            this.progress,
            this.metrics
        );

        this.ghul_analyser = new GhulAnalyser(
            this.edit_queue,
            this.config_event_emitter,
            this.server_event_emitter,
            documents
        );

        this.response_parser = new ResponseParser(this.response_handler, this.watchdog);

        this.server_manager = new ServerManager(
            this.config_event_emitter,
            this.server_event_emitter,
            this.edit_queue,
            this.response_handler,
            this.response_parser,
            this.watchdog,
            workspace_root,
            // Lazily, so constructing a context - which happens for every
            // folder a multi-root workspace holds, ghūl project or not - does
            // not make a directory the folder may never have a use for.
            () => this.analysisResponseFilePath(),
            connection
        );

        this.response_handler.setServerManager(this.server_manager);
        this.response_handler.setEditQueue(this.edit_queue);

        this.reportCompilerStartup();
    }

    // A request has gone to the compiler and no answer has come back yet.
    //
    // Worth saying something about because the analyser recompiles on demand
    // to answer a query it has no current state for, and nothing in the
    // protocol says in advance that it is about to — so an ordinary hover can
    // become a multi-second wait that otherwise looks like the editor
    // ignoring the user. Delayed, because most requests answer far too
    // quickly to be worth a spinner, and marked as a fallback so a request
    // made while something with an explanation of its own is running (the
    // heap check, a referenced-project build) leaves that explanation up
    // rather than replacing it with the routine phrase on recency alone.
    private reportOutstandingRequest(busy: boolean) {
        if (busy) {
            this.progress.report(Activity.Request, ROUTINE_ANALYSIS_MESSAGE, {
                delay_ms: SLOW_ACTIVITY_DELAY_MS,
                fallback: true
            });
        } else {
            this.progress.end(Activity.Request);
        }
    }

    // The compiler is not only started once. It is recycled when it has
    // accumulated too much memory, and relaunched when it crashes or the
    // watchdog finds it wedged — and each time it comes back with no project
    // state, so the user is back to waiting through a cold analysis with the
    // editor answering nothing. Reporting off the compiler's own lifecycle
    // events rather than from initialize() means that wait is shown every
    // time it happens, not only on the first one.
    //
    // The setup steps initialize() reports before this — the tool restore, the
    // reference resolution — are not repeated on a relaunch, so a relaunch
    // shows the part of the sequence that is actually running.
    private reportCompilerStartup() {
        this.server_event_emitter.onStarting(() => {
            // A compiler that was never resolved, or one deliberately blocked,
            // is not coming: the spawn is abandoned immediately after this
            // event and nothing would ever close the progress.
            if (!this.config?.compiler?.length || this.config.block) {
                return;
            }

            this.reporting_compiler_startup = true;

            // "analyser", not "compiler": the process is the compiler, but
            // what it does for the editor is hold the project analysed and
            // answer questions about it. Naming the process would read as the
            // extension shelling out to a build for every request.
            this.progress.report(Activity.Compiler, "starting analyser");

            this.awaitFirstAnalysis(++this.compiler_generation);
        });

        this.server_event_emitter.onListening(() => {
            if (this.reporting_compiler_startup) {
                this.progress.report(Activity.Compiler, "analysing project", { done_message: "project analysed" });
            }
        });
    }

    // Hold the compiler's progress open until it has analysed the project
    // once — the point at which the editor starts answering — rather than
    // ending it when the process spawns, which is the part the user cannot
    // see and does not care about.
    //
    // Bounded so a compiler that never completes a compile cannot leave the
    // status bar spinning forever. This bound is deliberately much longer than
    // whenAnalysed's own per-query ANALYSED_WAIT_TIMEOUT_MS (requester.ts):
    // giving up on an individual query early is the safe choice (the client
    // just asks again later), but ending the status bar early would say
    // "ready" while the analyser is still on its first compile, which is worse
    // than leaving it open a while longer.
    private awaitFirstAnalysis(generation: number) {
        const timeout = new Promise<void>(resolve => {
            setTimeout(resolve, FIRST_COMPILE_PROGRESS_TIMEOUT_MS).unref?.();
        });

        Promise.race([this.requester.untilFirstAnalysed(), timeout])
            .then(() => {
                // A later compiler has started since; its own wait owns the
                // progress now.
                if (this.compiler_generation != generation) {
                    return;
                }

                this.reporting_compiler_startup = false;

                this.progress.end(Activity.Compiler);
            })
            .catch(e => log(`could not finish reporting progress: ${e}`));
    }

    // Run the per-workspace setup that depends on the on-disk project layout:
    // restore the local tool manifest, regenerate .assemblies.json, parse
    // ghul.json/.ghulproj. Fires configAvailable, which is what wakes the
    // server manager and starts the compiler child.
    //
    // Runs off the initialize response, not inside it. The tool restore alone
    // can take tens of seconds on a machine that has never seen the compiler,
    // and until the response is sent the client holds back every notification
    // it has for us — so a caller that waits for this leaves the editor with
    // no language support at all and no way to say why.
    initialize(): Promise<void> {
        // Setup restores tools, rewrites .assemblies.json and replaces the
        // compiler, none of which survives two runs interleaving. A caller
        // arriving while a run is in flight waits for it and then gets one
        // further run — one however many callers arrive, since they all want
        // the same thing: the tree as it stands once the current run is done.
        if (!this.initialize_running) {
            return this.beginInitialize();
        }

        return this.initialize_queued ??= this.initialize_running
            // A failed run must still let the queue drain, or the workspace
            // is left with no way to pick up a later change.
            .catch(() => { /* reported by whoever asked for that run */ })
            .then(() => {
                this.initialize_queued = null;

                return this.beginInitialize();
            });
    }

    // The in-flight slot is held until nothing is queued behind it, so a
    // caller arriving in the gap between one run finishing and the queued one
    // starting joins the queue rather than starting a run alongside it.
    private beginInitialize(): Promise<void> {
        return this.initialize_running = this.runInitialize()
            .finally(() => {
                if (!this.initialize_queued) {
                    this.initialize_running = null;
                }
            });
    }

    private async runInitialize(): Promise<void> {
        let problems: string[] = [];

        // The response file is written first; getGhulConfig reads it to build
        // the analyser's -a flags. Must run in this order — on a fresh
        // checkout there is no such file yet, so a reversed order leaves the
        // analyser with no -a flags and it falls back to a five-assembly
        // default.
        let response_file: string | null = this.responseFilePath();
        let source_globs_file = this.temp_directory.path('source-globs.txt');

        // A ghul-project.json project is resolved by the ghul tool, which
        // writes the same two files a .ghulproj build does and names the
        // compiler, so none of the .NET steps apply to it.
        let manifest_compiler: string[] | null | undefined = undefined;

        // What ghul said was wrong with the manifest. It is why there is no
        // compiler to start, so it travels with the configuration for the
        // server manager to report in place of a generic complaint.
        let manifest_problems: string[] = [];

        if (isManifestProject(this.workspace_root)) {
            this.progress.report(Activity.Setup, "resolving compiler options", { done_message: "compiler options resolved" });

            let manifest_problem = await generateManifestResponseFile(this.workspace_root, response_file, source_globs_file);
            if (manifest_problem) {
                manifest_problems.push(manifest_problem);
                response_file = null;
            }

            let found = manifestCompiler(this.workspace_root);

            // A manifest ghul could not read fails both requests the same
            // way, so the second report would only repeat the first.
            if (found.problem && !manifest_problem) {
                manifest_problems.push(found.problem);
            }

            manifest_compiler = found.compiler ?? null;
        } else {
            response_file = await this.resolveGhulprojOptions(problems, response_file, source_globs_file);
        }

        let settings = await this.readEditorSettings();

        this.config = manifest_compiler === undefined
            ? getGhulConfig(this.workspace_root, settings, response_file, source_globs_file)
            : getGhulConfig(this.workspace_root, settings, response_file, source_globs_file, manifest_compiler);

        if (manifest_problems.length) {
            this.config.problems = [...manifest_problems, ...(this.config.problems ?? [])];
        }

        // A nested project's files belong to that project, not to this one.
        if (this.boundary_excludes.length) {
            this.config.exclude = [...(this.config.exclude ?? []), ...this.boundary_excludes];
        }

        problems.push(...(this.config.problems ?? []));

        // The step above builds the referenced projects, so anything still
        // absent here is a build that failed rather than one that has not been
        // run yet. Nothing is going to produce it without the user acting, so
        // say so — and leave the diagnostics of the incomplete reference set
        // to be published, incomplete as they are, since nothing is coming
        // along to replace them.
        if (this.config.missing_assemblies.length) {
            problems.push(
                `could not build ${this.config.missing_assemblies.length} referenced ` +
                `assembly/assemblies; analysis will be incomplete until they are built`
            );
        }

        // A degraded-but-runnable load: warn so the user knows analysis may be
        // incomplete. A load with no usable compiler is fatal and reported as
        // an error by the server manager when it declines to spawn.
        if (problems.length && this.config.compiler?.length) {
            this.connection.window?.showWarningMessage(
                "ghūl language extension: " + problems.join("; ")
            );
        }

        // Whatever the outgoing tracker had pending is answered by this run,
        // which has just re-read everything it would have re-read.
        this.document_change_tracker?.dispose();

        this.document_change_tracker = new DocumentChangeTracker(
            this,
            this.edit_queue,
            this.config.source.map(glob => rootedGlob(this.workspace_root, glob)),
            this.documents,
            this.config.missing_assemblies,
            (this.config.exclude ?? []).map(glob => rootedGlob(this.workspace_root, glob))
        );

        this.watchMissingAssemblies();

        // Starts the compiler, which reports its own progress from here on
        // (see reportCompilerStartup) — so the setup activity ends into the
        // compiler's rather than into a gap.
        this.config_event_emitter.configAvailable(this.workspace_root, this.config);

        this.progress.end(Activity.Setup);
    }

    // A .ghulproj project: restore the .NET tools, then have the build write
    // the response file and source globs. Answers the response file to read,
    // or null when the build wrote none.
    private async resolveGhulprojOptions(problems: string[], response_file: string, source_globs_file: string): Promise<string | null> {
        this.progress.report(Activity.Setup, "restoring .NET tools");

        let tools_problem = await restoreDotNetTools(this.workspace_root);
        if (tools_problem) {
            problems.push(tools_problem);
        }

        this.progress.report(Activity.Setup, "building project references", { done_message: "project references built" });

        let response_file_problem = await generateResponseFile(this.workspace_root, response_file, source_globs_file);
        let written: string | null = response_file;

        if (!existsSync(response_file)) {
            // Most often this means the project is pinned to a ghul.runtime
            // older than 14.3.0, which has no GenerateGhulResponseFile target
            // — ordinary rather than broken, and the overwhelmingly common
            // case, so it must not warn. Nothing here can tell that apart
            // from the target failing on a project that does have it, so the
            // fallback runs either way and reports for itself. Anything
            // generateResponseFile complained about is in the log whichever
            // it was, so a failure that the fallback then papers over is
            // still there to be found.
            written = null;

            let assemblies_problem = await generateAssembliesJson(this.workspace_root);
            if (assemblies_problem) {
                problems.push(assemblies_problem);
            }

            // Best-effort and never contributes a problem — a project on a
            // runtime older still has no GenerateGhulOptionsJson target
            // either, and getGhulConfig falls back to hand-parsing the
            // .ghulproj.
            await generateGhulOptionsJson(this.workspace_root);
        } else if (response_file_problem) {
            problems.push(response_file_problem);
        }

        return written;
    }

    // The editor's settings for this folder, with its User / Workspace /
    // Workspace Folder layers already resolved — the client does the layering,
    // which is the whole reason for asking it rather than reading a file.
    //
    // scopeUri is what makes a per-folder override work: without it a
    // multi-root workspace would get one answer for every folder.
    //
    // Never a reason for setup to fail. A client that does not support the
    // request, or answers it badly, leaves every setting unexpressed and the
    // project's own ghul.json decides.
    private async readEditorSettings(): Promise<EditorSettings> {
        if (!this.client_supports_configuration || !this.connection?.workspace?.getConfiguration) {
            return {};
        }

        const scopeUri = pathToFileURL(this.workspace_root).toString();

        try {
            // Bounded even though the capability was declared: setup must not
            // be able to stop here, and a client that declares the capability
            // and then does not answer would otherwise leave the workspace
            // with no compiler at all and nothing said about why.
            const answered = await Promise.race([
                this.connection.workspace.getConfiguration([
                    { scopeUri, section: 'ghul.incrementalAnalysis' },
                    { scopeUri, section: 'ghul.plaintextHover' },
                    { scopeUri, section: 'ghul.inlayHints.narrowing' },
                    { scopeUri, section: 'ghul.inlayHints.definitionVirtuality' },
                    { scopeUri, section: 'ghul.inlayHints.terminators' },
                ]),
                new Promise<null>(resolve => {
                    setTimeout(() => resolve(null), CONFIGURATION_TIMEOUT_MS).unref?.();
                }),
            ]);

            if (!answered) {
                log("the client did not answer for its settings; using the project's own configuration");

                return {};
            }

            const [
                incremental_analysis,
                want_plaintext_hover,
                inlay_narrowing,
                inlay_definition_virtuality,
                inlay_terminators,
            ] = answered;

            return {
                incremental_analysis: asOptionalBoolean(incremental_analysis),
                want_plaintext_hover: asOptionalBoolean(want_plaintext_hover),
                inlay_narrowing: asOptionalBoolean(inlay_narrowing),
                inlay_definition_virtuality: asOptionalBoolean(inlay_definition_virtuality),
                inlay_terminators: asOptionalBoolean(inlay_terminators),
            };
        } catch (e) {
            log(`could not read editor settings: ${e}`);

            return {};
        }
    }

    reinitialize() {
        this.initializeDetached();
    }

    // initialize() for callers that cannot wait for it and have nowhere to put
    // a failure. Setup already collects its own problems and surfaces them to
    // the user; anything reaching here is unforeseen, and must not surface as
    // an unhandled rejection that takes the server down with it.
    initializeDetached() {
        this.started = true;

        this.initialize().catch(e => log(`workspace initialization failed: ${e}`));
    }

    // Backstop for an assembly the setup build failed to produce arriving by
    // some other route — the user fixing the referenced project and building it
    // from a terminal, a sibling tool, a git operation that restores it.
    // Watches exactly the paths that are absent, so once they are all present
    // nothing is registered and an ordinary rebuild during editing cannot
    // trigger anything.
    private watchMissingAssemblies() {
        this.stopWatchingMissingAssemblies();

        if (!this.config.missing_assemblies.length || !this.connection?.client?.register) {
            return;
        }

        this.missing_assembly_watch = this.connection.client.register(
            DidChangeWatchedFilesNotification.type,
            {
                watchers: this.config.missing_assemblies.map(
                    globPattern => ({ globPattern: globPattern.replace(/\\/g, '/') })
                ),
            }
        );
    }

    private stopWatchingMissingAssemblies() {
        this.missing_assembly_watch?.then(watch => watch.dispose());
        this.missing_assembly_watch = null;
    }

    // The set of file globs (already absolutised under workspace_root) that
    // belong to this workspace's project. Used by routing in ExtensionState to
    // decide which workspace owns a watched-file change.
    sourceGlobs(): string[] {
        return this.document_change_tracker?.globs ?? [];
    }

    // Whether this project's own sources include the file, which is what
    // decides that it belongs here rather than to whichever folder happens to
    // contain it. A project whose globs are not resolved yet, or whose
    // resolution failed, claims what sits under its folder as it always did:
    // an empty set of globs means the question cannot be answered, not that
    // the answer is no.
    claimsSourceFile(uri: string): boolean {
        if (this.sourceGlobs().length == 0) {
            return true;
        }

        return this.document_change_tracker?.tryGetValidSourceFile(uri) != null;
    }

    // Absolute path to the response file the build writes this workspace's
    // resolved options and references to.
    responseFilePath(): string {
        return this.temp_directory.path('project.rsp');
    }

    // Absolute path to the response file the analyser is launched with. Both
    // this and the build's live in a directory of this workspace's own, so two
    // editors opened on one project cannot overwrite each other's, and neither
    // is left behind in the checkout.
    analysisResponseFilePath(): string {
        return this.temp_directory.path('analysis.rsp');
    }

    // Everything this workspace owns outside its own process: the analyser,
    // and the generated files it was launched from.
    dispose() {
        this.server_manager?.kill();
        this.document_change_tracker?.dispose();
        this.stopWatchingMissingAssemblies();
        this.temp_directory.dispose();
    }
}
