import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { LspClient } from './lsp-client';

// The pool of analysers against real compilers: restoring many tabs starts
// only what is visible, interactive use starts and evicts in least-recently-
// used order, and a visible project is never stopped. Each analyser is a real
// compiler process, so the tests count what the server logs about them.
//
// Needs `dotnet` on PATH, network access for tool restore, and the server
// built first (`npm run webpack` from the repo root).

const SERVER_PATH = join(__dirname, '..', 'out', 'server.js');
const FIXTURE = join(__dirname, 'fixtures', 'simple-project');

let root: string;

function project(name: string) {
    const directory = join(root, name);

    mkdirSync(root, { recursive: true });
    cpSync(FIXTURE, directory, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });

    const source = join(directory, 'src', 'hello.ghul');

    writeFileSync(source, readFileSync(source, 'utf8').replace(/greet/g, `greet_${name}`));
}

const source = (name: string) => join(root, name, 'src', 'hello.ghul');
const uri = (name: string) => pathToFileURL(source(name)).toString();

function within<T>(promise: Promise<T>, client: LspClient, step: string, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(
            () => reject(new Error(`${step} did not resolve within ${ms}ms.\nlogs:\n${client.logMessages.join('\n')}`)),
            ms
        ).unref()),
    ]);
}

function hover(client: LspClient, name: string) {
    return within(client.request('textDocument/hover', {
        textDocument: { uri: uri(name) },
        position: { line: 2, character: 2 },
    }), client, `hover in ${name}`, 150000);
}

function started(client: LspClient): string[] {
    return client.logMessages
        .filter(m => m.includes('pool: started'))
        .map(m => /pool: started .*[\\/](\w+) \(/.exec(m)![1]);
}

function evicted(client: LspClient): string[] {
    return client.logMessages
        .filter(m => m.includes('pool: evicted'))
        .map(m => /pool: evicted .*[\\/](\w+),/.exec(m)![1]);
}

describe('the analyser pool (no mocks, no VS Code)', () => {
    let client: LspClient;

    beforeAll(() => {
        if (!existsSync(SERVER_PATH)) {
            throw new Error(`${SERVER_PATH} does not exist — build it first: npm run webpack`);
        }
    });

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'ghul-pool-it-'));

        for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) {
            project(name);
        }

        client = new LspClient(SERVER_PATH, root);

        await within(client.request('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(root).toString(),
            workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: 'root' }],
            initializationOptions: { maxAnalysers: 2 },
            capabilities: {
                window: { workDoneProgress: true },
                workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, workspaceFolders: true },
            },
        }), client, 'initialize', 30000);

        client.notify('initialized', {});
    });

    afterEach(async () => {
        await client?.dispose();
        rmSync(root, { recursive: true, force: true });
    });

    it('restoring many tabs starts only the visible project, answers the rest empty, and stops nothing', async () => {
        client.notify('ghul/visibleDocuments', { uris: [uri('p1')] });

        for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) {
            client.notify('textDocument/didOpen', {
                textDocument: { uri: uri(name), languageId: 'ghul', version: 1, text: readFileSync(source(name), 'utf8') },
            });
        }

        // The passive views editors ask for on every restored tab.
        for (const name of ['p2', 'p3', 'p4', 'p5']) {
            const tokens = await within(client.request('textDocument/semanticTokens/full', {
                textDocument: { uri: uri(name) },
            }), client, `semantic tokens in ${name}`, 30000);
            const hints = await within(client.request('textDocument/inlayHint', {
                textDocument: { uri: uri(name) },
                range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            }), client, `inlay hints in ${name}`, 30000);

            expect(tokens == null || (tokens.data ?? []).length === 0).toBe(true);
            expect(hints == null || hints.length === 0).toBe(true);
        }

        expect(started(client)).toEqual(['p1']);
        expect(evicted(client)).toEqual([]);
    });

    it('stops the least recently used project first and never one with a visible editor', async () => {
        client.notify('ghul/visibleDocuments', { uris: [uri('p1')] });

        for (const name of ['p1', 'p2', 'p3']) {
            client.notify('textDocument/didOpen', {
                textDocument: { uri: uri(name), languageId: 'ghul', version: 1, text: readFileSync(source(name), 'utf8') },
            });
        }

        expect(JSON.stringify(await hover(client, 'p2'))).toContain('greet_p2');
        expect(JSON.stringify(await hover(client, 'p3'))).toContain('greet_p3');

        // p1 is visible, so p2 (the older interactive use) goes to make room for p3.
        expect(started(client)).toEqual(['p1', 'p2', 'p3']);
        expect(evicted(client)).toEqual(['p2']);

        // p3 becomes the visible one: p1 is no longer protected, and is the
        // oldest when p4 needs room.
        client.notify('ghul/visibleDocuments', { uris: [uri('p3')] });

        client.notify('textDocument/didOpen', {
            textDocument: { uri: uri('p4'), languageId: 'ghul', version: 1, text: readFileSync(source('p4'), 'utf8') },
        });

        expect(JSON.stringify(await hover(client, 'p4'))).toContain('greet_p4');

        expect(evicted(client)).toEqual(['p2', 'p1']);
        expect(evicted(client)).not.toContain('p3');
    });
});
