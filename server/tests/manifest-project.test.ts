import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile, spawnSync } from 'child_process';

import {
    generateManifestResponseFile,
    isManifestProject,
    manifestCompiler,
    firstListedTarget,
    responseFileTarget,
} from '../src/manifest-project';

// child_process.execFile and spawnSync are non-configurable in modern Node,
// so spyOn fails. Mock the whole module but pass through the rest:
jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execFile: jest.fn(),
    spawnSync: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;
const spawnSyncMock = spawnSync as unknown as jest.Mock;

describe('manifest projects', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'ghul-vsce-manifest-'));
        execFileMock.mockReset();
        spawnSyncMock.mockReset();
    });

    afterEach(() => {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    describe('isManifestProject', () => {
        it('is true for a folder holding a manifest and no .ghulproj', () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{}');

            expect(isManifestProject(workspace)).toBe(true);
        });

        // A folder holding both is a .ghulproj project: the manifest is only
        // read when the ghul tool is asked to build.
        it('is false when a .ghulproj sits beside the manifest', () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{}');
            writeFileSync(join(workspace, 'app.ghulproj'), '<Project/>');

            expect(isManifestProject(workspace)).toBe(false);
        });

        it('is false for a folder with no manifest', () => {
            expect(isManifestProject(workspace)).toBe(false);
        });
    });

    describe('firstListedTarget', () => {
        it('is null when the manifest lists a single target', () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{ "targets": ["wasm"] }');

            expect(firstListedTarget(workspace)).toBeNull();
        });

        it('is the first listed when the manifest lists several', () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{ "targets": ["wasm", "dotnet"] }');

            expect(firstListedTarget(workspace)).toBe('wasm');
        });

        it('reads a manifest with comments and trailing commas', () => {
            writeFileSync(join(workspace, 'ghul-project.json'),
                '{\n    // where it runs\n    "name": "a // b",\n    "targets": ["dotnet", "wasm",],\n}\n');

            expect(firstListedTarget(workspace)).toBe('dotnet');
        });

        it('is null when the manifest cannot be read', () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{ not json');

            expect(firstListedTarget(workspace)).toBeNull();
        });
    });

    describe('responseFileTarget', () => {
        it('is the target the response file names', () => {
            let response_file = join(workspace, 'project.rsp');

            writeFileSync(response_file, '--target llvm\n--define llvm\n');

            expect(responseFileTarget(response_file)).toBe('llvm');
        });

        it('is dotnet when the response file names none', () => {
            let response_file = join(workspace, 'project.rsp');

            writeFileSync(response_file, '--reference\nSystem.Runtime.dll\n');

            expect(responseFileTarget(response_file)).toBe('dotnet');
        });

        it('is null when there is no response file', () => {
            expect(responseFileTarget(join(workspace, 'missing.rsp'))).toBeNull();
        });
    });

    describe('generateManifestResponseFile', () => {
        it('asks ghul for both files, leaving it to choose the target', async () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{ "targets": ["wasm", "dotnet"] }');

            let response_file = join(workspace, 'project.rsp');
            let globs_file = join(workspace, 'source-globs.txt');

            execFileMock.mockImplementation((_command, _args, _options, callback) => {
                writeFileSync(response_file, '--target wasm\n');
                callback(null, '', '');
            });

            await expect(generateManifestResponseFile(workspace, response_file, globs_file)).resolves.toBeNull();

            expect(execFileMock).toHaveBeenCalledWith(
                'ghul',
                ['project', 'response-file', '--output', response_file, '--source-globs', globs_file],
                { cwd: workspace },
                expect.any(Function)
            );
        });

        it('names the first target to a ghul too old to choose between several', async () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{ "targets": ["wasm", "dotnet"] }');

            let response_file = join(workspace, 'project.rsp');
            let globs_file = join(workspace, 'source-globs.txt');

            execFileMock.mockImplementation((_command, args: string[], _options, callback) => {
                if (!args.includes('--target')) {
                    callback(new Error('exit 1'), '', 'ghul: the manifest lists more than one target; name one with --target: wasm, dotnet\n');
                    return;
                }

                writeFileSync(response_file, '--target wasm\n');
                callback(null, '', '');
            });

            await expect(generateManifestResponseFile(workspace, response_file, globs_file)).resolves.toBeNull();

            expect(execFileMock).toHaveBeenLastCalledWith(
                'ghul',
                ['project', 'response-file', '--output', response_file, '--source-globs', globs_file, '--target', 'wasm'],
                { cwd: workspace },
                expect.any(Function)
            );
        });

        it('says the ghul tool is needed when it is not on the PATH', async () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{}');

            execFileMock.mockImplementation((_command, _args, _options, callback) => {
                callback(Object.assign(new Error('spawn ghul ENOENT'), { code: 'ENOENT' }), '', '');
            });

            let problem = await generateManifestResponseFile(workspace, join(workspace, 'r'), join(workspace, 'g'));

            expect(problem).toContain('the ghul command-line tool is needed');
        });

        it("reports ghul's own complaint about the manifest", async () => {
            writeFileSync(join(workspace, 'ghul-project.json'), '{}');

            execFileMock.mockImplementation((_command, _args, _options, callback) => {
                callback(new Error('exit 1'), '', 'ghul-project.json: unknown key "sorces"\n');
            });

            let problem = await generateManifestResponseFile(workspace, join(workspace, 'r'), join(workspace, 'g'));

            expect(problem).toContain('unknown key "sorces"');
        });
    });

    describe('manifestCompiler', () => {
        it('splits the command ghul prints into its arguments', () => {
            spawnSyncMock.mockReturnValue({ status: 0, stdout: 'dotnet "/home/a b/ghul.dll"\n', stderr: '' });

            expect(manifestCompiler(workspace)).toEqual({ compiler: ['dotnet', '/home/a b/ghul.dll'] });
        });

        it('says the ghul tool is needed when it is not on the PATH', () => {
            spawnSyncMock.mockReturnValue({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });

            expect(manifestCompiler(workspace).problem).toContain('the ghul command-line tool is needed');
        });
    });
});
