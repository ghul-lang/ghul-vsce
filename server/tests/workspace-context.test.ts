import { Connection, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { WorkspaceContext } from '../src/workspace-context';
import { GhulConfig } from '../src/ghul-config';

import * as GetGhulConfig from '../src/ghul-config';
import * as restoreDotNetTools from '../src/restore-dotnet-tools';
import * as generateAssembliesJson from '../src/generate-assemblies-json';
import * as generateGhulOptionsJson from '../src/generate-ghul-options-json';
import * as generateResponseFile from '../src/generate-response-file';

// initialize() fires configAvailable, which wakes the ServerManager and makes
// it write .analysis.rsp and spawn the compiler. We're not exercising that
// path here, so stub it out at the module boundary.
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    writeFileSync: jest.fn(),
}));

jest.mock('child_process', () => {
    // Required inside the factory rather than taken from the import above:
    // jest.mock is hoisted above the imports, so the import is not yet
    // initialised when this runs.
    const { EventEmitter: MockEventEmitter } = require('events');

    const fakeChild: any = new MockEventEmitter();
    fakeChild.pid = 1234;
    fakeChild.stdout = new MockEventEmitter();
    fakeChild.stderr = new MockEventEmitter();
    fakeChild.kill = jest.fn();
    return {
        ...jest.requireActual('child_process'),
        spawn: jest.fn(() => fakeChild),
    };
});

// WorkspaceContext is where per-workspace setup lives — the work that used to
// happen in ConnectionEventHandler.initialize(). These tests pin the ordering
// of the on-disk setup (so a fresh checkout doesn't fall back to a tiny
// default assembly list) and the surfacing of degraded-load warnings.

const progressReporter = {
    begin: jest.fn(),
    report: jest.fn(),
    done: jest.fn(),
};

function makeMockConnection(): Connection {
    return {
        window: {
            showErrorMessage: jest.fn(),
            showWarningMessage: jest.fn(),
            createWorkDoneProgress: jest.fn(() => Promise.resolve(progressReporter)),
        },
        workspace: {
            getConfiguration: jest.fn(() => Promise.resolve([null, null])),
        },
        // ResponseHandler's constructor subscribes to the config-event emitter
        // and otherwise uses Connection only for sendDiagnostics; the tests
        // here don't exercise that path, so an empty stub is enough.
        sendDiagnostics: jest.fn(),
    } as unknown as Connection;
}

function makeMockDocuments(): TextDocuments<TextDocument> {
    return {
        all: (): TextDocument[] => [],
    } as unknown as TextDocuments<TextDocument>;
}

describe('WorkspaceContext.initialize', () => {
    const WORKSPACE_ROOT = '/path/to/workspace';

    let connection: Connection;
    let documents: TextDocuments<TextDocument>;
    let context: WorkspaceContext;

    beforeEach(() => {
        progressReporter.begin.mockClear();
        progressReporter.report.mockClear();
        progressReporter.done.mockClear();

        connection = makeMockConnection();
        documents = makeMockDocuments();
        context = new WorkspaceContext(WORKSPACE_ROOT, connection, documents);
    });

    afterEach(() => {
        // The constructor created a Watchdog. If a test armed it, clear it so
        // the timer can't fire into a torn-down test and crash the worker.
        context.watchdog.clearWatchdog();
        jest.restoreAllMocks();
    });

    it('asks the editor for this folder\'s settings, scoped so a folder can override', async () => {
        // scopeUri is what makes a per-folder override work: without it every
        // folder in a multi-root workspace gets the same answer.
        const getGhulConfigSpy = jest.spyOn(GetGhulConfig, 'getGhulConfig');
        stubConfig([]);
        context.client_supports_configuration = true;
        (connection.workspace.getConfiguration as jest.Mock)
            .mockResolvedValue([true, null, null, null, null]);

        await context.initialize();

        const [sections] = (connection.workspace.getConfiguration as jest.Mock).mock.calls[0];

        expect(sections).toEqual([
            { scopeUri: `file://${WORKSPACE_ROOT}`, section: 'ghul.incrementalAnalysis' },
            { scopeUri: `file://${WORKSPACE_ROOT}`, section: 'ghul.plaintextHover' },
            { scopeUri: `file://${WORKSPACE_ROOT}`, section: 'ghul.inlayHints.narrowing' },
            { scopeUri: `file://${WORKSPACE_ROOT}`, section: 'ghul.inlayHints.definitionVirtuality' },
            { scopeUri: `file://${WORKSPACE_ROOT}`, section: 'ghul.inlayHints.terminators' },
        ]);
        expect(getGhulConfigSpy).toHaveBeenCalledWith(WORKSPACE_ROOT, {
            incremental_analysis: true,
            want_plaintext_hover: null,
            inlay_narrowing: null,
            inlay_definition_virtuality: null,
            inlay_terminators: null,
        }, null, expect.any(String));
    });

    it('treats a client that cannot answer as no preference expressed', async () => {
        const getGhulConfigSpy = jest.spyOn(GetGhulConfig, 'getGhulConfig');
        stubConfig([]);
        context.client_supports_configuration = true;
        (connection.workspace.getConfiguration as jest.Mock)
            .mockRejectedValue(new Error('Unhandled method workspace/configuration'));

        await context.initialize();

        expect(getGhulConfigSpy).toHaveBeenCalledWith(WORKSPACE_ROOT, {}, null, expect.any(String));
        expect(context.config).toBeDefined();
    });

    it('does not ask a client that has not said it can answer', async () => {
        // Asking one that cannot is not a degraded read: the request is never
        // answered, and setup waiting on it never reaches the compiler.
        stubConfig([]);

        await context.initialize();

        expect(connection.workspace.getConfiguration).not.toHaveBeenCalled();
        expect(context.config).toBeDefined();
    });

    // A multi-root workspace constructs one of these per folder, ghūl project
    // or not, and most of them never spawn an analyser.
    it('makes no temporary directory until something needs one', () => {
        const { readdirSync } = jest.requireActual('fs');
        const { tmpdir } = jest.requireActual('os');

        const before = readdirSync(tmpdir()).filter((n: string) => n.startsWith('ghul-lsp-')).length;

        new WorkspaceContext(WORKSPACE_ROOT, connection, documents);

        const after = readdirSync(tmpdir()).filter((n: string) => n.startsWith('ghul-lsp-')).length;

        expect(after).toBe(before);
    });

    it('resolves the project into a response file and reads the config from it', async () => {
        // The build writes the options and the references together; nothing
        // reads the two JSON files that used to carry them separately.
        // fs is mocked at the module boundary above, so the real functions
        // have to be reached for explicitly to leave a file the code under
        // test can actually find.
        const { existsSync, writeFileSync } = jest.requireActual('fs');

        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        const generateResponseFileSpy = jest.spyOn(generateResponseFile, 'generateResponseFile')
            .mockImplementation(async (_workspace, response_file) => {
                writeFileSync(response_file, '-a /path/to/A.dll\n');
                return null;
            });
        const generateAssembliesJsonSpy = jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        const generateGhulOptionsJsonSpy = jest.spyOn(generateGhulOptionsJson, 'generateGhulOptionsJson').mockResolvedValue(undefined);
        const getGhulConfigSpy = jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig);

        await context.initialize();

        expect(generateResponseFileSpy).toHaveBeenCalledWith(WORKSPACE_ROOT, expect.any(String), expect.any(String));
        expect(generateAssembliesJsonSpy).not.toHaveBeenCalled();
        expect(generateGhulOptionsJsonSpy).not.toHaveBeenCalled();

        const response_file = generateResponseFileSpy.mock.calls[0][1];
        const [, , passed] = getGhulConfigSpy.mock.calls[0];

        expect(passed).toBe(response_file);
        expect(getGhulConfigSpy.mock.calls[0][3]).toBe(generateResponseFileSpy.mock.calls[0][2]);

        // It is written outside the project, so nothing accumulates in the
        // checkout, and it goes away with the workspace that owns it.
        expect(response_file.startsWith(WORKSPACE_ROOT)).toBe(false);
        expect(existsSync(response_file)).toBe(true);

        context.dispose();

        expect(existsSync(response_file)).toBe(false);
    });

    it('generates .assemblies.json before reading it via getGhulConfig', async () => {
        // getGhulConfig builds the -a argument list from .assemblies.json,
        // which is written by generateAssembliesJson. If the read runs first
        // on a fresh checkout where the file does not yet exist, .analysis.rsp
        // ends up empty and the analyser falls back to a tiny default
        // assembly list — producing spurious "not defined" / "not found"
        // diagnostics for any reference outside that list.
        const restoreDotNetToolsSpy = jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        const generateAssembliesJsonSpy = jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        const getGhulConfigSpy = jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig);

        await context.initialize();

        const restoreOrder = restoreDotNetToolsSpy.mock.invocationCallOrder[0];
        const generateOrder = generateAssembliesJsonSpy.mock.invocationCallOrder[0];
        const configOrder = getGhulConfigSpy.mock.invocationCallOrder[0];

        expect(restoreOrder).toBeLessThan(generateOrder);
        expect(generateOrder).toBeLessThan(configOrder);
        expect(restoreDotNetToolsSpy).toHaveBeenCalledWith(WORKSPACE_ROOT);
        expect(generateAssembliesJsonSpy).toHaveBeenCalledWith(WORKSPACE_ROOT);
        expect(getGhulConfigSpy).toHaveBeenCalledWith(WORKSPACE_ROOT, expect.anything(), null, expect.any(String));
    });

    it('generates .ghul-options.json before reading it via getGhulConfig', async () => {
        // Same ordering requirement as .assemblies.json above: getGhulConfig
        // reads .ghul-options.json if generateGhulOptionsJson wrote one.
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        const generateGhulOptionsJsonSpy = jest.spyOn(generateGhulOptionsJson, 'generateGhulOptionsJson').mockResolvedValue(undefined);
        const getGhulConfigSpy = jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig);

        await context.initialize();

        const generateOrder = generateGhulOptionsJsonSpy.mock.invocationCallOrder[0];
        const configOrder = getGhulConfigSpy.mock.invocationCallOrder[0];

        expect(generateOrder).toBeLessThan(configOrder);
        expect(generateGhulOptionsJsonSpy).toHaveBeenCalledWith(WORKSPACE_ROOT);
    });

    it('surfaces a warning when the config loaded with problems but is still runnable', async () => {
        // A degraded load — e.g. a malformed .assemblies.json — still has a
        // usable compiler, so analysis proceeds but the user is told why it
        // may be incomplete.
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: ['could not load .assemblies.json: unexpected token'],
        } as GhulConfig);

        await context.initialize();

        expect(connection.window.showWarningMessage).toHaveBeenCalledTimes(1);
        const [message] = (connection.window.showWarningMessage as jest.Mock).mock.calls[0];
        expect(message).toContain('.assemblies.json');
    });

    it('does not warn when the config loaded cleanly', async () => {
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig);

        await context.initialize();

        expect(connection.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('creates a DocumentChangeTracker whose globs are anchored under the workspace root', async () => {
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: ['ghul'],
            source: ['./src/**/*.ghul', './lib/**/*.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig);

        await context.initialize();

        expect(context.document_change_tracker.globs).toEqual([
            `${WORKSPACE_ROOT}/src/**/*.ghul`,
            `${WORKSPACE_ROOT}/lib/**/*.ghul`,
        ]);
    });

    it('fires configAvailable with the workspace root and loaded config', async () => {
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        const config = {
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: [],
        } as GhulConfig;
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue(config);

        const configAvailableSpy = jest.spyOn(context.config_event_emitter, 'configAvailable');

        await context.initialize();

        expect(configAvailableSpy).toHaveBeenCalledWith(WORKSPACE_ROOT, config);
    });

    // Setup is detached from whatever asked for it and awaits several
    // promises on the way through, so its effects land over a handful of
    // microtask turns rather than on the next one.
    async function settle() {
        for (let turn = 0; turn < 10; turn++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function stubConfig(missing_assemblies: string[]): GhulConfig {
        const config = {
            compiler: ['ghul'],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies,
            problems: [],
        } as GhulConfig;

        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue(config);

        return config;
    }

    // A tree whose referenced projects have never been built — a fresh clone,
    // a Codespace — is where setup can be made to run several times over for
    // one event: the build we start produces the very assembly we asked the
    // client to watch for, so its completion and the watch fire separately
    // for the same news.
    describe('on a tree whose referenced assemblies are yet to be built', () => {
        const LIB = '/path/to/workspace/lib/bin/Debug/net10.0/lib.dll';

        beforeEach(() => {
            // The change tracker debounces its re-initialize by five seconds;
            // waiting that out for real would put five seconds on the suite.
            // setImmediate stays real so awaiting the promises setup is built
            // from still works.
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        function makeRegisterableConnection(): Connection {
            const connection = makeMockConnection();

            (connection as any).client = {
                register: jest.fn(() => Promise.resolve({ dispose: jest.fn() })),
            };

            return connection;
        }

        it('watches for an assembly the setup build failed to produce', async () => {
            // Setup builds the references, so one still absent here is a
            // failed build. Nothing will produce it without the user acting,
            // and it arriving by some other route — them fixing the project
            // and building in a terminal — is worth watching for.
            connection = makeRegisterableConnection();
            context = new WorkspaceContext(WORKSPACE_ROOT, connection, documents);

            stubConfig([LIB]);

            await context.initialize();
            await settle();

            expect((connection as any).client.register).toHaveBeenCalledTimes(1);
        });

        it('sets up once on a tree whose references have never been built', async () => {
            // The sequence from a cold Codespace. Setup builds the references
            // before it reads them, so it starts one analyser, on the complete
            // reference set — no second pass, and no analyser thrown away and
            // started again from cold, each of which costs the user tens of
            // seconds.
            connection = makeRegisterableConnection();
            context = new WorkspaceContext(WORKSPACE_ROOT, connection, documents);

            const spawn = require('child_process').spawn as jest.Mock;
            spawn.mockClear();

            stubConfig([]);

            const restore = restoreDotNetTools.restoreDotNetTools as jest.Mock;
            const generate = generateAssembliesJson.generateAssembliesJson as jest.Mock;

            await context.initialize();
            await settle();

            jest.advanceTimersByTime(30_000);

            await settle();

            expect(restore).toHaveBeenCalledTimes(1);
            expect(generate).toHaveBeenCalledTimes(1);
            expect(spawn).toHaveBeenCalledTimes(1);
        });
    });

    it('warns when a referenced assembly is absent after the build', async () => {
        stubConfig(['/path/to/workspace/lib/bin/Debug/net10.0/lib.dll']);

        // The setup build ran and the assembly still is not there, so the user
        // now has to act, and the warning is what tells them the diagnostics
        // they are about to read are of an incomplete reference set.
        await context.initialize();

        await new Promise(resolve => setImmediate(resolve));

        expect(connection.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('analysis will be incomplete')
        );
    });

    it('reports progress through the setup the user would otherwise wait blind through', async () => {
        stubConfig([]);

        await context.initialize();

        expect(connection.window.createWorkDoneProgress).toHaveBeenCalled();
        expect(progressReporter.begin).toHaveBeenCalled();
        // The reporter is created asynchronously, so the messages reported
        // before it arrives are folded into its begin() rather than replayed
        // through report(); the sequence is the concatenation of the two.
        const messages = [
            ...progressReporter.begin.mock.calls.map(([, , message]) => message),
            ...progressReporter.report.mock.calls.map(([message]) => message),
        ];

        expect(messages).toContain('building project references');
        expect(messages).toContain('starting analyser');
        expect(messages[messages.length - 1]).toBe('starting analyser');
    });

    it('says what is being done, not what the extension is waiting for', async () => {
        stubConfig([]);

        await context.initialize();

        const messages = [
            ...progressReporter.begin.mock.calls.map(([, , message]) => message),
            ...progressReporter.report.mock.calls.map(([message]) => message),
        ];

        expect(messages).not.toContain('waiting for the compiler to analyse the project');
    });

    it('keeps progress open through the analyser\'s first compile, not just the setup before it', async () => {
        stubConfig([]);

        await context.initialize();

        // The setup phase is done, but the analyser has not compiled
        // anything yet, so the status bar must still be open.
        expect(progressReporter.done).not.toHaveBeenCalled();

        context.requester.analysed = true;

        // The wait on the first analysis is deliberately not awaited by
        // initialize(), so give its continuation a turn of the microtask
        // queue to run.
        await new Promise(resolve => setImmediate(resolve));

        expect(progressReporter.done).toHaveBeenCalled();
    });

    it('reports the start-up sequence again when the compiler is relaunched', async () => {
        // A recycle or a crash leaves the compiler with no project state, so
        // the user is back to waiting through a cold analysis — and must be
        // told so, exactly as on the first start.
        stubConfig([]);

        await context.initialize();

        context.requester.analysed = true;
        await new Promise(resolve => setImmediate(resolve));

        progressReporter.begin.mockClear();
        progressReporter.report.mockClear();
        progressReporter.done.mockClear();

        // 'listening' makes the analyser send the whole project down the
        // compiler's stdin; there is no compiler here, so stand one in.
        context.requester.stream = { write: () => { } };

        context.server_event_emitter.starting();
        context.server_event_emitter.listening();

        await new Promise(resolve => setImmediate(resolve));

        const messages = [
            ...progressReporter.begin.mock.calls.map(([, , message]) => message),
            ...progressReporter.report.mock.calls.map(([message]) => message),
        ];

        expect(messages).toContain('analysing project');
        expect(progressReporter.done).not.toHaveBeenCalled();
    });

    it('reports the whole sequence again when a project file change reloads the workspace', async () => {
        // Saving a .ghulproj / Directory.Build.props / dotnet-tools.json
        // re-runs the tool restore and the reference resolution and then
        // replaces the compiler, so the user faces the same wait as a cold
        // start and must be shown the same sequence.
        const config = stubConfig([]);

        await context.initialize();

        context.requester.analysed = true;
        await new Promise(resolve => setImmediate(resolve));

        expect(progressReporter.done).toHaveBeenCalled();

        progressReporter.begin.mockClear();
        progressReporter.report.mockClear();
        progressReporter.done.mockClear();

        // Only a configuration that has actually changed replaces the
        // compiler; see the test below for the unchanged case.
        (GetGhulConfig.getGhulConfig as jest.Mock)
            .mockReturnValue({ ...config, compiler: ['ghul', '--changed'] });

        context.reinitialize();

        // reinitialize() is detached, so let the setup it awaits complete.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        // 'listening' makes the analyser send the whole project down the
        // relaunched compiler's stdin; the stubbed child has none, so stand
        // one in. Set after the relaunch, which installs the stub child's
        // absent stdin over anything set before it.
        context.requester.stream = { write: () => { } };

        context.server_event_emitter.listening();

        const messages = [
            ...progressReporter.begin.mock.calls.map(([, , message]) => message),
            ...progressReporter.report.mock.calls.map(([message]) => message),
        ];

        expect(messages).toEqual([
            'restoring .NET tools',
            'building project references',
            'starting analyser',
            'analysing project',
        ]);
        expect(progressReporter.done).not.toHaveBeenCalled();
    });

    it('keeps the running compiler when the reloaded configuration is identical', async () => {
        // Setup runs again for all sorts of reasons that turn out to change
        // nothing. Replacing the analyser costs the user its warm state and a
        // full recompile before the next query can be answered, so an
        // identical configuration leaves the one that is running alone.
        stubConfig([]);

        await context.initialize();

        const spawn = require('child_process').spawn as jest.Mock;
        const spawns_before = spawn.mock.calls.length;

        context.reinitialize();

        await settle();

        expect(spawn.mock.calls.length).toBe(spawns_before);
    });

    it('does not report a compiler start that is never going to happen', async () => {
        // No compiler was resolved, so the spawn is abandoned the moment it
        // is attempted; a progress notification opened here would never close.
        jest.spyOn(restoreDotNetTools, 'restoreDotNetTools').mockResolvedValue(null);
        jest.spyOn(generateAssembliesJson, 'generateAssembliesJson').mockResolvedValue(null);
        jest.spyOn(GetGhulConfig, 'getGhulConfig').mockReturnValue({
            compiler: [],
            source: ['test.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            missing_assemblies: [],
            problems: ['no compiler'],
        } as GhulConfig);

        await context.initialize();
        await new Promise(resolve => setImmediate(resolve));

        expect(progressReporter.done).toHaveBeenCalled();
    });

    it('sets up without progress on a client that cannot report it', async () => {
        stubConfig([]);

        (connection.window as any).createWorkDoneProgress = undefined;

        await context.initialize();

        expect(context.config).toBeDefined();
    });

    it('does not warn when every referenced assembly is present', async () => {
        stubConfig([]);

        await context.initialize();

        expect(connection.window.showWarningMessage).not.toHaveBeenCalled();
    });
});
