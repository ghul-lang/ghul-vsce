import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { restoreDotNetTools } from '../src/restore-dotnet-tools';

// Runs the restore as a real process: a `dotnet` on the PATH that records where
// and with what it was run, with the tool manifest at the repository root and
// the project in a subfolder, as in a fresh clone of ghul-cli.
const describeOnUnix = process.platform === 'win32' ? describe.skip : describe;

describeOnUnix('restoreDotNetTools run for real', () => {
    let root: string;
    let stub: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'ghul-vsce-tools-process-'));
        stub = join(root, 'dotnet');

        writeFileSync(stub, `#!/bin/sh\necho "$PWD $@" > "${join(root, 'ran.txt')}"\n`);
        chmodSync(stub, 0o755);
    });

    afterEach(() => {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* swallow */ }
    });

    it('restores the tools of a manifest at the repository root for a project in a subfolder', async () => {
        mkdirSync(join(root, '.config'));
        writeFileSync(join(root, '.config/dotnet-tools.json'), '{"version":1,"isRoot":true,"tools":{}}');
        mkdirSync(join(root, 'cli'));

        await expect(restoreDotNetTools(join(root, 'cli'), stub)).resolves.toBeNull();

        expect(readFileSync(join(root, 'ran.txt'), 'utf-8').trim()).toBe(`${root} tool restore`);
    });
});
