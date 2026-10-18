import { writeFileSync } from 'fs';
import { quote } from 'shell-quote';

import {
	spawn,
	ChildProcess
} from 'child_process';

import { Connection } from 'vscode-languageserver';

import { log } from './log';

import { GhulConfig } from './ghul-config';

import { ResponseHandler } from './response-handler';
import { ResponseParser } from './response-parser';

import { ServerEventEmitter } from './server-event-emitter';

import { ConfigEventEmitter } from './config-event-emitter';
import { EditQueue } from './edit-queue';
import { Watchdog } from './watchdog';

export enum ServerState {
	Cold,
	StartingUp,
	Listening,
	Aborted,
	Blocked,
	// The compiler could not be started — either it was never resolved, or it
	// kept failing and we have given up retrying. We stay here, doing nothing,
	// until a fresh configuration arrives (the user edits a project file).
	Failed,
	// The compiler exited because it had been idle, and is waiting to be
	// needed. Healthy, unlike every other not-running state: the next request
	// brings it straight back.
	Dormant
}

// How many consecutive failed starts to tolerate before giving up. A healthy
// run (the compiler reaching the Listening state) resets the count, so this
// only trips when the compiler cannot start at all — a missing or broken
// .ghulproj, an unresolved compiler tool, an immediate crash.
export const MAX_RESTART_ATTEMPTS = 5;

// Every compiler this process has spawned that has not been seen to exit,
// keyed by workspace root.
//
// A ServerManager kills its own outgoing child when it relaunches, but a
// *replacement* manager for the same workspace — a fresh configuration, a
// reconnect — starts with no handle to the child its predecessor left running,
// and cannot kill what it cannot see. The abandoned compiler then stays
// resident for the life of the extension host, holding the several hundred
// megabytes of a warm analyser, and is not reaped by end-of-input either: the
// host still holds its pipes open, so no end of input ever arrives.
//
// Registering here rather than on the instance is what makes the reap
// survive the instance. Same process throughout, so a live handle is exact —
// no pid to go stale or be reused by something else.
const live_children = new Map<string, ChildProcess>();

export class ServerManager {
	child: ChildProcess;
	expecting_exit: boolean;
	expecting_recycle: boolean;
	expecting_idle_exit: boolean;

	event_emitter: ServerEventEmitter;
	connection: Connection;

	server_state: ServerState;
	ghul_config: GhulConfig;
	workspace_root: string;
	analysis_response_file: () => string;
	edit_queue: EditQueue;
	response_handler: ResponseHandler;
	response_parser: ResponseParser;
	watchdog: Watchdog;

	restart_attempts: number;

	// The last failure shown, so the same one is not raised again.
	private last_failure: string | null = null;

	restart_timer: NodeJS.Timeout;

	constructor(
		config_event_source: ConfigEventEmitter,
		event_emitter: ServerEventEmitter,
		edit_queue: EditQueue,
		response_handler: ResponseHandler,
		response_parser: ResponseParser,
		watchdog: Watchdog,
		workspace_root: string,
		analysis_response_file: () => string,
		connection?: Connection
	) {
		this.event_emitter = event_emitter;
		this.edit_queue = edit_queue;
		this.response_handler = response_handler;
		this.response_parser = response_parser;
		this.watchdog = watchdog;
		this.workspace_root = workspace_root;
		this.analysis_response_file = analysis_response_file;
		this.connection = connection;

		this.restart_attempts = 0;

		// The workspace_root passed by configAvailable is the same path we were
		// constructed with — kept here for backwards compatibility with the
		// onConfigAvailable signature; ignored for per-workspace state.
		config_event_source.onConfigAvailable((_workspace: string, config: GhulConfig) => {
			// Setup can run again without anything the compiler cares about
			// having changed — a re-read after a build, a watched file that
			// resolved to the same configuration. Replacing a healthy analyser
			// in that case costs the user its warm state and a full recompile
			// to answer the next query, in exchange for an identical process.
			if (this.isServingConfig(config)) {
				log("configuration is unchanged: keeping the running compiler");
				this.ghul_config = config;
				return;
			}

			this.ghul_config = config;
			this.start();
		});
	}

	// Whether the compiler now running was started from this configuration.
	// A compiler that has exited, or never started, is not serving anything —
	// however equal the configuration is.
	private isServingConfig(config: GhulConfig): boolean {
		const running =
			this.server_state == ServerState.Listening ||
			this.server_state == ServerState.StartingUp;

		if (!running || !this.child || this.child.exitCode != null) {
			return false;
		}

		return JSON.stringify(this.ghul_config) == JSON.stringify(config);
	}

	// Entry point for a fresh configuration. A new config means the user (or
	// the tooling) has changed something, so any earlier give-up is forgiven:
	// reset the back-off budget and try again from scratch.
	start() {
		this.clearRestartTimer();
		this.restart_attempts = 0;

		this.launch();
	}

	// Kill a compiler left running for this workspace by an earlier manager.
	// Ours, if we have one, has just been killed above and is not a candidate.
	private reapAbandonedCompiler() {
		const abandoned = live_children.get(this.workspace_root);

		if (!abandoned || abandoned === this.child || abandoned.exitCode != null) {
			return;
		}

		log(`killing abandoned compiler PID ${abandoned.pid} left by an earlier connection`);

		try {
			// Its stdout may still be wired to a parser belonging to whatever
			// created it; detach before killing so a dying frame cannot reach
			// anyone's parser.
			abandoned.stdout?.removeAllListeners('data');

			// The manager that spawned it is still listening for its exit, and
			// has no idea we are about to cause one: it would book a crash,
			// relaunch itself immediately, and reap whatever is registered for
			// this workspace by then — which is this manager's own healthy
			// child. Detaching first means the kill stays ours.
			abandoned.removeAllListeners('exit');
			abandoned.removeAllListeners('error');

			// 'error' is replaced rather than left bare: the kill below can
			// raise one asynchronously (the process is already gone, or the
			// signal is refused), and an 'error' emitted with no listener at
			// all throws out of the emitter and takes the language server down
			// with it — every workspace, not just this reap. The try/catch
			// around this block would not see it.
			abandoned.on('error', e => log(`abandoned compiler PID ${abandoned.pid} errored while being killed: ${e}`));

			abandoned.kill();
		} catch (e) {
			log("killing abandoned compiler caught: " + e);
		}

		live_children.delete(this.workspace_root);
	}

	private launch() {
		this.event_emitter.starting();

		this.server_state = ServerState.StartingUp;

		let ghul_compiler = this.ghul_config.compiler;

		if (this.child) {
			log("killing running compiler PID " + this.child.pid);
			this.expecting_exit = true;

			// Killing it ourselves overrides whatever it had announced about
			// its own exit. Left set, either flag would outlive the child it
			// described — the exit handler takes the expecting_exit branch and
			// returns without clearing them — and the *next* child would
			// inherit it, so a genuine crash would be read as a planned exit:
			// no error surfaced, and for an idle exit no crash budget spent
			// either, because the relaunch would come from the request path
			// rather than from the back-off.
			this.expecting_recycle = false;
			this.expecting_idle_exit = false;

			// Stop routing the outgoing compiler's stdout into the shared
			// parser — its dying output must not bleed into the replacement's
			// frames.
			this.child.stdout?.removeAllListeners('data');
			this.child.kill();
		}

		this.reapAbandonedCompiler();

		if (this.ghul_config.block) {
			log("compiler block requested: won't spawn compiler");
			this.server_state = ServerState.Blocked;
			return;
		}

		// A retry storm cannot recover from a compiler that was never
		// resolved — spawning undefined would just throw. Surface the reason
		// and wait for a corrected configuration.
		if (!ghul_compiler || ghul_compiler.length == 0) {
			// The problems say why, a manifest ghul could not read among
			// them; the generic advice is only for when nothing does.
			this.fail(
				"ghūl language extension: " +
				(this.ghul_config.problems?.length
					? this.ghul_config.problems.join("; ")
					: "no ghūl compiler could be found. Install the ghul.compiler tool or set 'compiler' in ghul.json.")
			);
			return;
		}

		// A response file of this workspace's own, outside the project, so
		// multiple compilers in the same extension host don't stomp on each
		// other and nothing is left behind in the checkout. Named absolutely
		// because the compiler resolves an @path relative to its working
		// directory, which is the workspace root rather than here.
		const rsp_path = this.analysis_response_file();
		writeFileSync(rsp_path, quote(this.ghul_config.arguments));

		log(`compiler is "${quote(ghul_compiler)}"`);

		// `dotnet tool run` parses the rest of its command line itself,
		// MSBuild-style - including `@file` response-file expansion, one
		// argument per line. The response file is a single line, so that
		// expansion would hand the compiler the whole file as one argument
		// and the analysis flag would never be seen. `--` ends dotnet's own
		// parsing, letting the response file reach the compiler untouched.
		// The direct `dotnet ghul-compiler` spelling needs no separator:
		// the first token already tells dotnet to pass everything through.
		const is_tool_run =
			ghul_compiler[0] === "dotnet" &&
			ghul_compiler[1] === "tool" &&
			ghul_compiler[2] === "run";

		this.child = spawn(
			ghul_compiler[0],
			[...ghul_compiler.slice(1), ...(is_tool_run ? ["--"] : []), `@${rsp_path}`],
			{ cwd: this.workspace_root }
		);

		// 'error' (e.g. the compiler binary is missing) and 'exit' (the
		// compiler started then died) are both failure routes for this
		// launch. Guard so a single launch is only counted once.
		let failure_handled = false;

		const onChildFailure = (description: string) => {
			if (failure_handled) {
				return;
			}
			failure_handled = true;

			this.child = null;

			this.response_handler.resolveAllPendingPromises();
			this.edit_queue.reset();

			log(description);

			this.scheduleRestart();
		};

		this.child.on("error", err => {
			if (this.expecting_exit) {
				log(`compiler: error after expected exit: ${err.message}`);
				return;
			}

			onChildFailure(`compiler: failed to start: ${err.message}`);
		});

		live_children.set(this.workspace_root, this.child);

		log(`spawned compiler process PID ${this.child.pid}`);

		this.child.stderr.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk);
		});

		// A killed compiler can leave a half-received frame in the shared
		// parser and a watchdog timer still ticking. Clear both before the
		// replacement's output starts: a stale frame would corrupt its LISTEN
		// and leave the project unanalysed, and the calibrated timeout would
		// kill it part-way through its cold first compile.
		this.response_parser.reset();
		this.watchdog.enterColdStart();

		this.child.stdout.on('data', (chunk: Buffer) => {
			this.response_parser.handleChunk(chunk.toString());
		});

		this.event_emitter.running(this.child);

		const pid = this.child?.pid;

		const spawned = this.child;

		this.child.on('exit',
			(_code: number, _signal: string) => {
				// Only if it is still ours: a later launch may already have
				// registered its own child over this entry.
				if (live_children.get(this.workspace_root) === spawned) {
					live_children.delete(this.workspace_root);
				}

				// A child that has already been replaced must not clear the
				// handle to its replacement. The kill and the exit it causes
				// are not simultaneous, so by the time this runs the manager
				// may be several hundred milliseconds into the life of a
				// perfectly healthy successor.
				const is_current = this.child === spawned;

				if (this.expecting_exit) {
					log(`compiler PID ${pid}: exited`);
					if (is_current) {
						this.child = null;
					}
					this.response_handler.resolveAllPendingPromises();
					this.expecting_exit = false;
					return;
				}

				// A recycle is a planned exit — the compiler asked to be
				// restarted (RESTART frame) to shed accumulated memory. It is
				// healthy, so relaunch at once without spending the crash
				// back-off budget.
				if (this.expecting_recycle) {
					this.expecting_recycle = false;
					log(`compiler PID ${pid}: recycled — relaunching`);
					if (is_current) {
						this.child = null;
					}
					this.response_handler.resolveAllPendingPromises();
					this.edit_queue.reset();
					this.launch();
					return;
				}

				// An idle exit is the one healthy exit we do not follow with a
				// launch. Nothing is scheduled and no back-off is spent: the
				// next request calls ensureRunning and pays for the restart
				// then.
				if (this.expecting_idle_exit) {
					this.expecting_idle_exit = false;
					log(`compiler PID ${pid}: exited while idle — will restart when next needed`);
					if (is_current) {
						this.child = null;
					}
					this.server_state = ServerState.Dormant;
					this.response_handler.resolveAllPendingPromises();
					this.edit_queue.reset();
					return;
				}

				onChildFailure(`compiler PID ${pid}: unexpected exit`);
			});
	}

	// Decide whether to try the compiler again after a failed launch, applying
	// an exponential back-off so a persistently-broken project does not turn
	// into a spawn loop (which VS Code eventually responds to by killing the
	// extension host). After MAX_RESTART_ATTEMPTS we stop and wait for a
	// configuration change.
	private scheduleRestart() {
		this.clearRestartTimer();

		this.restart_attempts++;

		if (this.restart_attempts > MAX_RESTART_ATTEMPTS) {
			this.fail(
				"ghūl language extension: the ghūl compiler failed to start repeatedly and will not be retried automatically. " +
				"Check the ghūl project file and compiler configuration — saving a project file will retry."
			);
			return;
		}

		const delay = this.restart_attempts == 1
			? 0
			: Math.min(2000 * 2 ** (this.restart_attempts - 2), 16000);

		log(`compiler: will restart (attempt ${this.restart_attempts} of ${MAX_RESTART_ATTEMPTS}) in ${delay}ms`);

		this.restart_timer = setTimeout(() => {
			this.restart_timer = null;
			this.launch();
		}, delay);
	}

	private clearRestartTimer() {
		if (this.restart_timer) {
			clearTimeout(this.restart_timer);
			this.restart_timer = null;
		}
	}

	// Stop trying and tell the user. We stay in the Failed state until a fresh
	// configuration arrives via onConfigAvailable, which resets everything.
	private fail(message: string) {
		this.clearRestartTimer();

		this.server_state = ServerState.Failed;

		log(message);

		// Each new configuration retries, and one that fails for the same
		// reason would otherwise raise the same error again.
		if (message === this.last_failure) {
			return;
		}

		this.last_failure = message;

		this.connection?.window?.showErrorMessage(message);
	}

	state() {
		return this.server_state;
	}

	startListening() {
		if (this.server_state == ServerState.Blocked) {
			return;
		}

		// The compiler came up cleanly: a later crash gets a fresh retry
		// budget rather than counting against this successful run.
		this.restart_attempts = 0;
		this.last_failure = null;

		this.server_state = ServerState.Listening;

		this.event_emitter.listening();
	}

	abort() {
		if (this.server_state == ServerState.Blocked) {
			return;
		}

		this.server_state = ServerState.Aborted;

		this.event_emitter.abort();
	}

	kill() {
		this.event_emitter.killing();

		log("killing any running compiler...");

		this.clearRestartTimer();

		try {
			this.expecting_exit = true;
			this.child.kill();
			this.event_emitter.killed();
			log("finished killing compiler");
		} catch (e) {
			log("killing compiler caught: " + e);
			this.abort();
		}
	}

	// The compiler announced a planned recycle with a RESTART frame and is
	// about to exit. Mark the coming exit deliberate so it relaunches cleanly
	// rather than being treated as a crash.
	noteRecycle() {
		this.expecting_recycle = true;
	}

	// The compiler announced an idle exit and is about to go. Unlike a
	// recycle, it should not be replaced until there is work for it: see
	// ensureRunning, which every outgoing request passes through.
	noteIdleExit() {
		this.expecting_idle_exit = true;
	}

	// Bring the compiler back if an idle exit put it away. Called before
	// anything is sent, so the cost of the timeout is paid by whoever next
	// needs an answer rather than by a timer nobody is watching.
	//
	// Only Dormant is woken here: every other state is either already running,
	// deliberately not running (Blocked, Aborted), or being retried on its own
	// schedule (Failed, and the back-off timer), and launching underneath any
	// of those would fight whatever put us there.
	ensureRunning() {
		if (this.server_state != ServerState.Dormant) {
			return;
		}

		log("compiler is needed again after an idle exit — relaunching");

		this.launch();
	}

	// The watchdog fired: the compiler has stopped answering but has not
	// exited. Kill it so the 'exit' handler routes through normal crash
	// recovery (back-off included — a wedged compiler may wedge again).
	recoverFromHang() {
		this.response_handler.rejectAllPendingPromises("ghūl language extension: compiler watchdog timeout");

		if (this.child) {
			log(`compiler PID ${this.child.pid}: unresponsive — killing`);
			this.child.kill();
		} else {
			log("compiler watchdog timeout with no running compiler — scheduling restart");
			this.scheduleRestart();
		}
	}

	killQuiet() {
	}
}
