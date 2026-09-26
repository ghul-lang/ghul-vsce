import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { GhulAnalyser } from '../src/ghul-analyser';
import { ConfigEventEmitter } from '../src/config-event-emitter';
import { ServerEventEmitter } from '../src/server-event-emitter';
import { EditQueue } from '../src/edit-queue';
import { GhulConfig } from '../src/ghul-config';

class RecordingEditQueue {
    started: Array<{ uri: string; source: string }[]> = [];
    open_files: string[][] = [];
    sendOpenFiles(uris: string[]) {
        this.open_files.push(uris);
    }
    start(documents: { uri: string; source: string }[]) {
        this.started.push(documents);
    }
}

// A stand-in for the LSP TextDocuments store: GhulAnalyser only calls .all().
function fakeDocuments(open: { uri: string; text: string }[] = []) {
    return {
        all: () => open.map(d => ({ uri: d.uri, getText: () => d.text })),
    } as unknown as TextDocuments<TextDocument>;
}

describe('GhulAnalyser', () => {
    let configEvents: ConfigEventEmitter;
    let serverEvents: ServerEventEmitter;
    let editQueue: RecordingEditQueue;
    let workspace: string;

    beforeEach(() => {
        configEvents = new ConfigEventEmitter();
        serverEvents = new ServerEventEmitter();
        editQueue = new RecordingEditQueue();
        workspace = mkdtempSync(join(tmpdir(), 'ghul-vsce-analyser-'));
    });

    afterEach(() => {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    it('captures config when configAvailable fires', () => {
        const analyser = new GhulAnalyser(
            editQueue as unknown as EditQueue,
            configEvents,
            serverEvents,
            fakeDocuments(),
        );

        const config: GhulConfig = {
            block: false,
            compiler: ['c'],
            source: ['x'],
            arguments: [],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        };
        configEvents.configAvailable(workspace, config);

        expect(analyser.workspace_root).toBe(workspace);
        expect(analyser.ghul_config).toBe(config);
    });

    it('starts edit queue with discovered .ghul files when listening fires', () => {
        // Lay down a few .ghul files plus a distractor:
        writeFileSync(join(workspace, 'a.ghul'), 'class A is {}');
        mkdirSync(join(workspace, 'sub'));
        writeFileSync(join(workspace, 'sub', 'b.ghul'), 'class B is {}');
        writeFileSync(join(workspace, 'sub', 'c.txt'), 'not ghul');

        // The analyser's only role here is to wire its listeners during
        // construction — we then drive it via the event emitters.
        new GhulAnalyser(
            editQueue as unknown as EditQueue,
            configEvents,
            serverEvents,
            fakeDocuments(),
        );

        configEvents.configAvailable(workspace, {
            block: false,
            compiler: ['c'],
            source: [`${workspace}/**/*.ghul`],
            arguments: [],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        });

        serverEvents.listening();

        expect(editQueue.started).toHaveLength(1);
        const uris = editQueue.started[0].map(d => d.uri).sort();
        expect(uris).toHaveLength(2);
        expect(uris[0]).toMatch(/a\.ghul$/);
        expect(uris[1]).toMatch(/b\.ghul$/);
        // Sources should be the file contents:
        expect(editQueue.started[0].find(d => d.uri.endsWith('a.ghul'))!.source).toBe('class A is {}');
    });

    it('leaves out files an exclude pattern matches', () => {
        mkdirSync(join(workspace, 'tasks', 'one'), { recursive: true });
        writeFileSync(join(workspace, 'tasks', 'one', 'one.ghul'), 'task');
        writeFileSync(join(workspace, 'tasks', 'one', 'stand-in.ghul'), 'stand-in');

        new GhulAnalyser(
            editQueue as unknown as EditQueue,
            configEvents,
            serverEvents,
            fakeDocuments(),
        );

        configEvents.configAvailable(workspace, {
            block: false,
            compiler: ['c'],
            source: ['tasks/**/*.ghul'],
            exclude: ['tasks/**/stand-in.ghul'],
            arguments: [],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        });

        serverEvents.listening();

        const uris = editQueue.started[0].map(d => d.uri);
        expect(uris).toHaveLength(1);
        expect(uris[0]).toMatch(/tasks\/one\/one\.ghul$/);
    });

    it('prefers an open editor buffer over the file on disk', () => {
        writeFileSync(join(workspace, 'a.ghul'), 'class A is {} // on disk');

        const uri = pathToFileURL(join(workspace, 'a.ghul')).toString();

        new GhulAnalyser(
            editQueue as unknown as EditQueue,
            configEvents,
            serverEvents,
            fakeDocuments([{ uri, text: 'class A is {} // unsaved buffer' }]),
        );

        configEvents.configAvailable(workspace, {
            block: false,
            compiler: ['c'],
            source: [`${workspace}/**/*.ghul`],
            arguments: [],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        });

        serverEvents.listening();

        expect(editQueue.started).toHaveLength(1);
        expect(editQueue.started[0]).toHaveLength(1);
        expect(editQueue.started[0][0].source).toBe('class A is {} // unsaved buffer');
    });

    it('resolves relative source patterns against workspace_root, not process.cwd', () => {
        // In a multi-root session each workspace has its own analyser but
        // shares the language server's process. globSync without an explicit
        // cwd would resolve every workspace's relative patterns against the
        // process cwd — typically the first-loaded workspace's root — and
        // feed every analyser the wrong source set.
        mkdirSync(join(workspace, 'src'));
        writeFileSync(join(workspace, 'src', 'real.ghul'), 'class Real is {}');

        const decoy = mkdtempSync(join(tmpdir(), 'ghul-vsce-decoy-'));
        try {
            mkdirSync(join(decoy, 'src'));
            writeFileSync(join(decoy, 'src', 'decoy.ghul'), 'class Decoy is {}');
            const originalCwd = process.cwd();
            process.chdir(decoy);
            try {
                new GhulAnalyser(
                    editQueue as unknown as EditQueue,
                    configEvents,
                    serverEvents,
                    fakeDocuments(),
                );

                configEvents.configAvailable(workspace, {
                    block: false,
                    compiler: ['c'],
                    source: ['src/**/*.ghul'],
                    arguments: [],
                    want_plaintext_hover: false,
                    incremental_analysis: false,
                    missing_assemblies: [],
                    problems: [],
                });

                serverEvents.listening();
            } finally {
                process.chdir(originalCwd);
            }

            expect(editQueue.started).toHaveLength(1);
            const uris = editQueue.started[0].map(d => d.uri);
            expect(uris).toHaveLength(1);
            expect(uris[0]).toMatch(/real\.ghul$/);
            expect(uris[0]).not.toMatch(/decoy\.ghul$/);
        } finally {
            try { rmSync(decoy, { recursive: true, force: true }); } catch { /* swallow */ }
        }
    });

    it('starts edit queue with an empty document list when no source files match', () => {
        new GhulAnalyser(
            editQueue as unknown as EditQueue,
            configEvents,
            serverEvents,
            fakeDocuments(),
        );

        configEvents.configAvailable(workspace, {
            block: false,
            compiler: ['c'],
            source: [`${workspace}/no-matches/**/*.ghul`],
            arguments: [],
            want_plaintext_hover: false,
            incremental_analysis: false,
            missing_assemblies: [],
            problems: [],
        });

        serverEvents.listening();

        expect(editQueue.started).toEqual([[]]);
    });
});
