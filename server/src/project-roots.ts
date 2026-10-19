import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { globSync } from 'glob';

import { log } from './log';
import { MANIFEST, manifestKind } from './manifest-project';

// What a directory is to the extension. A project is analysed; a workspace
// owns no sources and lists the projects under it; a collection owns no
// sources and holds independent programs that are not analysed as one.
export type RootKind = 'project' | 'workspace' | 'collection';

// Directories the scan does not enter: build output, dependencies and version
// control, none of which holds a project the user is working on.
const IGNORED_DIRECTORIES = new Set(['bin', 'obj', 'out', 'node_modules']);

// Stops a scan of a very large tree, such as a home directory opened by
// mistake, from walking all of it.
const MAX_DIRECTORIES_VISITED = 50000;

export interface DiscoveredRoots {
    // How the folder itself was classified: a project is analysed as one, a
    // workspace or a collection is not a project, and 'none' is a folder with
    // no marker, which is not one either.
    self: RootKind | 'none';

    // Every project found under the folder, not including the folder itself.
    projects: string[];

    // Every collection found, which may include the folder itself.
    collections: string[];
}

interface Classified {
    kind: RootKind;
    members: string[];
}

// The kind a directory's marker gives it, or null when it has none. A
// directory holding a .ghulproj is a .ghulproj project whether or not it also
// holds a manifest, as isManifestProject decides. An unreadable manifest is a
// project: the ghul tool reports what is wrong with it, better than this can.
export function classify(directory: string): Classified | null {
    let entries: string[];

    try {
        entries = readdirSync(directory);
    } catch {
        return null;
    }

    if (entries.some(e => e.endsWith('.ghulproj'))) {
        return { kind: 'project', members: [] };
    }

    if (entries.includes(MANIFEST)) {
        return manifestKind(directory);
    }

    return null;
}

// A folder with no marker of its own but a ghul.json is still a project, as
// it was before manifests could say otherwise.
function isLegacyProject(directory: string): boolean {
    return existsSync(join(directory, 'ghul.json'));
}

// The directories a workspace's members name: each entry is a path or a glob
// relative to the workspace, and only directories count.
export function expandMembers(workspace: string, members: string[]): string[] {
    let found = new Set<string>();

    for (let member of members) {
        let pattern = member.replace(/\\/g, '/');

        try {
            for (let match of globSync(pattern, { cwd: workspace, absolute: true, ignore: ['**/node_modules/**'] })) {
                try {
                    if (statSync(match).isDirectory()) {
                        found.add(match);
                    }
                } catch {
                    // vanished between the glob and the stat
                }
            }
        } catch (e) {
            log(`could not expand workspace member ${member}: ${e}`);
        }
    }

    return Array.from(found).sort();
}

// Finds where analysers belong under an open folder, without descending into
// anything that is not part of one project: a collection is recorded and left
// alone, and a workspace's members replace a scan of what it holds.
//
// The folder itself is never returned as a project unless it is one: a
// workspace and a folder with no marker own no sources, so they get no
// analyser of their own.
export function discoverRoots(folder: string): DiscoveredRoots {
    let own = classify(folder);

    let result: DiscoveredRoots = { self: 'none', projects: [], collections: [] };

    if (own?.kind === 'collection') {
        result.self = 'collection';
        result.collections.push(folder);

        return result;
    }

    if (own?.kind === 'workspace') {
        result.self = 'workspace';
        result.projects.push(...expandMembers(folder, own.members));

        return result;
    }

    if (own?.kind === 'project' || isLegacyProject(folder)) {
        result.self = 'project';
    }

    scan(folder, result);

    return result;
}

// Every project and collection strictly under `start`. A project is scanned
// through, since a nested project is a project of its own; a collection is not
// entered.
function scan(start: string, result: DiscoveredRoots) {
    let visited = 0;
    let stack: string[] = [start];

    while (stack.length > 0) {
        let directory = stack.pop()!;

        let children: string[];

        try {
            children = readdirSync(directory, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
                .map(entry => entry.name)
                .filter(name => !name.startsWith('.') && !IGNORED_DIRECTORIES.has(name))
                .sort();
        } catch {
            continue;
        }

        for (let name of children) {
            if (++visited > MAX_DIRECTORIES_VISITED) {
                log(`stopped looking for ghūl projects under ${start} after ${MAX_DIRECTORIES_VISITED} directories`);
                return;
            }

            let child = join(directory, name);
            let found = classify(child);

            if (found?.kind === 'collection') {
                result.collections.push(child);
                continue;
            }

            if (found?.kind === 'workspace') {
                result.projects.push(...expandMembers(child, found.members));
                continue;
            }

            if (found?.kind === 'project') {
                result.projects.push(child);
            }

            stack.push(child);
        }
    }
}

// The directories strictly under `root` that belong to some other root, as
// globs relative to `root` that exclude their contents from root's own
// sources. Only the outermost of any nested group is needed, since excluding
// a directory excludes everything below it.
export function boundaryExcludes(root: string, others: Iterable<string>): string[] {
    let inside: string[] = [];

    for (let other of others) {
        let path = relative(root, other).replace(/\\/g, '/');

        if (path === '' || path.startsWith('..') || /^[A-Za-z]:/.test(path)) {
            continue;
        }

        inside.push(path);
    }

    inside.sort();

    let outermost: string[] = [];

    for (let path of inside) {
        if (!outermost.some(parent => path === parent || path.startsWith(parent + '/'))) {
            outermost.push(path);
        }
    }

    return outermost.map(path => `${path}/**`);
}
