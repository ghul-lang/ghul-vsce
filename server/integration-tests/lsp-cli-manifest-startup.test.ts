import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import { LspClient } from './lsp-client';

// A ghul-project.json project has no .ghulproj: the ghul command-line tool
// writes the response file and source globs a .ghulproj build would, and
// names the compiler. CI has no ghul tool, so a stub on the PATH stands in
// for it, writing an empty response file and the manifest's source glob, so
// the project is analysed for .NET with no libraries, and naming the compiler
// from the fixture's tool manifest. The real tool writes a --target line and
// the libraries for a wasm or llvm target.
//
// Same requirements as the other tests in this tier: `dotnet` on PATH,
// network access for the tool restore, and the server built first.

const SERVER_PATH = join(__dirname, '..', 'out', 'server.js');
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'cli-manifest-project');
const SOURCE_PATH = join(FIXTURE_ROOT, 'src', 'broken.ghul');

const STUB = `#!/bin/sh
if [ "$1 $2" = "project response-file" ] ; then
    shift 2
    while [ $# -gt 0 ] ; do
        case "$1" in
            --output) : > "$2"; shift 2 ;;
            --source-globs) echo 'src/**/*.ghul' > "$2"; shift 2 ;;
            *) shift ;;
        esac
    done
elif [ "$1 $2" = "project compiler" ] ; then
    echo 'dotnet ghul-compiler'
else
    echo "unexpected: $*" >&2
    exit 1
fi
`;

function withDiagnostics<T>(promise: Promise<T>, client: LspClient, step: string, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(
            () => reject(new Error(
                `${step} did not resolve within ${ms}ms.\n` +
                `logs:\n${client.logMessages.join('\n')}\n` +
                `stderr:\n${client.stderr.join('')}`
            )),
            ms
        ).unref()),
    ]);
}

describe('start-up of a ghul-project.json project', () => {
    let stub_directory: string;

    beforeAll(() => {
        if (!existsSync(SERVER_PATH)) {
            throw new Error(
                `${SERVER_PATH} does not exist — build it first: ` +
                `npm run genversion && webpack --mode production --config ./server/webpack.config.js`
            );
        }

        stub_directory = mkdtempSync(join(tmpdir(), 'ghul-vsce-stub-'));
        writeFileSync(join(stub_directory, 'ghul'), STUB);
        chmodSync(join(stub_directory, 'ghul'), 0o755);

        // The extension restores nothing for a manifest project - the real
        // ghul tool installs the compiler it names - so the stub's compiler
        // has to be restored here.
        execFileSync('dotnet', ['tool', 'restore'], { cwd: FIXTURE_ROOT, stdio: 'ignore' });
    });

    afterAll(() => {
        rmSync(stub_directory, { recursive: true, force: true });
    });

    let client: LspClient;

    afterEach(async () => {
        await client?.dispose();
    });

    it('reports a source error found by the analyser ghul names', async () => {
        client = new LspClient(SERVER_PATH, FIXTURE_ROOT, {
            ...process.env,
            PATH: stub_directory + delimiter + (process.env.PATH ?? ''),
        });

        const uri = 'file://' + SOURCE_PATH;

        await withDiagnostics(client.request('initialize', {
            processId: process.pid,
            rootUri: 'file://' + FIXTURE_ROOT,
            workspaceFolders: [{ uri: 'file://' + FIXTURE_ROOT, name: 'fixture' }],
            capabilities: {
                window: { workDoneProgress: true },
                workspace: {
                    didChangeWatchedFiles: { dynamicRegistration: true },
                    workspaceFolders: true,
                },
            },
        }), client, 'initialize', 30000);

        client.notify('initialized', {});

        client.notify('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId: 'ghul',
                version: 1,
                text: readFileSync(SOURCE_PATH, 'utf8'),
            },
        });

        await client.waitForDiagnostics(
            uri,
            diagnostics => diagnostics.some(d => String(d.message).includes('not_declared_anywhere')),
            90000
        );
    });
});
