import {
    Connection,
    TextDocuments,
    DidChangeWatchedFilesParams
} from 'vscode-languageserver';

import {
    createConnection
} from 'vscode-languageserver/node'

import { TextDocument } from 'vscode-languageserver-textdocument';

import { URI } from 'vscode-uri';

import { ConnectionEventHandler } from './connection-event-handler';

import { WorkspaceContext } from './workspace-context';

import { trace } from './request-trace';

import { AnalyserPool } from './analyser-pool';

import { normalizeFileUri } from './normalize-file-uri';

import { boundaryExcludes, discoverRoots, DiscoveredRoots } from './project-roots';

import { log } from './log';

// What a request or notification is for, which decides whether it may start an
// analyser. An interactive use is the user asking for something and starts the
// project's analyser; a passive one is the editor refreshing a view, and starts
// it only for a visible document, so restoring many tabs does not start many
// analysers; a watch is a file event and starts nothing.
export enum Use {
    WATCH,
    PASSIVE,
    INTERACTIVE
}

// Top-level host. Owns the single LSP Connection and the shared TextDocuments
// registry, plus a registry of WorkspaceContext instances. Per-workspace state
// (the compiler child, edit queue, watchdog, response handler) lives on the
// individual WorkspaceContext; this class only routes between them.
//
// Today there is exactly one workspace folder, registered by
// ConnectionEventHandler.onInitialize from params.rootPath. Multi-workspace
// support is wired from this side by reading params.workspaceFolders and
// registering one context per entry, then doing the same for
// workspace/didChangeWorkspaceFolders.
export class ExtensionState {
    private static instance: ExtensionState;

    public connection: Connection;

    public documents: TextDocuments<TextDocument>;

    public connection_event_handler: ConnectionEventHandler;

    // Keyed by workspace_root path. Insertion order matters: the first
    // registered workspace is the default for requests whose URI doesn't
    // belong to any folder.
    private workspaces: Map<string, WorkspaceContext> = new Map();

    // What each open folder holds: the projects and collections found under
    // it. Projects found are registered when a file in one is first opened;
    // collections are never analysed. The folder itself is a project only when
    // its own marker says so.
    private discovered: Map<string, DiscoveredRoots> = new Map();

    // Collections already announced, so the notice is given once each.
    private announced_collections: Set<string> = new Set();

    private rediscovery_timer: ReturnType<typeof setTimeout> | null = null;

    // Which projects' analysers run, and which to stop when too many would.
    private pool: AnalyserPool = new AnalyserPool(4);

    // The documents in visible editors, as the client last reported them, or
    // null for a client that never reports: then every open document counts as
    // visible.
    private visible: Set<string> | null = null;

    private over_cap_reported: boolean = false;

    // The event a document was just opened with, which the same document's
    // content-changed notification is about to repeat.
    private just_opened: object | null = null;

    private constructor() {
    }

    public static getInstance(): ExtensionState {
        if (!ExtensionState.instance) {
            ExtensionState.instance = new ExtensionState();
        }

        return ExtensionState.instance;
    }

    // Visible-for-tests reset. Drops registered workspaces so each test starts
    // from a clean slate; production code never calls this.
    public reset() {
        this.workspaces.clear();
        this.discovered.clear();
        this.announced_collections.clear();
        this.pool = new AnalyserPool(4);
        this.visible = null;
        this.over_cap_reported = false;

        if (this.rediscovery_timer) {
            clearTimeout(this.rediscovery_timer);
            this.rediscovery_timer = null;
        }
    }

    public connect() {
        this.connection = createConnection();
        this.documents = new TextDocuments(TextDocument);

        // Per-URI demux: route the change to the workspace that owns the file.
        // If no workspace owns it, drop the change — the file is outside every
        // registered .ghulproj source set.
        //
        // Opening a document also reports it as changed, with the very same
        // event, and that is not an edit: it must not start an analyser for a
        // tab that was only restored.
        this.documents.onDidChangeContent((change) => {
            const opening = change === this.just_opened;

            this.just_opened = null;

            trace(opening ? 'didOpenContent' : 'didChange', change.document.uri, this);

            const workspace = this.getWorkspaceForUri(change.document.uri, opening ? Use.PASSIVE : Use.INTERACTIVE);

            workspace?.edit_queue.queueEdit(change);
        });

        // Open-set membership changes only on open/close, not on every
        // keystroke — so track those events rather than content changes.
        this.documents.onDidOpen((e) => { this.just_opened = e; trace('didOpen', e.document.uri, this); this.broadcastOpenFiles(); });
        this.documents.onDidClose((e) => { trace('didClose', e.document.uri, this); this.broadcastOpenFiles(); });

        this.connection_event_handler = new ConnectionEventHandler(
            this,
            this.connection,
            this.documents
        );

        this.documents.listen(this.connection);
        this.connection.listen();
    }

    // Create a WorkspaceContext for the given root and store it in the
    // registry. Caller is responsible for invoking context.initialize();
    // ConnectionEventHandler.onInitialize does it straight away today.
    // Whether the client can answer workspace/configuration. Asking one that
    // cannot is not a degraded read — the request is simply never answered, and
    // any setup awaiting it stops there — so this gates the ask rather than
    // being a hint. Set from the client's declared capabilities before any
    // workspace initializes, and applied to folders added later too.
    private client_supports_configuration: boolean = false;

    public clientSupportsConfiguration(): boolean {
        return this.client_supports_configuration;
    }

    public setClientSupportsConfiguration(supported: boolean) {
        this.client_supports_configuration = supported;

        for (const context of this.allWorkspaces()) {
            context.client_supports_configuration = supported;
        }
    }

    // Whether the client will act on a request to re-fetch semantic tokens and
    // inlay hints. Both are answered from what the analyser held when the
    // request arrived, and the editor only re-asks when the document changes,
    // so without this the last answer of a typing burst is the one that stays
    // on screen even when it was computed against text the user has since
    // moved past.
    private client_supports_refresh: boolean = false;

    public setClientSupportsRefresh(supported: boolean) {
        this.client_supports_refresh = supported;

        for (const context of this.allWorkspaces()) {
            context.response_handler.client_supports_refresh = supported;
        }
    }

    public registerWorkspace(workspace_root: string): WorkspaceContext {
        const existing = this.workspaces.get(workspace_root);

        if (existing) {
            return existing;
        }

        const context = new WorkspaceContext(workspace_root, this.connection, this.documents);

        context.client_supports_configuration = this.client_supports_configuration;
        context.response_handler.client_supports_refresh = this.client_supports_refresh;

        this.workspaces.set(workspace_root, context);

        return context;
    }

    // Looks for the projects and collections under an open folder and returns
    // the folder's own workspace when the folder is itself a project: that one
    // is registered at once and the caller starts it, the way a single-folder
    // session always has. Every other project found is only recorded, and
    // starts when a file in it is first opened. A folder that is not itself a
    // project, whether it has no marker or is a workspace or a collection,
    // is never an analyser root.
    public addFolder(folder: string): WorkspaceContext | null {
        const found = discoverRoots(folder);

        this.discovered.set(folder, found);

        let own: WorkspaceContext | null = null;

        if (found.self === 'project') {
            own = this.registerWorkspace(folder);
        }

        log(
            `workspace folder ${folder}: ${found.self === 'none' ? 'no project of its own' : found.self}, ` +
            `${found.projects.length} project(s) and ${found.collections.length} collection(s) under it`
        );

        this.applyBoundaries();

        return own;
    }

    // Forgets an open folder, and stops what was started for it: its own
    // workspace and any project found under it that no other open folder holds.
    public removeFolder(folder: string) {
        this.discovered.delete(folder);
        this.unregisterWorkspace(folder);

        // What the remaining open folders still hold.
        const still_held = new Set<string>(this.discovered.keys());

        for (const found of this.discovered.values()) {
            found.projects.forEach(p => still_held.add(p));
        }

        for (const root of Array.from(this.workspaces.keys())) {
            if (this.isUnder(root, folder) && !still_held.has(root)) {
                this.unregisterWorkspace(root);
            }
        }

        this.applyBoundaries();
    }

    // Looks again for the projects and collections under every open folder,
    // after a manifest or project file appeared or went. Nothing already
    // started is stopped: a project whose marker went keeps its analyser until
    // the folder closes, and one that appeared starts when a file in it opens.
    public rediscover() {
        for (const folder of Array.from(this.discovered.keys())) {
            this.discovered.set(folder, discoverRoots(folder));
        }

        this.applyBoundaries();
    }

    private scheduleRediscovery() {
        if (this.rediscovery_timer) {
            clearTimeout(this.rediscovery_timer);
        }

        this.rediscovery_timer = setTimeout(() => {
            this.rediscovery_timer = null;
            this.rediscover();
        }, 250);

        this.rediscovery_timer.unref?.();
    }

    private isUnder(path: string, root: string): boolean {
        const p = path.replace(/\\/g, '/');
        const r = root.replace(/\\/g, '/');

        return p === r || p.startsWith(r + '/');
    }

    // Every directory something is rooted at: a started workspace, a project
    // found and not started yet, and a collection.
    private knownRoots(): Set<string> {
        const known = new Set<string>(this.workspaces.keys());

        for (const found of this.discovered.values()) {
            found.projects.forEach(p => known.add(p));
            found.collections.forEach(c => known.add(c));
        }

        return known;
    }

    private pendingProjects(): Set<string> {
        const pending = new Set<string>();

        for (const found of this.discovered.values()) {
            found.projects.forEach(p => {
                if (!this.workspaces.has(p)) {
                    pending.add(p);
                }
            });
        }

        return pending;
    }

    private collectionRoots(): Set<string> {
        const collections = new Set<string>();

        for (const found of this.discovered.values()) {
            found.collections.forEach(c => collections.add(c));
        }

        return collections;
    }

    // A root's sources stop at any other root nested inside it. Where a root's
    // exclusions change, the root is set up again to pick them up.
    private applyBoundaries() {
        const known = this.knownRoots();

        for (const context of this.workspaces.values()) {
            const others = Array.from(known).filter(root => root !== context.workspace_root);
            const excludes = boundaryExcludes(context.workspace_root, others);

            const changed =
                excludes.length !== context.boundary_excludes.length ||
                excludes.some((glob, i) => glob !== context.boundary_excludes[i]);

            context.boundary_excludes = excludes;

            if (changed && context.started) {
                context.reinitialize();
            }
        }
    }

    // Starts a project found under an open folder: registered, bounded, and
    // set up the way any other workspace is.
    private activate(root: string): WorkspaceContext {
        const context = this.registerWorkspace(root);

        this.applyBoundaries();
        context.initializeDetached();

        log(`pool: started ${root} (${this.workspaces.size} of ${this.pool.cap})`);

        // Documents opened while this project was not running reached nothing;
        // hand it their current text, which for a restored unsaved buffer is
        // not what is on disk.
        for (const document of this.documents?.all() ?? []) {
            if (this.isUnder(URI.parse(document.uri).fsPath, root) && context.claimsSourceFile(document.uri)) {
                context.edit_queue.queueEdit(Object.freeze({ document }));
            }
        }

        this.enforcePool(root);
        this.announcePool();

        return context;
    }

    // Stops analysers until no more run than the cap allows, leaving alone the
    // project just started and those with a visible editor.
    private enforcePool(keep?: string) {
        for (const root of this.pool.evictions(Array.from(this.workspaces.keys()), keep)) {
            const since = this.pool.idleSince(root);
            const idle = since === undefined ? 'never used interactively' : `idle ${Math.round((Date.now() - since) / 1000)}s`;

            log(`pool: evicted ${root}, ${idle}`);

            this.unregisterWorkspace(root);
        }

        const over = this.pool.overCap(Array.from(this.workspaces.keys()));

        if (over > 0 && !this.over_cap_reported) {
            this.over_cap_reported = true;

            log(`pool: ${over} more project(s) are visible than the cap of ${this.pool.cap}; they stay running`);
        } else if (over === 0) {
            this.over_cap_reported = false;
        }
    }

    // The most analysers to keep running. Lowered, it stops the surplus at once.
    public setMaxAnalysers(count: number) {
        if (!Number.isFinite(count) || count < 1 || count === this.pool.cap) {
            return;
        }

        this.pool.cap = Math.floor(count);

        log(`pool: cap is ${this.pool.cap}`);

        this.enforcePool();
        this.announcePool();
    }

    // The documents in visible editors. Their projects are pinned and, if not
    // running, started.
    public setVisibleDocuments(uris: string[]) {
        this.visible = new Set(uris.map(uri => this.normalise(uri)));

        // Pinned before anything is started, so starting one visible project
        // cannot stop another.
        const pinned = new Set<string>();

        for (const uri of uris) {
            const route = this.describeRoute(uri);
            const colon = route.indexOf(':');

            if (colon > 0 && route.slice(0, colon) !== 'collection') {
                pinned.add(route.slice(colon + 1));
            }
        }

        this.pool.setPinned(pinned);

        for (const uri of uris) {
            this.getWorkspaceForUri(uri, Use.PASSIVE);
        }

        this.enforcePool();
        this.announcePool();
    }

    private normalise(uri: string): string {
        try {
            return normalizeFileUri(uri);
        } catch {
            return uri;
        }
    }

    private isVisible(uri: string): boolean {
        return this.visible === null || this.visible.has(this.normalise(uri));
    }

    // Tells the client what runs, for its status bar.
    private announcePool() {
        this.connection?.sendNotification?.('ghul/pool', {
            started: Array.from(this.workspaces.keys()),
            cap: this.pool.cap,
            pinned: Array.from(this.workspaces.keys()).filter(root => this.pool.isPinned(root))
        });
    }

    private announceCollection(collection: string) {
        if (this.announced_collections.has(collection)) {
            return;
        }

        this.announced_collections.add(collection);

        const message =
            `ghūl analysis is off under ${collection}: it is a collection of independent projects, not one. ` +
            `Open a project inside it as a folder to analyse that project.`;

        log(message);

        this.connection?.window?.showInformationMessage(message);
    }

    // Where a document would route, for the request trace: the innermost root
    // that contains it, and whether that root is started, waiting, or a
    // collection. Starts nothing.
    public describeRoute(uri: string): string {
        let fs_path: string;

        try {
            fs_path = URI.parse(uri).fsPath;
        } catch {
            return 'unparsable';
        }

        let best: { root: string, kind: string } | null = null;

        const consider = (root: string, kind: string) => {
            if (this.isUnder(fs_path, root) && (!best || root.length > best.root.length)) {
                best = { root, kind };
            }
        };

        this.workspaces.forEach((_c, root) => consider(root, 'started'));
        this.pendingProjects().forEach(root => consider(root, 'pending'));
        this.collectionRoots().forEach(root => consider(root, 'collection'));

        return best ? `${(best as any).kind}:${(best as any).root}` : 'none';
    }

    public unregisterWorkspace(workspace_root: string) {
        const context = this.workspaces.get(workspace_root);

        if (!context) {
            return;
        }

        context.response_handler.clearPublishedDiagnostics?.();
        context.dispose();
        this.workspaces.delete(workspace_root);
        this.pool.forget(workspace_root);
    }

    public allWorkspaces(): WorkspaceContext[] {
        return Array.from(this.workspaces.values());
    }

    // Recompute each workspace's open-file set from the currently-open
    // documents and push it to that workspace's analyser. Every workspace is
    // told — even to an empty set — so a workspace whose last open file just
    // closed clears its scope. Per-URI demux mirrors onDidChangeContent.
    private broadcastOpenFiles() {
        const uris_by_workspace = new Map<WorkspaceContext, string[]>();

        for (const document of this.documents.all()) {
            const workspace = this.getWorkspaceForUri(document.uri, Use.PASSIVE);

            if (!workspace) {
                continue;
            }

            const uris = uris_by_workspace.get(workspace) ?? [];
            uris.push(document.uri);
            uris_by_workspace.set(workspace, uris);
        }

        for (const workspace of this.allWorkspaces()) {
            workspace.edit_queue.sendOpenFiles(uris_by_workspace.get(workspace) ?? []);
        }
    }

    // For requests that aren't tied to a specific URI (workspace/symbol,
    // background heap checks). Returns the first registered workspace today;
    // multi-workspace will need callers that aggregate across all workspaces.
    public defaultWorkspace(): WorkspaceContext | null {
        const iter = this.workspaces.values().next();

        return iter.done ? null : iter.value;
    }

    // Find the workspace that owns this document URI: of the workspaces whose
    // root contains the file, the innermost one whose project's sources
    // include it. The containing folder alone is not enough — a project folder
    // routinely holds .ghul files the project does not compile, a nested test
    // project being the usual case, and analysing those against the enclosing
    // project reports errors about a compilation they are not part of.
    // Returns null if no workspace claims the file — caller should drop the
    // request rather than route arbitrarily.
    //
    // A project found under an open folder and not started yet starts here,
    // when a file in it is asked about, unless the caller only wants to know
    // (a file-watcher event for a project nobody has opened must not start
    // its compiler). A file under a collection, and not under a project
    // inside it, belongs to no workspace: the collection is announced once.
    public getWorkspaceForUri(uri: string, use: Use = Use.INTERACTIVE): WorkspaceContext | null {
        let fs_path: string;

        try {
            fs_path = URI.parse(uri).fsPath;
        } catch (e) {
            log(`getWorkspaceForUri: could not parse uri '${uri}': ${e}`);
            return null;
        }

        if (!fs_path) {
            return null;
        }

        const fs_path_normalised = fs_path.replace(/\\/g, '/');

        type Candidate = { root: string, context?: WorkspaceContext, kind: 'started' | 'pending' | 'collection' };

        const candidates: Candidate[] = [];

        for (const context of this.workspaces.values()) {
            if (this.isUnder(fs_path_normalised, context.workspace_root)) {
                candidates.push({ root: context.workspace_root, context, kind: 'started' });
            }
        }

        for (const root of this.pendingProjects()) {
            if (this.isUnder(fs_path_normalised, root)) {
                candidates.push({ root, kind: 'pending' });
            }
        }

        for (const root of this.collectionRoots()) {
            if (this.isUnder(fs_path_normalised, root)) {
                candidates.push({ root, kind: 'collection' });
            }
        }

        // The innermost root first. A pending project and a collection claim
        // everything under them that no deeper root takes, as a started
        // project's own sources are bounded by them.
        candidates.sort((a, b) => b.root.length - a.root.length);

        for (const candidate of candidates) {
            if (candidate.kind === 'collection') {
                if (use !== Use.WATCH) {
                    this.announceCollection(candidate.root);
                }

                return null;
            }

            if (candidate.kind === 'pending') {
                const starts = use === Use.INTERACTIVE || (use === Use.PASSIVE && this.isVisible(uri));

                if (use === Use.INTERACTIVE) {
                    this.pool.touch(candidate.root);
                }

                return starts ? this.activate(candidate.root) : null;
            }

            if (candidate.context!.claimsSourceFile(uri)) {
                if (use === Use.INTERACTIVE) {
                    this.pool.touch(candidate.root);
                }

                return candidate.context!;
            }
        }

        return null;
    }

    // Single demux for watched-file events: the LSP Connection only allows one
    // handler, so we register it here and fan each change out to the workspace
    // that owns it.
    public onDidChangeWatchedFiles(params: DidChangeWatchedFilesParams) {
        if (!params?.changes) {
            return;
        }

        for (const change of params.changes) {
            if (/(^|\/)(ghul-project\.json|[^/]+\.ghulproj)$/.test(change.uri)) {
                this.scheduleRediscovery();
            }

            const workspace = this.getWorkspaceForUri(change.uri, Use.WATCH);

            if (!workspace) {
                continue;
            }

            workspace.document_change_tracker?.onDidChangeWatchedFiles({
                changes: [change]
            });
        }
    }
}
