import { execFile } from 'child_process';
import { log } from './log';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

// The local tool manifest that applies to a directory: the nearest
// .config/dotnet-tools.json in it or in an ancestor, which is where the .NET
// SDK looks, so a project in a subfolder of a repository whose manifest is at
// the repository root still has its tools restored. Undefined when there is
// none up to the filesystem root.
export function findDotNetToolsManifest(directory: string): string | undefined {
    let current = directory;

    for (;;) {
        const candidate = join(current, '.config', 'dotnet-tools.json');

        if (existsSync(candidate)) {
            return candidate;
        }

        const parent = dirname(current);

        if (parent === current) {
            return undefined;
        }

        current = parent;
    }
}

// Returns a human-readable problem description if the restore failed, or null
// on success / nothing-to-do. Never rejects: a broken manifest is a degraded
// load to be reported, not a reason to abandon the rest of the startup.
export function restoreDotNetTools(workspace: string, dotnet: string = "dotnet"): Promise<string | null> {
    const manifest = findDotNetToolsManifest(workspace);

    if (!manifest) {
        log("no .config/dotnet-tools.json found: won't attempt to restore .NET tools");
        return Promise.resolve(null);
    }

    const root = dirname(dirname(manifest));

    log("restoring .NET tools...");
    log(`using ${manifest}`);

    return new Promise(resolve => {
        execFile(dotnet, ["tool", "restore"], { cwd: root }, (error, stdout) => {
            if (error) {
                let problem = `could not restore .NET tools: ${error.message}`;
                log(problem);
                resolve(problem);
                return;
            }

            log(stdout);
            log("finished restoring .NET tools");
            resolve(null);
        });
    });
}
