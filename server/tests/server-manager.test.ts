import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';

import { ServerManager, ServerState, MAX_RESTART_ATTEMPTS } from '../src/server-manager';
import { ServerEventEmitter } from '../src/server-event-emitter';
import { ConfigEventEmitter } from '../src/config-event-emitter';
import { EditQueue } from '../src/edit-queue';
import { ResponseParser } from '../src/response-parser';
import { ResponseHandler } from '../src/response-handler';
import { Watchdog, COLD_START_TIMEOUT_MILLISECONDS } from '../src/watchdog';
import { GhulConfig } from '../src/ghul-config';

const TEST_WORKSPACE_ROOT = '/test/workspace';
const TEST_RESPONSE_FILE = '/tmp/ghul-lsp-test/analysis.rsp';

// jest.mock calls are hoisted above the imports so writeFileSync and spawn
// resolve to the mocks even when imported normally:
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    writeFileSync: jest.fn(),
}));

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    spawn: jest.fn(),
}));

function makeFakeChild(pid = 4242) {
    // start() wires .on('error'), .stdout.on, .stderr.on, .on('exit') — give
    // it an EventEmitter-shaped object whose streams are EventEmitters too.
    const child: any = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    return child;
}

describe('ServerManager (state helpers)', () => {
    let manager: ServerManager;
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let connection: any;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;

    beforeEach(() => {
        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();

        // The diagnostic channel: ServerManager calls connection.window.show*
        // when it has to refuse to spawn or gives up retrying.
        connection = {
            window: {
                showErrorMessage: jest.fn(),
                showWarningMessage: jest.fn(),
            },
        };

        watchdog = new Watchdog(10000, () => {});

        // start()'s exit handler calls response_handler.resolveAllPendingPromises,
        // and recoverFromHang calls rejectAllPendingPromises. A stub with those
        // two methods is enough for every test below.
        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        manager = new ServerManager(
            configEvents,
            serverEvents,
            {} as EditQueue,
            responseHandler,
            {} as ResponseParser,
            watchdog,
            TEST_WORKSPACE_ROOT,
            () => TEST_RESPONSE_FILE,
            connection,
        );
    });

    afterEach(() => {
        // A test that armed the watchdog must not leave it ticking past
        // teardown; clear it so the timer can't fire into a torn-down test
        // and crash the worker.
        watchdog.clearWatchdog();
    });

    describe('startListening', () => {
        it('moves to Listening and emits listening event', () => {
            const handler = jest.fn();
            serverEvents.onListening(handler);

            manager.startListening();

            expect(manager.state()).toBe(ServerState.Listening);
            expect(handler).toHaveBeenCalled();
        });

        it('does nothing when the server is Blocked', () => {
            manager.server_state = ServerState.Blocked;
            const handler = jest.fn();
            serverEvents.onListening(handler);

            manager.startListening();

            expect(manager.state()).toBe(ServerState.Blocked);
            expect(handler).not.toHaveBeenCalled();
        });

        it('resets the restart budget — a healthy run forgives earlier failures', () => {
            manager.restart_attempts = 3;

            manager.startListening();

            expect(manager.restart_attempts).toBe(0);
        });
    });

    describe('abort', () => {
        it('moves to Aborted and emits the abort event on the bus', () => {
            // The raw event name is 'aborted'; see server-event-emitter tests.
            const rawHandler = jest.fn();
            serverEvents.on('aborted', rawHandler);

            manager.abort();

            expect(manager.state()).toBe(ServerState.Aborted);
            expect(rawHandler).toHaveBeenCalledTimes(1);
        });

        it('does nothing when Blocked', () => {
            manager.server_state = ServerState.Blocked;
            const rawHandler = jest.fn();
            serverEvents.on('aborted', rawHandler);

            manager.abort();

            expect(manager.state()).toBe(ServerState.Blocked);
            expect(rawHandler).not.toHaveBeenCalled();
        });
    });

    describe('kill', () => {
        it('emits killing and aborts when child.kill() throws', () => {
            const killingHandler = jest.fn();
            const rawAbortHandler = jest.fn();
            serverEvents.onKilling(killingHandler);
            serverEvents.on('aborted', rawAbortHandler);

            manager.child = { kill: jest.fn(() => { throw new Error('EPERM'); }) } as any;

            manager.kill();

            expect(killingHandler).toHaveBeenCalled();
            expect(rawAbortHandler).toHaveBeenCalled();
            expect(manager.state()).toBe(ServerState.Aborted);
        });

        it('has nothing to kill, and does not abort, when no compiler was ever started', () => {
            const killing = jest.fn();
            const killed = jest.fn();
            const rawAbortHandler = jest.fn();
            serverEvents.onKilling(killing);
            serverEvents.onKilled(killed);
            serverEvents.on('aborted', rawAbortHandler);

            manager.child = undefined as any;

            manager.kill();

            expect(killing).toHaveBeenCalled();
            expect(killed).toHaveBeenCalled();
            expect(rawAbortHandler).not.toHaveBeenCalled();
            expect(manager.state()).not.toBe(ServerState.Aborted);
            // No exit is coming, so a later crash is not mistaken for this one.
            expect(manager.expecting_exit).toBeFalsy();
        });

        it('completes the happy path when child.kill() succeeds', () => {
            const killing = jest.fn();
            const killed = jest.fn();
            serverEvents.onKilling(killing);
            serverEvents.onKilled(killed);

            manager.child = { kill: jest.fn() } as any;

            manager.kill();

            expect(killing).toHaveBeenCalled();
            expect(killed).toHaveBeenCalled();
            expect(manager.expecting_exit).toBe(true);
            expect((manager.child!.kill as jest.Mock)).toHaveBeenCalled();
        });

        it('cancels a pending back-off restart so it cannot fire after shutdown', () => {
            manager.child = { kill: jest.fn() } as any;
            manager.restart_timer = setTimeout(() => { /* would relaunch */ }, 10000);

            manager.kill();

            expect(manager.restart_timer).toBeNull();
        });
    });

    describe('killQuiet', () => {
        it('is a no-op (covers it for parity)', () => {
            expect(() => manager.killQuiet()).not.toThrow();
        });
    });

    describe('start', () => {
        // start() is the bug-class adjacency for ghul-vsce#69: it writes
        // .analysis.rsp from this.ghul_config.arguments and then spawns the
        // compiler with @.analysis.rsp. If anything mis-shapes the rsp
        // contents (empty args, wrong quoting, missing -a flags), the
        // analyser falls back to its tiny default assembly list and
        // produces spurious diagnostics. Pin the contract here.

        const baseConfig: GhulConfig = {
            block: false,
            compiler: ['dotnet', 'tool', 'run', 'ghul-compiler'],
            source: ['./**/*.ghul'],
            arguments: ['-a', '/path/to/A.dll', '-a', '/path/to/B.dll', '-A'],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        };

        beforeEach(() => {
            // Restart back-off uses setTimeout; fake timers keep the tests
            // deterministic and stop a scheduled relaunch leaking into the
            // next test.
            jest.useFakeTimers();

            (writeFileSync as jest.Mock).mockClear();
            (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());
            manager.ghul_config = { ...baseConfig };

            // launch() resets the parser before wiring the replacement's
            // stdout; give it a stub so that call doesn't throw.
            manager.response_parser = {
                reset: jest.fn(),
                handleChunk: jest.fn(),
            } as unknown as ResponseParser;
        });

        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
        });

        it('writes the response file it was given, in the form the compiler reads', () => {
            manager.start();

            expect(writeFileSync).toHaveBeenCalledTimes(1);
            const [path, contents] = (writeFileSync as jest.Mock).mock.calls[0];
            // A response file of this workspace's own, outside the project, so
            // multiple compilers in the same host don't stomp on each other
            // and nothing is left behind in the checkout:
            expect(path).toBe(TEST_RESPONSE_FILE);
            // joined with spaces; full argument list must round-trip:
            expect(contents).toBe('-a /path/to/A.dll -a /path/to/B.dll -A');
        });

        it('writes every -a flag into the rsp (regression guard for #69)', () => {
            // The fresh-checkout bug shipped an arguments array containing
            // just ['-A'] because .assemblies.json hadn't been generated yet.
            // Pin that the rsp content reflects whatever arguments contains —
            // server-manager itself does not invent or filter assemblies.
            manager.ghul_config = {
                ...baseConfig,
                arguments: ['-a', '/x.dll', '-a', '/y.dll', '-a', '/z.dll', '-A'],
            };
            manager.start();

            const [, contents] = (writeFileSync as jest.Mock).mock.calls[0];
            expect(contents).toContain('-a /x.dll');
            expect(contents).toContain('-a /y.dll');
            expect(contents).toContain('-a /z.dll');
            expect(contents.endsWith('-A')).toBe(true);
        });

        it('wraps arguments containing spaces in quotes', () => {
            manager.ghul_config = {
                ...baseConfig,
                arguments: ['-a', '/path with spaces/A.dll', '-A'],
            };
            manager.start();

            const [, contents] = (writeFileSync as jest.Mock).mock.calls[0];
            expect(contents).toBe('-a "/path with spaces/A.dll" -A');
        });

        it('spawns the compiler head with the rest of its args plus the response file, anchored to the workspace cwd', () => {
            manager.start();

            expect(spawn).toHaveBeenCalledTimes(1);
            const [head, args, options] = (spawn as jest.Mock).mock.calls[0];
            expect(head).toBe('dotnet');
            // `--` ends dotnet's own argument parsing for the tool-run
            // spelling, so its MSBuild-style response-file expansion leaves
            // the response file for the compiler instead of expanding the
            // single-line rsp into one giant argument. The rsp is named
            // absolutely, since it no longer sits under the cwd:
            expect(args).toEqual(['tool', 'run', 'ghul-compiler', '--', `@${TEST_RESPONSE_FILE}`]);
            expect(options).toEqual({ cwd: TEST_WORKSPACE_ROOT });
        });

        it('adds no -- for the direct dotnet-ghul-compiler spelling', () => {
            manager.ghul_config = { ...baseConfig, compiler: ['dotnet', 'ghul-compiler'] };
            manager.start();

            const [, args] = (spawn as jest.Mock).mock.calls[0];
            expect(args).toEqual(['ghul-compiler', `@${TEST_RESPONSE_FILE}`]);
        });

        it('emits starting then running, with the spawned child', () => {
            const startingHandler = jest.fn();
            const runningHandler = jest.fn();
            serverEvents.onStarting(startingHandler);
            serverEvents.onRunning(runningHandler);

            const child = makeFakeChild(9999);
            (spawn as jest.Mock).mockImplementationOnce(() => child);

            manager.start();

            expect(startingHandler).toHaveBeenCalled();
            expect(runningHandler).toHaveBeenCalledWith(child);
            // starting must fire before running (event ordering matters for
            // any consumer that resets state on 'starting'):
            expect(startingHandler.mock.invocationCallOrder[0])
                .toBeLessThan(runningHandler.mock.invocationCallOrder[0]);
        });

        it('moves to StartingUp state before spawning', () => {
            // start() sets state to StartingUp synchronously before
            // writeFileSync / spawn. If a future change defers state setting
            // past spawn, an exit during spawn could observe Cold state.
            manager.start();

            expect(manager.state()).toBe(ServerState.StartingUp);
        });

        it('honours block = true: no rsp write, no spawn, state Blocked', () => {
            manager.ghul_config = { ...baseConfig, block: true };

            manager.start();

            expect(writeFileSync).not.toHaveBeenCalled();
            expect(spawn).not.toHaveBeenCalled();
            expect(manager.state()).toBe(ServerState.Blocked);
        });

        it('kills an existing child before spawning a replacement', () => {
            const oldChild = makeFakeChild(1111);
            manager.child = oldChild;

            manager.start();

            expect(oldChild.kill).toHaveBeenCalledTimes(1);
            expect(manager.expecting_exit).toBe(true);
            // The new spawn still happened:
            expect(spawn).toHaveBeenCalledTimes(1);
        });

        it('child stdout chunks are forwarded to the response parser', () => {
            const handleChunkSpy = jest.fn();
            manager.response_parser = {
                reset: jest.fn(),
                handleChunk: handleChunkSpy,
            } as unknown as ResponseParser;

            const child = makeFakeChild();
            (spawn as jest.Mock).mockImplementationOnce(() => child);

            manager.start();

            child.stdout.emit('data', Buffer.from('LISTEN\n\f'));

            expect(handleChunkSpy).toHaveBeenCalledWith('LISTEN\n\f');
        });

        it('resets the response parser on launch so a killed compiler\'s '
            + 'partial frame cannot corrupt the replacement', () => {
            const resetSpy = jest.fn();
            manager.response_parser = {
                reset: resetSpy,
                handleChunk: jest.fn(),
            } as unknown as ResponseParser;

            manager.start();

            expect(resetSpy).toHaveBeenCalledTimes(1);
        });

        it('stops routing the outgoing child\'s stdout into the parser before '
            + 'killing it', () => {
            const handleChunkSpy = jest.fn();
            manager.response_parser = {
                reset: jest.fn(),
                handleChunk: handleChunkSpy,
            } as unknown as ResponseParser;

            const oldChild = makeFakeChild(1111);
            manager.child = oldChild;

            manager.start();

            // The outgoing child's dying output must not reach the parser and
            // bleed into the replacement's frames.
            oldChild.stdout.emit('data', Buffer.from('half a fra'));

            expect(handleChunkSpy).not.toHaveBeenCalled();
        });

        it('enters watchdog cold start on launch so the replacement\'s cold '
            + 'first compile is not killed', () => {
            // A calibrated steady-state timeout, as the edit queue would leave it.
            watchdog.setTimeout(3676);

            manager.start();

            expect(watchdog.timeout_milliseconds)
                .toBe(COLD_START_TIMEOUT_MILLISECONDS);
        });

        it('refuses to spawn and reports a diagnostic when no compiler is resolved', () => {
            // A missing/unloadable .ghulproj can leave getGhulConfig with no
            // compiler; spawning undefined would throw and crash the server.
            manager.ghul_config = {
                ...baseConfig,
                compiler: undefined as unknown as string[],
                problems: ['no usable ghūl compiler found'],
            };

            manager.start();

            expect(spawn).not.toHaveBeenCalled();
            expect(manager.state()).toBe(ServerState.Failed);
            expect(connection.window.showErrorMessage).toHaveBeenCalledTimes(1);
            // The recorded problem is surfaced to the user verbatim:
            expect((connection.window.showErrorMessage as jest.Mock).mock.calls[0][0])
                .toContain('no usable ghūl compiler found');
        });

        it('reports the manifest problem as the reason, and only once across retries', () => {
            manager.ghul_config = {
                ...baseConfig,
                compiler: undefined as unknown as string[],
                problems: ['could not write the response file for ghul-project.json: ghul: unknown target fortran'],
            };

            manager.start();
            manager.start();

            expect(connection.window.showErrorMessage).toHaveBeenCalledTimes(1);

            const message = (connection.window.showErrorMessage as jest.Mock).mock.calls[0][0] as string;

            expect(message).toContain('unknown target fortran');
            expect(message).not.toContain('no ghūl compiler could be found');
        });

        it('says no compiler could be found when nothing explains why', () => {
            manager.ghul_config = {
                ...baseConfig,
                compiler: undefined as unknown as string[],
                problems: [],
            };

            manager.start();

            expect((connection.window.showErrorMessage as jest.Mock).mock.calls[0][0])
                .toContain('no ghūl compiler could be found');
        });

        it('on unexpected exit, resets edit queue and respawns after back-off', () => {
            const resetSpy = jest.fn();
            manager.edit_queue = { reset: resetSpy } as unknown as EditQueue;

            manager.start();
            // Simulate the compiler crashing without the manager having
            // asked it to exit:
            manager.expecting_exit = false;
            manager.child!.emit('exit', 1, null);

            expect(resetSpy).toHaveBeenCalled();
            // The first retry is scheduled with zero delay but still async:
            expect(spawn).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(0);
            expect(spawn).toHaveBeenCalledTimes(2);
        });

        it('on a recycle exit, relaunches at once without spending the back-off budget', () => {
            const resetSpy = jest.fn();
            manager.edit_queue = { reset: resetSpy } as unknown as EditQueue;

            manager.start();

            // The compiler announced a planned recycle (RESTART frame) and
            // then exited deliberately.
            manager.noteRecycle();
            manager.expecting_exit = false;
            manager.child!.emit('exit', 1, null);

            expect(resetSpy).toHaveBeenCalled();
            // Relaunched immediately — no scheduled-restart timer to advance:
            expect(spawn).toHaveBeenCalledTimes(2);
            // A recycle is healthy, so it does not count as a failed start:
            expect(manager.restart_attempts).toBe(0);
        });

        it('recoverFromHang kills the unresponsive compiler', () => {
            manager.edit_queue = { reset: jest.fn() } as unknown as EditQueue;

            manager.start();
            const child = manager.child!;

            manager.recoverFromHang();

            expect(child.kill).toHaveBeenCalled();
        });

        it('on expected exit, does not respawn', () => {
            const resetSpy = jest.fn();
            manager.edit_queue = { reset: resetSpy } as unknown as EditQueue;

            manager.start();
            manager.expecting_exit = true;
            manager.child!.emit('exit', 0, null);

            jest.advanceTimersByTime(60000);

            expect(resetSpy).not.toHaveBeenCalled();
            expect(spawn).toHaveBeenCalledTimes(1);
            // expecting_exit must be cleared so the next manual kill works:
            expect(manager.expecting_exit).toBe(false);
        });

        it('applies exponential back-off between successive failed restarts', () => {
            manager.edit_queue = { reset: jest.fn() } as unknown as EditQueue;

            manager.start();

            // First failure: attempt 1, zero delay.
            manager.expecting_exit = false;
            manager.child!.emit('exit', 1, null);
            jest.advanceTimersByTime(0);
            expect(spawn).toHaveBeenCalledTimes(2);

            // Second failure: attempt 2, 2000ms delay — not before, then after.
            manager.expecting_exit = false;
            manager.child!.emit('exit', 1, null);
            jest.advanceTimersByTime(1999);
            expect(spawn).toHaveBeenCalledTimes(2);
            jest.advanceTimersByTime(1);
            expect(spawn).toHaveBeenCalledTimes(3);
        });

        it('treats a spawn error event as a failed launch and backs off', () => {
            manager.edit_queue = { reset: jest.fn() } as unknown as EditQueue;

            manager.start();

            // ENOENT-style: the compiler binary is missing — 'error' fires,
            // 'exit' never does.
            manager.expecting_exit = false;
            manager.child!.emit('error', new Error('spawn ENOENT'));
            jest.advanceTimersByTime(0);

            expect(spawn).toHaveBeenCalledTimes(2);
        });

        it('gives up and reports a diagnostic after repeated failures', () => {
            manager.edit_queue = { reset: jest.fn() } as unknown as EditQueue;

            manager.start();

            // Fail every launch. After MAX_RESTART_ATTEMPTS retries the
            // manager stops trying rather than spawn-looping forever.
            for (let i = 0; i <= MAX_RESTART_ATTEMPTS; i++) {
                expect(manager.child).not.toBeNull();
                manager.expecting_exit = false;
                manager.child!.emit('exit', 1, null);
                jest.advanceTimersByTime(60000);
            }

            expect(manager.state()).toBe(ServerState.Failed);
            expect(manager.child).toBeNull();
            expect(connection.window.showErrorMessage).toHaveBeenCalledTimes(1);

            // No further restarts once it has given up:
            const spawnsAtGiveUp = (spawn as jest.Mock).mock.calls.length;
            jest.advanceTimersByTime(120000);
            expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsAtGiveUp);
        });

        it('a fresh configuration forgives an earlier give-up and retries', () => {
            manager.edit_queue = { reset: jest.fn() } as unknown as EditQueue;

            manager.start();
            for (let i = 0; i <= MAX_RESTART_ATTEMPTS; i++) {
                manager.expecting_exit = false;
                manager.child!.emit('exit', 1, null);
                jest.advanceTimersByTime(60000);
            }
            expect(manager.state()).toBe(ServerState.Failed);

            // The user fixes the project — start() runs again (driven by a
            // new config-available event); the manager resets and relaunches.
            const spawnsBefore = (spawn as jest.Mock).mock.calls.length;
            manager.start();

            expect(manager.restart_attempts).toBe(0);
            expect(manager.state()).toBe(ServerState.StartingUp);
            expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsBefore + 1);
        });
    });
});

describe('ServerManager (idle exit)', () => {
    let manager: ServerManager;
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;
    let editQueue: EditQueue;

    const baseConfig: GhulConfig = {
        compiler: ['dotnet', 'ghul-compiler'],
        arguments: ['-a', 'lib.dll'],
        source: [],
        block: false,
        incremental_analysis: false,
        want_plaintext_hover: false,
        missing_assemblies: [],
        problems: [],
    };

    // Each case gets its own workspace root: the abandoned-compiler registry
    // is keyed by it and lives for the module, so sharing one would let a
    // child left behind by an earlier case be reaped inside a later one.
    function makeManager(workspace_root: string): ServerManager {
        const created = new ServerManager(
            configEvents,
            serverEvents,
            editQueue,
            responseHandler,
            { reset: jest.fn(), handleChunk: jest.fn() } as unknown as ResponseParser,
            watchdog,
            workspace_root,
            () => `${workspace_root}/analysis.rsp`,
            { window: { showErrorMessage: jest.fn(), showWarningMessage: jest.fn() } } as any,
        );

        created.ghul_config = { ...baseConfig };

        return created;
    }

    beforeEach(() => {
        jest.useFakeTimers();

        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();
        watchdog = new Watchdog(10000, () => {});
        editQueue = { reset: jest.fn() } as unknown as EditQueue;

        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        (writeFileSync as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());

        manager = makeManager('/test/workspace/idle');
    });

    afterEach(() => {
        watchdog.clearWatchdog();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // The point of the idle exit: relaunching here would recompile the whole
    // project on a timer for a user who is not at the keyboard.
    it('goes dormant on an announced idle exit rather than relaunching', () => {
        manager.start();
        const spawnsAfterStart = (spawn as jest.Mock).mock.calls.length;

        manager.noteIdleExit();
        manager.child!.emit('exit', 0, null);

        expect(manager.state()).toBe(ServerState.Dormant);
        expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsAfterStart);

        // Nothing scheduled either — a back-off relaunch would defeat it just
        // as surely as an immediate one.
        jest.advanceTimersByTime(120000);
        expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsAfterStart);
    });

    it('does not spend the crash budget on an idle exit', () => {
        manager.start();

        manager.noteIdleExit();
        manager.child!.emit('exit', 0, null);

        expect(manager.restart_attempts).toBe(0);
    });

    it('relaunches when a request needs the compiler again', () => {
        manager.start();
        manager.noteIdleExit();
        manager.child!.emit('exit', 0, null);

        const spawnsWhileDormant = (spawn as jest.Mock).mock.calls.length;

        manager.ensureRunning();

        expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsWhileDormant + 1);
        expect(manager.state()).toBe(ServerState.StartingUp);
    });

    it('leaves a running compiler alone when a request arrives', () => {
        manager.start();
        manager.startListening();

        const spawnsBefore = (spawn as jest.Mock).mock.calls.length;

        manager.ensureRunning();

        expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsBefore);
    });

    // Blocked and Failed are deliberate not-running states; waking them here
    // would fight whatever put the manager there.
    it.each([
        ['Blocked', ServerState.Blocked],
        ['Failed', ServerState.Failed],
    ])('does not relaunch from %s', (_name, state) => {
        manager.start();
        manager.server_state = state;

        const spawnsBefore = (spawn as jest.Mock).mock.calls.length;

        manager.ensureRunning();

        expect((spawn as jest.Mock).mock.calls.length).toBe(spawnsBefore);
    });
});

describe('ServerManager (abandoned compiler reap)', () => {
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;

    const baseConfig: GhulConfig = {
        compiler: ['dotnet', 'ghul-compiler'],
        arguments: [],
        source: [],
        block: false,
        incremental_analysis: false,
        want_plaintext_hover: false,
        missing_assemblies: [],
        problems: [],
    };

    function makeManager(workspace_root: string): ServerManager {
        const created = new ServerManager(
            configEvents,
            serverEvents,
            { reset: jest.fn() } as unknown as EditQueue,
            responseHandler,
            { reset: jest.fn(), handleChunk: jest.fn() } as unknown as ResponseParser,
            watchdog,
            workspace_root,
            () => `${workspace_root}/analysis.rsp`,
            { window: { showErrorMessage: jest.fn(), showWarningMessage: jest.fn() } } as any,
        );

        created.ghul_config = { ...baseConfig };

        return created;
    }

    beforeEach(() => {
        jest.useFakeTimers();

        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();
        watchdog = new Watchdog(10000, () => {});

        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        (writeFileSync as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());
    });

    afterEach(() => {
        watchdog.clearWatchdog();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // The leak this closes: a replacement manager for the same workspace has
    // no handle to the child its predecessor left running, and the extension
    // host keeps that child's pipes open, so nothing else reaps it either.
    it('kills a compiler abandoned by an earlier manager for the same workspace', () => {
        const abandoned = makeFakeChild(1111);
        (spawn as jest.Mock).mockImplementationOnce(() => abandoned);

        const first = makeManager('/test/workspace/reap');
        first.start();

        // The predecessor goes away without exiting its child — a fresh
        // connection, not a relaunch, so nothing killed it.
        const second = makeManager('/test/workspace/reap');
        second.start();

        expect(abandoned.kill).toHaveBeenCalledTimes(1);
    });

    it('leaves another workspace\'s compiler running', () => {
        const other = makeFakeChild(2222);
        (spawn as jest.Mock).mockImplementationOnce(() => other);

        makeManager('/test/workspace/reap-mine').start();
        makeManager('/test/workspace/reap-theirs').start();

        expect(other.kill).not.toHaveBeenCalled();
    });

    it('does not kill a child that has already exited', () => {
        const exited = makeFakeChild(3333);
        (spawn as jest.Mock).mockImplementationOnce(() => exited);

        const first = makeManager('/test/workspace/reap-exited');
        first.start();

        first.expecting_exit = true;
        exited.emit('exit', 0, null);
        exited.kill.mockClear();

        makeManager('/test/workspace/reap-exited').start();

        expect(exited.kill).not.toHaveBeenCalled();
    });

    it('detaches an abandoned child\'s stdout before killing it', () => {
        const abandoned = makeFakeChild(4444);
        (spawn as jest.Mock).mockImplementationOnce(() => abandoned);

        const first = makeManager('/test/workspace/reap-stdout');
        const handleChunk = jest.fn();
        first.response_parser = { reset: jest.fn(), handleChunk } as unknown as ResponseParser;
        first.start();

        makeManager('/test/workspace/reap-stdout').start();

        abandoned.stdout.emit('data', Buffer.from('half a fra'));

        expect(handleChunk).not.toHaveBeenCalled();
    });
});

describe('ServerManager (announced exit that never happens)', () => {
    let manager: ServerManager;
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;

    beforeEach(() => {
        jest.useFakeTimers();

        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();
        watchdog = new Watchdog(10000, () => {});

        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        (writeFileSync as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());

        manager = new ServerManager(
            configEvents,
            serverEvents,
            { reset: jest.fn() } as unknown as EditQueue,
            responseHandler,
            { reset: jest.fn(), handleChunk: jest.fn() } as unknown as ResponseParser,
            watchdog,
            '/test/workspace/stale-intent',
            () => '/tmp/ghul-lsp-test/stale-intent.rsp',
            { window: { showErrorMessage: jest.fn(), showWarningMessage: jest.fn() } } as any,
        );

        manager.ghul_config = {
            compiler: ['dotnet', 'ghul-compiler'],
            arguments: [],
            source: [],
            block: false,
            incremental_analysis: false,
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        };
    });

    afterEach(() => {
        watchdog.clearWatchdog();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // A compiler can announce an exit and then be killed before it gets round
    // to exiting — a configuration change, say. The announcement described
    // that child, so it must not survive into the next one and disguise a
    // real crash as a planned exit.
    it.each([
        ['an idle exit', (m: ServerManager) => m.noteIdleExit()],
        ['a recycle', (m: ServerManager) => m.noteRecycle()],
    ])('does not carry %s announcement across a relaunch', (_name, announce) => {
        manager.start();

        announce(manager);

        // Relaunched for an unrelated reason before the announced exit lands.
        const announced_child = manager.child!;
        manager.start();
        announced_child.emit('exit', 0, null);

        // The replacement then crashes for a reason of its own.
        manager.child!.emit('exit', 1, null);

        expect(manager.state()).not.toBe(ServerState.Dormant);
        expect(manager.restart_attempts).toBe(1);
    });
});

describe('ServerManager (reaping does not disturb the predecessor)', () => {
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;

    // The reap tests above use makeFakeChild, whose kill() is inert. A real
    // child answers a kill with an 'exit' event, and it is that event — not
    // the kill — that runs the owning manager's crash recovery.
    function makeExitingFakeChild(pid: number) {
        const child: any = makeFakeChild(pid);

        child.kill = jest.fn(() => {
            child.exitCode = 1;
            child.emit('exit', null, 'SIGTERM');
        });

        return child;
    }

    function makeManager(workspace_root: string): ServerManager {
        const created = new ServerManager(
            configEvents,
            serverEvents,
            { reset: jest.fn() } as unknown as EditQueue,
            responseHandler,
            { reset: jest.fn(), handleChunk: jest.fn() } as unknown as ResponseParser,
            watchdog,
            workspace_root,
            () => `${workspace_root}/analysis.rsp`,
            { window: { showErrorMessage: jest.fn(), showWarningMessage: jest.fn() } } as any,
        );

        created.ghul_config = {
            compiler: ['dotnet', 'ghul-compiler'],
            arguments: [],
            source: [],
            block: false,
            incremental_analysis: false,
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        };

        return created;
    }

    beforeEach(() => {
        jest.useFakeTimers();

        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();
        watchdog = new Watchdog(10000, () => {});

        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        (writeFileSync as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());
    });

    afterEach(() => {
        watchdog.clearWatchdog();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // Left to react, the predecessor books the reap as a crash of its own,
    // relaunches at once, and reaps whatever is registered for the workspace
    // by then — which is the successor's healthy compiler.
    it('does not let the reaped child\'s owner resurrect itself and kill the replacement', () => {
        const abandoned = makeExitingFakeChild(1111);
        (spawn as jest.Mock).mockImplementationOnce(() => abandoned);

        const predecessor = makeManager('/test/workspace/reap-owner');
        predecessor.start();

        const successor_child = makeFakeChild(2222);
        (spawn as jest.Mock).mockImplementationOnce(() => successor_child);

        const successor = makeManager('/test/workspace/reap-owner');
        successor.start();

        // Whatever the predecessor's back-off would have done, it has had its
        // chance by now.
        jest.advanceTimersByTime(120000);

        expect(abandoned.kill).toHaveBeenCalledTimes(1);
        expect(successor_child.kill).not.toHaveBeenCalled();
        expect(successor.child).toBe(successor_child);
        expect(predecessor.restart_attempts).toBe(0);
    });
});

describe('ServerManager (a reap that goes wrong)', () => {
    let serverEvents: ServerEventEmitter;
    let configEvents: ConfigEventEmitter;
    let watchdog: Watchdog;
    let responseHandler: ResponseHandler;

    function makeManager(workspace_root: string): ServerManager {
        const created = new ServerManager(
            configEvents,
            serverEvents,
            { reset: jest.fn() } as unknown as EditQueue,
            responseHandler,
            { reset: jest.fn(), handleChunk: jest.fn() } as unknown as ResponseParser,
            watchdog,
            workspace_root,
            () => `${workspace_root}/analysis.rsp`,
            { window: { showErrorMessage: jest.fn(), showWarningMessage: jest.fn() } } as any,
        );

        created.ghul_config = {
            compiler: ['dotnet', 'ghul-compiler'],
            arguments: [],
            source: [],
            block: false,
            incremental_analysis: false,
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        };

        return created;
    }

    beforeEach(() => {
        jest.useFakeTimers();

        serverEvents = new ServerEventEmitter();
        configEvents = new ConfigEventEmitter();
        watchdog = new Watchdog(10000, () => {});

        responseHandler = {
            resolveAllPendingPromises: jest.fn(),
            rejectAllPendingPromises: jest.fn(),
        } as unknown as ResponseHandler;

        (writeFileSync as jest.Mock).mockClear();
        (spawn as jest.Mock).mockClear().mockImplementation(() => makeFakeChild());
    });

    afterEach(() => {
        watchdog.clearWatchdog();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // Killing can fail — the process is already gone, or the signal is
    // refused. Node throws an 'error' emitted with no listener attached, so
    // stripping the owner's handler without leaving one would turn a failed
    // reap into a crash of the language server serving every workspace.
    it('survives an abandoned child that errors while being killed', () => {
        const abandoned = makeFakeChild(1111);

        // Asynchronously, as Node does: a synchronous emit would be caught by
        // the try/catch around the kill and prove nothing.
        abandoned.kill = jest.fn(() => {
            setTimeout(() => abandoned.emit('error', new Error('kill EPERM')), 0);
        });

        (spawn as jest.Mock).mockImplementationOnce(() => abandoned);

        makeManager('/test/workspace/reap-error').start();

        const successor = makeManager('/test/workspace/reap-error');
        successor.start();

        expect(() => jest.runAllTimers()).not.toThrow();
        expect(successor.child).toBeTruthy();
    });
});
