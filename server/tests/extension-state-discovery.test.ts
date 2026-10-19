import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { ExtensionState, Use } from '../src/extension-state';

// A WorkspaceContext stands up a compiler's worth of machinery, so the
// registry is exercised against one that only remembers what it was told.
jest.mock('../src/workspace-context', () => ({
    WorkspaceContext: jest.fn().mockImplementation((workspace_root: string) => {
        const context: any = {
            workspace_root,
            started: false,
            boundary_excludes: [] as string[],
            client_supports_configuration: false,
            response_handler: {},
            claimsSourceFile: () => true,
            initializeDetached: jest.fn(() => { context.started = true; }),
            reinitialize: jest.fn(),
            dispose: jest.fn(),
        };

        return context;
    }),
}));

let root: string;

function write(relative: string, text: string = '') {
    const path = join(root, relative);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}

function project(relative: string) {
    write(join(relative, 'ghul-project.json'), '{ "name": "p" }');
}

function uri(relative: string): string {
    return pathToFileURL(join(root, relative)).toString();
}

describe('ExtensionState discovery', () => {
    let state: ExtensionState;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'ghul-state-'));
        state = ExtensionState.getInstance();
        state.reset();
        (state as any).connection = { window: { showInformationMessage: jest.fn() } };
    });

    afterEach(() => {
        state.reset();
        rmSync(root, { recursive: true, force: true });
    });

    it('does not make a bare repository folder an analyser root, and starts nothing until a file opens', () => {
        project('cli');
        project('project');

        const own = state.addFolder(root);

        expect(own).toBeNull();
        expect(state.allWorkspaces()).toEqual([]);
    });

    it('starts the project a file belongs to when it is asked about, and only that one', () => {
        project('cli');
        project('project');

        state.addFolder(root);

        const workspace = state.getWorkspaceForUri(uri('cli/src/main.ghul'));

        expect(workspace?.workspace_root).toBe(join(root, 'cli'));
        expect(workspace?.started).toBe(true);
        expect(state.allWorkspaces().map(w => w.workspace_root)).toEqual([join(root, 'cli')]);
    });

    it('does not start a project for a watched-file event', () => {
        project('cli');

        state.addFolder(root);

        expect(state.getWorkspaceForUri(uri('cli/src/main.ghul'), false)).toBeNull();
        expect(state.allWorkspaces()).toEqual([]);
    });

    it('returns an open folder that is a project, to be started by the caller', () => {
        project('.');

        const own = state.addFolder(root);

        expect(own?.workspace_root).toBe(root);
        expect(state.allWorkspaces()).toHaveLength(1);
    });

    it('bounds a project at the projects nested in it', () => {
        project('.');
        project('unit-tests');

        const own = state.addFolder(root)!;

        expect(own.boundary_excludes).toEqual(['unit-tests/**']);
    });

    it('routes a file in a nested project to it, not to the enclosing one', () => {
        project('.');
        project('unit-tests');

        state.addFolder(root);

        expect(state.getWorkspaceForUri(uri('unit-tests/t.ghul'))?.workspace_root).toBe(join(root, 'unit-tests'));
    });

    it('gives a file under a collection to no workspace, and says so once', () => {
        write('tests/ghul-project.json', '{ "kind": "collection" }');
        write('tests/one/a.ghul');

        state.addFolder(root);

        expect(state.getWorkspaceForUri(uri('tests/one/a.ghul'))).toBeNull();
        expect(state.getWorkspaceForUri(uri('tests/one/b.ghul'))).toBeNull();

        const shown = (state as any).connection.window.showInformationMessage as jest.Mock;

        expect(shown).toHaveBeenCalledTimes(1);
        expect(shown.mock.calls[0][0]).toContain('collection');
    });

    it('analyses a project inside a collection when that project is itself a root', () => {
        write('tests/ghul-project.json', '{ "kind": "collection" }');
        project('src');

        state.addFolder(root);
        state.addFolder(join(root, 'tests'));

        expect(state.getWorkspaceForUri(uri('src/a.ghul'))?.workspace_root).toBe(join(root, 'src'));
    });

    it('starts the members of a workspace manifest and not the folder itself', () => {
        write('ghul-project.json', '{ "kind": "workspace", "members": ["cli", "tools/*"] }');
        project('cli');
        project('tools/lint');

        expect(state.addFolder(root)).toBeNull();
        expect(state.getWorkspaceForUri(uri('tools/lint/x.ghul'))?.workspace_root).toBe(join(root, 'tools', 'lint'));
    });

    it('stops what was started under a folder when the folder is removed', () => {
        project('cli');

        state.addFolder(root);
        state.getWorkspaceForUri(uri('cli/a.ghul'));

        expect(state.allWorkspaces()).toHaveLength(1);

        state.removeFolder(root);

        expect(state.allWorkspaces()).toEqual([]);
        expect(state.getWorkspaceForUri(uri('cli/a.ghul'))).toBeNull();
    });

    it('picks up a project added after the folder was opened', () => {
        state.addFolder(root);

        expect(state.getWorkspaceForUri(uri('new/a.ghul'))).toBeNull();

        project('new');
        state.rediscover();

        expect(state.getWorkspaceForUri(uri('new/a.ghul'))?.workspace_root).toBe(join(root, 'new'));
    });
});

describe('ExtensionState pool', () => {
    let state: ExtensionState;
    let clock: jest.SpyInstance;

    function projects(names: string[]) {
        names.forEach(name => project(name));
    }

    function started(): string[] {
        return state.allWorkspaces().map(w => w.workspace_root.slice(root.length + 1)).sort();
    }

    beforeEach(() => {
        let tick = 0;

        clock = jest.spyOn(Date, 'now').mockImplementation(() => ++tick);

        root = mkdtempSync(join(tmpdir(), 'ghul-pool-'));
        state = ExtensionState.getInstance();
        state.reset();
        (state as any).connection = { window: { showInformationMessage: jest.fn() }, sendNotification: jest.fn() };
    });

    afterEach(() => {
        clock.mockRestore();
        state.reset();
        rmSync(root, { recursive: true, force: true });
    });

    it('does not start a project for a passive request on a document nobody can see', () => {
        projects(['a', 'b']);
        state.addFolder(root);
        state.setVisibleDocuments([uri('a/x.ghul')]);

        expect(state.getWorkspaceForUri(uri('b/x.ghul'), Use.PASSIVE)).toBeNull();
        expect(started()).toEqual(['a']);
    });

    it('starts a project for a passive request on a visible document', () => {
        projects(['a', 'b']);
        state.addFolder(root);
        state.setVisibleDocuments([uri('b/x.ghul')]);

        expect(started()).toEqual(['b']);
    });

    it('treats every open document as visible for a client that never says', () => {
        projects(['a']);
        state.addFolder(root);

        expect(state.getWorkspaceForUri(uri('a/x.ghul'), Use.PASSIVE)?.workspace_root).toBe(join(root, 'a'));
    });

    it('restoring many tabs starts no more analysers than are visible', () => {
        projects(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
        state.addFolder(root);
        state.setMaxAnalysers(2);
        state.setVisibleDocuments([uri('p1/x.ghul')]);

        for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
            state.getWorkspaceForUri(uri(`${p}/x.ghul`), Use.PASSIVE);
        }

        expect(started()).toEqual(['p1']);
    });

    it('stops the least recently used interactive project when the cap is reached', () => {
        projects(['a', 'b', 'c']);
        state.addFolder(root);
        state.setMaxAnalysers(2);
        state.setVisibleDocuments([]);

        state.getWorkspaceForUri(uri('a/x.ghul'));
        state.getWorkspaceForUri(uri('b/x.ghul'));
        state.getWorkspaceForUri(uri('a/x.ghul'));
        state.getWorkspaceForUri(uri('c/x.ghul'));

        expect(started()).toEqual(['a', 'c']);
    });

    it('never stops a project with a visible editor, even over the cap', () => {
        projects(['a', 'b', 'c']);
        state.addFolder(root);
        state.setMaxAnalysers(1);
        state.setVisibleDocuments([uri('a/x.ghul'), uri('b/x.ghul')]);

        state.getWorkspaceForUri(uri('c/x.ghul'));

        expect(started()).toEqual(['a', 'b', 'c']);

        state.setVisibleDocuments([uri('a/x.ghul')]);

        expect(started()).toEqual(['a']);
    });

    it('lowering the cap stops the surplus at once', () => {
        projects(['a', 'b', 'c']);
        state.addFolder(root);
        state.setVisibleDocuments([]);
        state.getWorkspaceForUri(uri('a/x.ghul'));
        state.getWorkspaceForUri(uri('b/x.ghul'));
        state.getWorkspaceForUri(uri('c/x.ghul'));

        state.setMaxAnalysers(1);

        expect(started()).toEqual(['c']);
    });

    it('starts a stopped project again on its next interactive use', () => {
        projects(['a', 'b']);
        state.addFolder(root);
        state.setMaxAnalysers(1);
        state.setVisibleDocuments([]);

        state.getWorkspaceForUri(uri('a/x.ghul'));
        state.getWorkspaceForUri(uri('b/x.ghul'));

        expect(started()).toEqual(['b']);

        state.getWorkspaceForUri(uri('a/x.ghul'));

        expect(started()).toEqual(['a']);
    });
});
