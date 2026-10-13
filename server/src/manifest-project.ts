import { execFile, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { parse } from 'shell-quote';

import { log } from './log';

// A project described by a ghul-project.json manifest rather than a .ghulproj.
// The ghul command-line tool reads the manifest; the extension never builds
// one, and gets everything it needs from two of the tool's commands:
//
//     ghul project response-file --output <path> --source-globs <path>
//     ghul project compiler
//
// which give the same response file and source globs file a .ghulproj build
// writes, and the command that runs the compiler the project builds with.

export const MANIFEST = 'ghul-project.json';
export const LOCKFILE = 'ghul-project.lock.json';

const COMMAND = 'ghul';

// A folder holding a .ghulproj is a .ghulproj project whether or not it also
// holds a manifest: the manifest is only read when the ghul tool is asked to
// build.
export function isManifestProject(workspace: string): boolean {
    let entries: string[];

    try {
        entries = readdirSync(workspace);
    } catch {
        return false;
    }

    return entries.includes(MANIFEST) && !entries.some(e => e.endsWith('.ghulproj'));
}

// The manifest allows // comments and trailing commas, which JSON.parse does
// not. Strings are copied through untouched, so a // inside one survives.
function withoutCommentsOrTrailingCommas(text: string): string {
    let result = '';
    let i = 0;

    while (i < text.length) {
        let c = text[i];

        if (c === '"') {
            let end = i + 1;

            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1;
            }

            result += text.slice(i, end + 1);
            i = end + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
        } else {
            result += c;
            i++;
        }
    }

    return result.replace(/,(\s*[}\]])/g, '$1');
}

// The first target the manifest lists where it lists more than one, for a
// ghul tool that will not choose between several itself; null otherwise, and
// when the manifest cannot be read, which the tool reports better than this
// could.
export function firstListedTarget(workspace: string): string | null {
    try {
        let text = readFileSync(join(workspace, MANIFEST), 'utf-8').replace(/^﻿/, '');
        let targets = JSON.parse(withoutCommentsOrTrailingCommas(text))?.targets;

        if (Array.isArray(targets) && targets.length > 1 && typeof targets[0] === 'string') {
            return targets[0];
        }
    } catch {
        // reported by the ghul tool when it reads the same manifest
    }

    return null;
}

function describeFailure(what: string, e: unknown, stderr?: string): string {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return `the ghul command-line tool is needed to open a ${MANIFEST} project, and was not found`;
    }

    let detail = stderr?.trim() || (e instanceof Error ? e.message : String(e));

    return `could not ${what} for ${MANIFEST}: ${detail}`;
}

// What an older ghul tool says when a manifest lists several targets and
// none is named. A current one chooses for itself.
const SEVERAL_TARGETS = 'the manifest lists more than one target';

// The target a response file is for: the one its --target line names, or
// dotnet, for which a response file names none. Null where the file cannot
// be read.
export function responseFileTarget(response_file: string): string | null {
    let text: string;

    try {
        text = readFileSync(response_file, 'utf-8');
    } catch {
        return null;
    }

    let named = /^\s*--target\s+(\S+)/m.exec(text);

    return named ? named[1] : 'dotnet';
}

// Writes the response file and the source globs file for a manifest project.
// Resolves to a problem to report, or null; never rejects.
export function generateManifestResponseFile(
    workspace: string,
    response_file: string,
    source_globs_file: string
): Promise<string | null> {
    // So that whether each file is there afterwards says whether this run
    // wrote it, rather than whether some earlier one did.
    rmSync(response_file, { force: true });
    rmSync(source_globs_file, { force: true });

    let args = ['project', 'response-file', '--output', response_file, '--source-globs', source_globs_file];

    // The tool chooses the target as a build would: GHUL_TARGET, then the
    // manifest's preference, then what the machine can build. A tool too old
    // to choose is asked for the first target listed instead.
    let run = (with_args: string[], retry: boolean): Promise<string | null> => new Promise(resolve => {
        log(`resolving compiler options with '${COMMAND} ${with_args.join(' ')}'...`);

        execFile(COMMAND, with_args, { cwd: workspace }, (error, _stdout, stderr) => {
            if (error) {
                let first = retry && stderr?.includes(SEVERAL_TARGETS) ? process.env.GHUL_TARGET || firstListedTarget(workspace) : null;

                if (first) {
                    resolve(run([...with_args, '--target', first], false));
                    return;
                }

                let problem = describeFailure('resolve the compiler options', error, stderr);
                log(problem);
                resolve(problem);
                return;
            }

            if (!existsSync(response_file)) {
                resolve(`${COMMAND} wrote no response file for ${MANIFEST}`);
                return;
            }

            log(`analysing for the ${responseFileTarget(response_file)} target`);
            resolve(null);
        });
    });

    return run(args, true);
}

// The command that runs the compiler the project builds with. Asked at every
// setup rather than kept: with no compiler named in the manifest it is the
// newest installed, so it can change when a compiler is installed.
export function manifestCompiler(workspace: string): { compiler?: string[], problem?: string } {
    let result = spawnSync(COMMAND, ['project', 'compiler'], { encoding: 'utf-8', cwd: workspace });

    if (result.error || result.status !== 0) {
        return { problem: describeFailure('find the compiler', result.error ?? new Error(`exit status ${result.status}`), result.stderr) };
    }

    let line = result.stdout.split(/\r?\n/).find(l => l.trim().length > 0);

    if (!line) {
        return { problem: `${COMMAND} named no compiler for ${MANIFEST}` };
    }

    let compiler = parse(line.trim()).map(e => e.toString());

    log(`will use compiler '${line.trim()}' named by ${COMMAND}`);

    return { compiler };
}
