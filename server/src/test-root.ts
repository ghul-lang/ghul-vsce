import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import { parse } from 'shell-quote';

import { log } from './log';
import { withoutCommentsOrTrailingCommas } from './manifest-project';

// The file that makes a directory a ghul-test test, and so a project of its
// own to the extension: its sources are the test's, analysed apart from any
// project around it.
export const TEST_SETTINGS = 'test.json';

// The ghul-test manifest, at or above a test, naming the configurations a run
// can use and the one it uses by default.
export const TEST_MANIFEST = 'ghul-test.json';

export function isTestRoot(directory: string): boolean {
    return existsSync(join(directory, TEST_SETTINGS));
}

// The nearest directory holding a test settings file, from the directory
// `file` is in up to `limit` and no higher, or null where there is none.
export function nearestTestRoot(file: string, limit: string): string | null {
    let directory = dirname(file);

    while (true) {
        const from_limit = relative(limit, directory);

        if (from_limit.startsWith('..') || /^[A-Za-z]:/.test(from_limit)) {
            return null;
        }

        if (isTestRoot(directory)) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory || from_limit === '') {
            return null;
        }

        directory = parent;
    }
}

function findManifest(start: string): string | null {
    let directory = start;

    while (true) {
        const candidate = join(directory, TEST_MANIFEST);

        if (existsSync(candidate)) {
            return candidate;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return null;
        }

        directory = parent;
    }
}

// The compiler ghul-test builds the tests under `root` with by default: the
// `compiler` of the default configuration in the nearest ghul-test.json at or
// above it, or of the nearest configuration it extends that names one. Null
// where that names the tool manifest's compiler, a compiler hosted outside
// .NET, or nothing usable, so the usual search applies.
export function testRootCompiler(root: string): string[] | null {
    const manifest = findManifest(root);

    if (!manifest) {
        return null;
    }

    let document: any;

    try {
        document = JSON.parse(withoutCommentsOrTrailingCommas(readFileSync(manifest, 'utf-8').replace(/^﻿/, '')));
    } catch (e) {
        log(`could not read ${manifest} for the compiler of the test at ${root}: ${e}`);
        return null;
    }

    const configurations = document?.configurations;
    let name: unknown = document?.default;
    const seen = new Set<string>();

    while (typeof name === 'string' && configurations && typeof configurations[name] === 'object' && !seen.has(name)) {
        seen.add(name);

        const entry = configurations[name];

        if (entry.compiler !== undefined) {
            return compilerCommand(entry.compiler, dirname(manifest), manifest, name);
        }

        name = entry.extends;
    }

    return null;
}

function compilerCommand(compiler: any, base: string, manifest: string, name: string): string[] | null {
    if (typeof compiler !== 'object' || compiler === null || compiler.reference_assemblies === false) {
        return null;
    }

    let command: string[] | null = null;

    if (typeof compiler.publish === 'string') {
        const dll = resolve(base, compiler.publish, 'ghul.dll');

        command = existsSync(dll) ? ['dotnet', dll] : null;
    } else if (typeof compiler.path === 'string') {
        const path = resolve(base, compiler.path);

        if (existsSync(path)) {
            command =
                path.endsWith('.dll') ? ['dotnet', path] :
                path.endsWith('.mjs') ? ['node', path] :
                [path];
        }
    } else if (typeof compiler.command === 'string') {
        command = parse(compiler.command).map(word => word.toString());
    }

    if (command) {
        log(`the ${name} configuration in ${manifest} builds tests with '${command.join(' ')}'`);
    }

    return command;
}
