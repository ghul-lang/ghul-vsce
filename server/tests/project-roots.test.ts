import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { boundaryExcludes, classify, discoverRoots } from '../src/project-roots';

let root: string;

function write(relative: string, text: string = '') {
    const path = join(root, relative);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}

function project(relative: string) {
    write(join(relative, 'ghul-project.json'), '{ "name": "p" }');
}

function relativeTo(paths: string[]): string[] {
    return paths.map(p => p.slice(root.length + 1)).sort();
}

describe('classify', () => {
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ghul-roots-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('answers null for a directory with no marker', () => {
        expect(classify(root)).toBeNull();
    });

    it('reads a .ghulproj as a project, even beside a manifest', () => {
        write('a.ghulproj', '<Project />');
        write('ghul-project.json', '{ "kind": "collection" }');

        expect(classify(root)?.kind).toBe('project');
    });

    it('reads a manifest with no kind, and one that cannot be read, as a project', () => {
        write('ghul-project.json', '{ "name": "p" }');
        expect(classify(root)?.kind).toBe('project');

        write('ghul-project.json', '{ not json');
        expect(classify(root)?.kind).toBe('project');
    });

    it('reads the kinds a manifest can carry, with comments and trailing commas', () => {
        write('ghul-project.json', '{ // note\n "kind": "workspace", "members": ["a", "b/*",], }');
        expect(classify(root)).toEqual({ kind: 'workspace', members: ['a', 'b/*'] });

        write('ghul-project.json', '{ "kind": "collection" }');
        expect(classify(root)?.kind).toBe('collection');
    });
});

describe('discoverRoots', () => {
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ghul-roots-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('finds several projects under a bare repository folder, which is not a root itself', () => {
        project('cli');
        project('tools/lint');
        write('docs/readme.md');

        const found = discoverRoots(root);

        expect(found.self).toBe('none');
        expect(relativeTo(found.projects)).toEqual(['cli', 'tools/lint']);
        expect(found.collections).toEqual([]);
    });

    it('is a project itself when its own marker says so, and still finds the projects nested in it', () => {
        project('.');
        project('unit-tests');

        const found = discoverRoots(root);

        expect(found.self).toBe('project');
        expect(relativeTo(found.projects)).toEqual(['unit-tests']);
    });

    it('treats a folder with only a legacy ghul.json as a project', () => {
        write('ghul.json', '{}');

        expect(discoverRoots(root).self).toBe('project');
    });

    it('takes a workspace manifest\'s members and does not scan', () => {
        write('ghul-project.json', '{ "kind": "workspace", "members": ["cli", "tools/*"] }');
        project('cli');
        project('tools/a');
        project('tools/b');
        project('other');

        const found = discoverRoots(root);

        expect(found.self).toBe('workspace');
        expect(relativeTo(found.projects)).toEqual(['cli', 'tools/a', 'tools/b']);
    });

    it('records a collection and does not descend into it', () => {
        write('tests/ghul-project.json', '{ "kind": "collection" }');
        project('tests/one');
        project('tests/two');
        project('src');

        const found = discoverRoots(root);

        expect(relativeTo(found.collections)).toEqual(['tests']);
        expect(relativeTo(found.projects)).toEqual(['src']);
    });

    it('is a collection itself when its own manifest says so, with nothing else found', () => {
        write('ghul-project.json', '{ "kind": "collection" }');
        project('one');

        const found = discoverRoots(root);

        expect(found.self).toBe('collection');
        expect(found.collections).toEqual([root]);
        expect(found.projects).toEqual([]);
    });

    it('does not enter build output, dependencies or hidden directories', () => {
        project('bin/hidden');
        project('obj/hidden');
        project('node_modules/dep');
        project('.git/x');
        project('real');

        expect(relativeTo(discoverRoots(root).projects)).toEqual(['real']);
    });
});

describe('boundaryExcludes', () => {
    it('excludes the roots inside a root and ignores the rest', () => {
        expect(boundaryExcludes('/r', ['/r', '/r/tests', '/elsewhere', '/r2/x'])).toEqual(['tests/**']);
    });

    it('keeps only the outermost of a nested group', () => {
        expect(boundaryExcludes('/r', ['/r/tests/a', '/r/tests', '/r/tools'])).toEqual(['tests/**', 'tools/**']);
    });

    it('does not mistake a sibling with a shared prefix for a nested root', () => {
        expect(boundaryExcludes('/r/a', ['/r/ab'])).toEqual([]);
    });
});
