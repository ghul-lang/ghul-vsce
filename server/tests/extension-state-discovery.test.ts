import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { ExtensionState } from '../src/extension-state';

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
