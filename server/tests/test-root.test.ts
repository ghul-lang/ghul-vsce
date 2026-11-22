import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { nearestTestRoot, testRootCompiler } from '../src/test-root';

let root: string;

function write(relative: string, text: string = '') {
    const path = join(root, relative);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}

describe('test roots', () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'ghul-test-root-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('finds the nearest directory holding test.json above a file', () => {
        write('tests/outer/test.json', '{}');
        write('tests/outer/inner/test.json', '{}');

        expect(nearestTestRoot(join(root, 'tests/outer/inner/test.ghul'), root)).toBe(join(root, 'tests/outer/inner'));
        expect(nearestTestRoot(join(root, 'tests/outer/test.ghul'), root)).toBe(join(root, 'tests/outer'));
    });

    it('finds none where there is no test.json between the file and the limit', () => {
        write('test.json', '{}');
        write('inner/src/main.ghul');

        expect(nearestTestRoot(join(root, 'inner/src/main.ghul'), join(root, 'inner'))).toBeNull();
    });

    it('takes the compiler from the default configuration, through what it extends', () => {
        write('ghul-test.json', `{
            // comments are allowed
            "default": "local",
            "configurations": {
                "base": { "compiler": { "publish": "publish" } },
                "local": { "extends": "base", },
            }
        }`);
        write('publish/ghul.dll');
        write('tests/hello/test.json', '{}');

        expect(testRootCompiler(join(root, 'tests/hello'))).toEqual(['dotnet', join(root, 'publish/ghul.dll')]);
    });

    it('runs a compiler path as ghul-test does', () => {
        write('compilers/ghul.mjs');
        write('ghul-test.json', '{ "default": "wasm", "configurations": { "wasm": { "compiler": { "path": "compilers/ghul.mjs" } } } }');

        expect(testRootCompiler(join(root, 'tests/hello'))).toEqual(['node', join(root, 'compilers/ghul.mjs')]);
    });

    it('leaves the tool, a compiler hosted outside .NET and a missing manifest to the usual search', () => {
        expect(testRootCompiler(join(root, 'tests/hello'))).toBeNull();

        write('ghul-test.json', '{ "default": "tool", "configurations": { "tool": { "compiler": "tool" } } }');
        expect(testRootCompiler(join(root, 'tests/hello'))).toBeNull();

        write('ghul', '');
        write('ghul-test.json', '{ "default": "native", "configurations": { "native": { "compiler": { "path": "ghul", "reference_assemblies": false } } } }');
        expect(testRootCompiler(join(root, 'tests/hello'))).toBeNull();
    });
});
