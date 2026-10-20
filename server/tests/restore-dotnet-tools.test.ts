import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';

import { findDotNetToolsManifest, restoreDotNetTools } from '../src/restore-dotnet-tools';

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execFile: jest.fn((_command, _args, _options, callback) => callback(null, '', '')),
}));

describe('restoreDotNetTools', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'ghul-vsce-tools-'));
        (execFile as unknown as jest.Mock).mockClear();
    });

    afterEach(() => {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    it('runs dotnet tool restore in the workspace directory when the manifest exists', async () => {
        mkdirSync(join(workspace, '.config'));
        writeFileSync(join(workspace, '.config/dotnet-tools.json'), '{"version":1}');

        await expect(restoreDotNetTools(workspace)).resolves.toBeNull();

        expect(execFile).toHaveBeenCalledWith(
            'dotnet',
            ['tool', 'restore'],
            { cwd: workspace },
            expect.any(Function)
        );
    });

    it('does nothing when the manifest is missing', async () => {
        await expect(restoreDotNetTools(workspace)).resolves.toBeNull();

        expect(execFile).not.toHaveBeenCalled();
    });

    it('reports a failing restore rather than rejecting', async () => {
        mkdirSync(join(workspace, '.config'));
        writeFileSync(join(workspace, '.config/dotnet-tools.json'), '{"version":1}');

        (execFile as unknown as jest.Mock).mockImplementationOnce(
            (_command, _args, _options, callback) => callback(new Error('no such tool'), '', '')
        );

        await expect(restoreDotNetTools(workspace)).resolves.toContain('no such tool');
    });
});

describe('restoreDotNetTools with the manifest in an ancestor directory', () => {
    let root: string;
    let project: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'ghul-vsce-tools-up-'));
        project = join(root, 'cli');
        mkdirSync(project);
        (execFile as unknown as jest.Mock).mockClear();
    });

    afterEach(() => {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    it('restores from the repository root when the project is in a subfolder', async () => {
        mkdirSync(join(root, '.config'));
        writeFileSync(join(root, '.config/dotnet-tools.json'), '{"version":1}');

        await expect(restoreDotNetTools(project)).resolves.toBeNull();

        expect(execFile).toHaveBeenCalledWith(
            'dotnet',
            ['tool', 'restore'],
            { cwd: root },
            expect.any(Function)
        );
    });

    it('prefers the nearest manifest', async () => {
        mkdirSync(join(root, '.config'));
        writeFileSync(join(root, '.config/dotnet-tools.json'), '{"version":1}');
        mkdirSync(join(project, '.config'));
        writeFileSync(join(project, '.config/dotnet-tools.json'), '{"version":1}');

        await restoreDotNetTools(project);

        expect(execFile).toHaveBeenCalledWith(
            'dotnet',
            ['tool', 'restore'],
            { cwd: project },
            expect.any(Function)
        );
    });

    it('finds the manifest by walking up', () => {
        mkdirSync(join(root, '.config'));
        writeFileSync(join(root, '.config/dotnet-tools.json'), '{"version":1}');

        expect(findDotNetToolsManifest(project)).toBe(join(root, '.config', 'dotnet-tools.json'));
    });
});
