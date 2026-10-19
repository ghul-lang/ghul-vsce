import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { LspClient } from './lsp-client';

// How the extension finds projects under what the user opens, against a real
// compiler as every test here does: a bare repository folder holding several
// projects, a workspace manifest naming them, a collection that holds
// independent programs, and the older shape of a workspace file listing each
// project as a folder of its own. A hover in each project's source has to be
// answered by that project's own analyser, which is the one thing none of
// these shapes may change.
//
// Needs `dotnet` on PATH, network access for tool restore, and the server
// built first (`npm run webpack` from the repo root).

const SERVER_PATH = join(__dirname, '..', 'out', 'server.js');
const FIXTURE = join(__dirname, 'fixtures', 'simple-project');

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

let root: string;

// A copy of the simple project at `relative`, whose one function is called
// `name` so a hover says which project answered it.
function project(relative: string, name: string) {
    const directory = join(root, relative);

    mkdirSync(join(directory, '..'), { recursive: true });
    cpSync(FIXTURE, directory, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });

    const source = join(directory, 'src', 'hello.ghul');

    writeFileSync(source, readFileSync(source, 'utf8').replace(/greet/g, name));
}

function sourceOf(relative: string): string {
    return join(root, relative, 'src', 'hello.ghul');
}

async function start(client: LspClient, folders: string[]) {
    await withDiagnostics(client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(folders[0]).toString(),
        workspaceFolders: folders.map(f => ({ uri: pathToFileURL(f).toString(), name: f })),
        capabilities: {
            window: { workDoneProgress: true },
            workspace: {
                didChangeWatchedFiles: { dynamicRegistration: true },
                workspaceFolders: true,
            },
        },
    }), client, 'initialize', 30000);

    client.notify('initialized', {});
}

function open(client: LspClient, path: string) {
    client.notify('textDocument/didOpen', {
        textDocument: {
            uri: pathToFileURL(path).toString(),
            languageId: 'ghul',
            version: 1,
            text: readFileSync(path, 'utf8'),
        },
    });
}

function hover(client: LspClient, path: string) {
    return withDiagnostics(client.request('textDocument/hover', {
        textDocument: { uri: pathToFileURL(path).toString() },
        position: { line: 2, character: 2 },
    }), client, `hover in ${path}`, 120000);
}

describe('where analysers run under what the user opens (no mocks, no VS Code)', () => {
    let client: LspClient;

    beforeAll(() => {
        if (!existsSync(SERVER_PATH)) {
            throw new Error(`${SERVER_PATH} does not exist — build it first: npm run webpack`);
        }
    });

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'ghul-roots-it-'));
    });

    afterEach(async () => {
        await client?.dispose();
        rmSync(root, { recursive: true, force: true });
    });

    it('analyses each project under a bare repository folder with its own analyser', async () => {
        project('alpha', 'greet_alpha');
        project('beta', 'greet_beta');

        client = new LspClient(SERVER_PATH, root);
        await start(client, [root]);

        open(client, sourceOf('alpha'));
        open(client, sourceOf('beta'));

        expect(JSON.stringify(await hover(client, sourceOf('alpha')))).toContain('greet_alpha');
        expect(JSON.stringify(await hover(client, sourceOf('beta')))).toContain('greet_beta');

        // The folder was never a project, so nothing was analysed as one.
        expect(client.logMessages.some(m => m.includes('no project of its own'))).toBe(true);
    });

    it('analyses the members a workspace manifest names', async () => {
        writeFileSync(join(root, 'ghul-project.json'), '{ "kind": "workspace", "members": ["alpha", "beta"] }');
        project('alpha', 'greet_alpha');
        project('beta', 'greet_beta');

        client = new LspClient(SERVER_PATH, root);
        await start(client, [root]);

        open(client, sourceOf('alpha'));
        open(client, sourceOf('beta'));

        expect(JSON.stringify(await hover(client, sourceOf('alpha')))).toContain('greet_alpha');
        expect(JSON.stringify(await hover(client, sourceOf('beta')))).toContain('greet_beta');
        expect(client.logMessages.some(m => m.includes('workspace'))).toBe(true);
    });

    it('does not analyse what a collection holds, and says why', async () => {
        writeFileSync(join(root, 'ghul-project.json'), '{ "kind": "collection" }');
        project('alpha', 'greet_alpha');

        client = new LspClient(SERVER_PATH, root);
        await start(client, [root]);

        open(client, sourceOf('alpha'));

        // Nothing owns the file, so there is nothing to answer a hover.
        const answer = await hover(client, sourceOf('alpha'));

        expect(answer == null || JSON.stringify(answer).includes('greet_alpha') === false).toBe(true);
        expect(client.logMessages.some(m => m.includes('collection of independent projects'))).toBe(true);
    });

    it('still analyses projects listed as the folders of a workspace file', async () => {
        project('alpha', 'greet_alpha');
        project('beta', 'greet_beta');

        client = new LspClient(SERVER_PATH, root);
        await start(client, [join(root, 'alpha'), join(root, 'beta')]);

        open(client, sourceOf('alpha'));
        open(client, sourceOf('beta'));

        expect(JSON.stringify(await hover(client, sourceOf('alpha')))).toContain('greet_alpha');
        expect(JSON.stringify(await hover(client, sourceOf('beta')))).toContain('greet_beta');
    });
});
