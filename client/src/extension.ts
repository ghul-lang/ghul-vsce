'use strict';

import { log } from 'console';
import * as path from 'path';

import { appendFileSync } from 'fs';

import { commands, ExtensionContext, MarkdownString, QuickPickItem, StatusBarAlignment, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

// Mirrors the payload of the server's ghul/metrics notification
// (server/src/metrics-reporter.ts). Durations are in milliseconds, and null
// until the analyser has completed one of that kind of run.
interface IncrementalStats {
	body_rewalk: number;
	interface_incremental: number;
	full_rebuild: number;
	total: number;
	top_decline_reason: string | null;
	top_decline_count: number;
}

interface AnalysisMetrics {
	workspace: string;
	edit_ms: number | null;
	compile_ms: number | null;
	incremental_requested: boolean;
	incremental: IncrementalStats | null;
}

export function activate(context: ExtensionContext) {
	log("client entry point...")

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

	// The debug options for the server
	let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run : { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	}

	// vscode-languageclient renders workDoneProgress at ProgressLocation.Window
	// by default, which VS Code shows as an easy-to-miss status bar sliver (the
	// library's own source calls it "a silent window progress with a hidden
	// notification"). The workspace setup this reports on can take the better
	// part of a minute on a fresh checkout, so surface it ourselves via a
	// dedicated status bar item instead.
	//
	// One item carries everything ghūl has to say. It is always the logo and a
	// state glyph — a spinner while the analyser is working, a ring while it
	// is not — with a message between them for the few activities that owe the
	// user an explanation rather than a spinner. Routine analysis reports no
	// words at all, so the item stays one fixed width through everything the
	// user does to it while typing; the analyser timings live in the tooltip
	// rather than taking permanent width. The extension only activates on a
	// workspace containing ghūl files, so the item is meaningful wherever it
	// appears and never needs to be hidden.
	let statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right);
	context.subscriptions.push(statusBarItem);

	// How long a finished activity stays on screen. Work that takes a moment
	// and then vanishes the instant it lands is not readable — the message is
	// gone before it can be taken in, and the status bar reads as flickering
	// rather than as reporting. Long enough to read a few words, short enough
	// not to still be claiming something is happening when it isn't.
	const COMPLETED_HOLD_MS = 1500;

	// Trails whatever else the item is showing rather than leading it: the logo
	// is what identifies the item, so it keeps the front, and the state glyph
	// reads as attached to the activity it belongs to.
	const RUNNING_ICON = '$(sync~spin)';

	// Stands in the same cell as RUNNING_ICON when nothing is running.
	// Codicons share a glyph box, so swapping one for the other never resizes
	// the item, and nothing else in the status bar is pushed aside while the
	// analyser works. `blank` is a real codicon that draws nothing, so the
	// resting state holds the width without putting a mark on screen for a
	// state that has nothing to report.
	const IDLE_ICON = '$(blank)';

	// Contributed in package.json from images/ghul-icons.woff. It stands where
	// the word "ghūl" used to, so the item says who is reporting without
	// spending width on it, and it takes the status bar foreground colour the
	// same way the codicons beside it do.
	const BRAND_ICON = '$(ghul-logo)';

	// The one phrase the server uses for all of its routine analysis — an edit
	// being digested, the full check after a lull, a slow query. It stands for
	// "the analyser is busy" and nothing more, so it is shown as the spinner
	// alone: the words would appear and vanish several times a minute while
	// drawing a distinction nobody asked to follow. Every other message names
	// something rarer that leaves the editor degraded while it runs, and is
	// shown as it stands.
	//
	// Kept in step with ROUTINE_ANALYSIS_MESSAGE in
	// server/src/activity-progress.ts, which explains why it is a word rather
	// than a marker.
	const ROUTINE_ANALYSIS_MESSAGE = 'analysing';

	interface ProgressEntry {
		message: string;
		// Set once the activity has finished and the message is only being
		// held on screen to be read.
		completed: boolean;
	}

	// Keyed per token so two workspace folders initialising concurrently each
	// keep their own message: one folder finishing must not blank out or
	// overwrite what another still-initialising folder is reporting.
	let progressMessages = new Map<string | number, ProgressEntry>();
	let holdTimers = new Map<string | number, NodeJS.Timeout>();

	function render() {
		const entries = [...progressMessages.values()];

		// Anything still running spins, whatever it is — including routine
		// analysis, which contributes the spinner without contributing words.
		const running = entries.some(entry => !entry.completed);

		// Of the activities that do have something to say, the most recent
		// one says it.
		const explained = entries.filter(entry => entry.message != ROUTINE_ANALYSIS_MESSAGE);
		const entry = explained[explained.length - 1];

		statusBarItem.text =
			`${BRAND_ICON}${entry ? ` ${entry.message}` : ''} ${running ? RUNNING_ICON : IDLE_ICON}`;

		statusBarItem.tooltip = describeMetrics();
		statusBarItem.show();
	}

	function clearHold(token: string | number) {
		const timer = holdTimers.get(token);

		if (timer) {
			clearTimeout(timer);
			holdTimers.delete(token);
		}
	}

	// Map iteration order is insertion order, and re-setting an existing key
	// does not move it to the end — so a token's key must be deleted before
	// it is re-set, or render keeps showing whichever token merely began first
	// instead of whichever most recently reported.
	function setProgress(token: string | number, message: string) {
		clearHold(token);
		progressMessages.delete(token);
		progressMessages.set(token, { message, completed: false });
		render();
	}

	// The activity is over. Whatever it last said stays up, in the past tense
	// the server switched it to, with the spinner stopped — then the item falls
	// back to the logo and the idle ring. More work arriving in the meantime
	// takes the display back immediately, via setProgress above; there is no
	// wait to get through before the next thing can be reported.
	function finishProgress(token: string | number) {
		const entry = progressMessages.get(token);

		if (!entry) {
			return;
		}

		// Routine analysis put no words on screen, so it has none to leave
		// there — and it ends often enough that holding a timer open for each
		// one would be a timer per keystroke burst for nothing to read.
		if (entry.message == ROUTINE_ANALYSIS_MESSAGE) {
			clearHold(token);
			progressMessages.delete(token);
			render();

			return;
		}

		entry.completed = true;
		render();

		clearHold(token);
		holdTimers.set(token, setTimeout(() => {
			holdTimers.delete(token);
			progressMessages.delete(token);
			render();
		}, COMPLETED_HOLD_MS));
	}

	// The two numbers that answer "is the language support keeping up?": how
	// long the analyser takes to digest an edit, and how long a full check of
	// the project takes. Both are smoothed server-side, so these are settled
	// figures rather than ones that jump on every keystroke. They reach the
	// user through the tooltip's one-line summary and the quick pick's full
	// record, never as width in the bar itself.
	//
	// Keyed per workspace folder for the same reason progress is keyed per
	// token: in a multi-root workspace each folder has its own compiler, and
	// its own latency.
	let metrics = new Map<string, AnalysisMetrics>();

	function formatDuration(milliseconds: number): string {
		return milliseconds >= 1000
			? `${(milliseconds / 1000).toFixed(1)} s`
			: `${milliseconds.toFixed(0)} ms`;
	}

	// The same figures as formatDuration, without the space: on the tooltip's
	// one line per analyser, `12ms/240ms` keeps the pair readable as a pair.
	function compactDuration(milliseconds: number): string {
		return formatDuration(milliseconds).replace(' ', '');
	}

	// What the server last said about which projects have an analyser running.
	let pool: { started: string[], cap: number, pinned: string[] } | null = null;

	// Every root the client knows an analyser by, in a stable order: the pool's
	// started list first (it is the authority on what runs), then any workspace
	// that has reported metrics without appearing in it.
	function knownRoots(): string[] {
		const roots = pool ? [...pool.started] : [];

		for (const root of metrics.keys()) {
			if (!roots.includes(root)) {
				roots.push(root);
			}
		}

		return roots;
	}

	// A root by its folder name alone. A tooltip sizes itself to its widest
	// line, so full paths would set the width of everything else in it; the
	// quick pick the item opens on click carries the full paths. Two roots
	// sharing a folder name take their parent folder too, so they stay
	// distinguishable.
	function shortName(root: string, all: string[]): string {
		const base = path.basename(root) || root;
		const clashes = all.filter(other => (path.basename(other) || other) == base);

		if (clashes.length > 1) {
			return `${path.basename(path.dirname(root))}/${base}`;
		}

		return base;
	}

	// A run of block glyphs reads as proportion in any font, and the fenced
	// code block the tooltip renders them in is monospaced, so they are
	// accurately proportional too. Denser glyphs mark the cheaper incremental
	// paths: a body re-walk (solid) reuses the most retained state, an
	// interface incremental (medium) a little less, a full rebuild (light)
	// none.
	function bar(filled: number, total: number, width: number): string {
		const cells = total > 0 ? Math.round((filled / total) * width) : 0;

		return '█'.repeat(Math.min(Math.max(cells, 0), width)) + '░'.repeat(Math.max(width - cells, 0));
	}

	// One bar, three segments. Rounding three fractions independently can
	// over- or under-fill the bar by a cell; the difference is taken from (or
	// given to) the largest segment, where one cell is the smallest share.
	function stackedBar(fast: number, medium: number, slow: number, width: number): string {
		const total = fast + medium + slow;

		if (total === 0) {
			return '░'.repeat(width);
		}

		const segments = [
			{ count: Math.round((fast / total) * width), glyph: '█' },
			{ count: Math.round((medium / total) * width), glyph: '▓' },
			{ count: Math.round((slow / total) * width), glyph: '░' }
		];

		const largest = segments.reduce((a, b) => a.count >= b.count ? a : b);
		largest.count += width - segments.reduce((sum, s) => sum + s.count, 0);

		return segments.map(s => s.glyph.repeat(Math.max(s.count, 0))).join('');
	}

	// The one-line form of one analyser's numbers, for the tooltip. The bars
	// carry the shape — edit time as a fraction of full analysis, and the
	// incremental split by path — while the figures beside them keep the
	// absolute values: a bar says "small", only the number says how small.
	function describeAnalyser(m: AnalysisMetrics | undefined): string {
		if (!m) {
			return 'starting';
		}

		let edit: string;

		if (m.edit_ms != null && m.compile_ms != null) {
			edit = `edit ${bar(m.edit_ms, m.compile_ms, 8)} ${compactDuration(m.edit_ms)}/${compactDuration(m.compile_ms)}`;
		} else {
			edit = `edit ${m.edit_ms != null ? compactDuration(m.edit_ms) : '—'}/${m.compile_ms != null ? compactDuration(m.compile_ms) : '—'}`;
		}

		let incremental: string;

		if (!m.incremental_requested) {
			incremental = 'incr off';
		} else if (!m.incremental || m.incremental.total === 0) {
			incremental = 'incr on, no edits';
		} else {
			const { body_rewalk, interface_incremental, full_rebuild, total } = m.incremental;
			const rate = Math.round(((body_rewalk + interface_incremental) / total) * 100);

			incremental = `incr ${stackedBar(body_rewalk, interface_incremental, full_rebuild, 10)}`
				+ ` ${String(rate).padStart(3)}% of ${total}`;

			if (m.incremental.top_decline_reason) {
				incremental += ` · ${m.incremental.top_decline_reason} ${m.incremental.top_decline_count}`;
			}
		}

		return `${edit}  ${incremental}`;
	}

	// The whole tooltip: one fenced code block, so every line shares a
	// monospace font and the bars align, with one line per analyser rather
	// than the seven the full record takes. Everything the lines leave out —
	// full paths, the per-path edit counts — is in the quick pick the item
	// opens on click, so compacting the tooltip loses nothing permanently.
	function describeMetrics(): MarkdownString {
		const md = new MarkdownString();
		const roots = knownRoots();

		if (roots.length === 0 && !pool) {
			md.appendText('ghūl language support');
			return md;
		}

		const lines: string[] = [];

		if (pool) {
			lines.push(`analysers ${pool.started.length} of ${pool.cap}`);
		}

		const names = new Map(roots.map(root => [root, shortName(root, roots)]));
		const widest = Math.max(...[...names.values()].map(name => name.length));

		for (const root of roots) {
			const name = names.get(root)!.padEnd(widest);
			const visible = pool?.pinned.includes(root) ? ' · visible' : '';

			lines.push(`${name}  ${describeAnalyser(metrics.get(root))}${visible}`);
		}

		md.appendCodeblock(lines.join('\n'), '');
		return md;
	}

	// The click-through: the full record for every analyser, in the one place
	// the workbench gives that can scroll. A quick pick costs nothing until
	// opened, shows long paths without sizing anything else to them, and
	// filters on its detail text, so a path fragment finds the analyser it
	// belongs to.
	async function showAnalysisStatus(): Promise<void> {
		const roots = knownRoots();
		const items: QuickPickItem[] = [];

		if (pool) {
			items.push({
				label: `${pool.started.length} of ${pool.cap} analysers running`,
				detail: 'the cap bounds simultaneous analysers; a project with a visible editor keeps its place'
			});
		}

		if (roots.length === 0) {
			items.push({ label: 'no analysers yet' });
		}

		for (const root of roots) {
			const m = metrics.get(root);
			const visible = pool?.pinned.includes(root) ?? false;

			items.push({
				label: shortName(root, roots),
				description: m && (m.edit_ms != null || m.compile_ms != null)
					? `edit ${m.edit_ms == null ? '—' : formatDuration(m.edit_ms)} · full ${m.compile_ms == null ? '—' : formatDuration(m.compile_ms)}`
					: '',
				detail: [
					root + (visible ? ' — visible' : ''),
					m
						? `edit analysis: ${m.edit_ms == null ? '—' : formatDuration(m.edit_ms)}\n`
							+ `full analysis: ${m.compile_ms == null ? '—' : formatDuration(m.compile_ms)}\n`
							+ describeIncremental(m)
						: 'no measurements yet'
				].join('\n')
			});
		}

		await window.showQuickPick(items, {
			placeHolder: 'ghūl analysers — timings and incremental edit accounting',
			matchOnDetail: true
		});
	}

	const SHOW_STATUS_COMMAND = 'ghul.showAnalysisStatus';

	context.subscriptions.push(commands.registerCommand(SHOW_STATUS_COMMAND, showAnalysisStatus));
	statusBarItem.command = SHOW_STATUS_COMMAND;

	// What the analyser did with the edits it was given, as against what it was
	// asked to do with them. An edit served incrementally reuses the state the
	// analyser already holds; one that isn't rebuilds the whole project, which
	// on a large one is the difference between milliseconds and most of a
	// second. Nothing else surfaces this, so a rate that has quietly gone to
	// zero looks the same from outside as an analyser that has simply become
	// slow — which is the question this exists to answer. The full record with
	// the per-path counts goes in the quick pick; the tooltip shows the rate,
	// the split as a stacked bar, and the top decline reason.
	function describeIncremental(m: AnalysisMetrics): string {
		if (!m.incremental_requested) {
			return "incremental analysis: off";
		}

		if (!m.incremental || m.incremental.total === 0) {
			return "incremental analysis: on, no edits yet";
		}

		const { body_rewalk, interface_incremental, full_rebuild, total } = m.incremental;
		const rate = Math.round(((body_rewalk + interface_incremental) / total) * 100);

		let described =
			`incremental analysis: on, ${rate}% of ${total} edit${total === 1 ? "" : "s"}\n` +
			`  body re-walk: ${body_rewalk}\n` +
			`  interface: ${interface_incremental}\n` +
			`  full rebuild: ${full_rebuild}`;

		if (m.incremental.top_decline_reason) {
			described += `\n  mostly declined: ${m.incremental.top_decline_reason} (${m.incremental.top_decline_count})`;
		}

		return described;
	}

	function setMetrics(m: AnalysisMetrics) {
		metrics.delete(m.workspace);
		metrics.set(m.workspace, m);
		render();
	}

	// Put the item up before the server has said anything. Activation already
	// means this workspace contains ghūl code, and an item that only appeared
	// once the first activity happened to arrive would read as ghūl support
	// coming and going.
	render();

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for ghul source files
		documentSelector: [{scheme: 'file', language: 'ghul'}],

		// File watching is not configured here: the server registers the
		// patterns it cares about itself, via workspace/didChangeWatchedFiles,
		// so that every client watches the same set. Declaring them here too
		// would deliver each change twice.

		middleware: {
			// Deliberately not calling `next(token, params)` here: doing so hands
			// the same notification to vscode-languageclient's own default
			// handler, which renders it a second time via the built-in
			// ProgressLocation.Window UI described above — a second, differently
			// styled spinner showing identical text next to this one.
			handleWorkDoneProgress: (token, params, _next) => {
				switch (params.kind) {
					// A blank message means the token was granted after the
					// work it was for had already finished. It has to be begun
					// before it can be ended, so it arrives as an immediate
					// begin/end pair with nothing to say — rendering it would
					// flash an empty label in the status bar.
					case 'begin':
						if (params.message) {
							setProgress(token, params.message);
						}
						break;
					case 'report':
						if (params.message) {
							setProgress(token, params.message);
						}
						break;
					case 'end':
						finishProgress(token);
						break;
				}
			}
		}
	}
	
	// Create the language client and start the client.
	let client = new LanguageClient('ghul', 'ghūl language extension', serverOptions, clientOptions);

	client.start().then(() => {
		log("client started...");

		// Measuring aid, with the server's request trace: which editors are
		// visible, and which is active, as they change.
		const trace_path = process.env.GHUL_REQUEST_TRACE;

		if (trace_path) {
			const record = (kind: string) => {
				try {
					appendFileSync(trace_path, JSON.stringify({
						t: Date.now(),
						kind,
						visible: window.visibleTextEditors.map(e => e.document.uri.toString()),
						active: window.activeTextEditor?.document.uri.toString() ?? null,
					}) + '\n');
				} catch {
					// a measuring aid never gets in the way
				}
			};

			record('client:start');

			context.subscriptions.push(
				window.onDidChangeVisibleTextEditors(() => record('client:visible')),
				window.onDidChangeActiveTextEditor(() => record('client:active'))
			);
		}

		context.subscriptions.push(
			client.onNotification('ghul/metrics', (m: AnalysisMetrics) => setMetrics(m)),
			client.onNotification('ghul/pool', (p: { started: string[], cap: number, pinned: string[] }) => {
				pool = p;
				render();
			})
		);

		// The editors the user can see, so the server keeps their projects'
		// analysers running and starts one for a visible document without
		// starting one for every tab restored in the background.
		const sendVisibleDocuments = () => {
			client.sendNotification('ghul/visibleDocuments', {
				uris: window.visibleTextEditors
					.filter(editor => editor.document.languageId === 'ghul')
					.map(editor => editor.document.uri.toString())
			});
		};

		sendVisibleDocuments();

		context.subscriptions.push(window.onDidChangeVisibleTextEditors(sendVisibleDocuments));

		// Push the disposable to the context's subscriptions so that the 
		// client can be deactivated on extension deactivation
		context.subscriptions.push(client);
	
		log("client activated...");	
	});
}
