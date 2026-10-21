import { execFile } from 'child_process';
import { readdirSync, rmSync } from 'fs';

import { log } from './log';

const COMMAND = "dotnet";

// GenerateGhulResponseFile ships in ghul.runtime 14.3.0+'s build targets
// (ghul-lang/ghul#2132) and writes what the build resolved — the compiler options
// with their conditions applied, and one -a flag per reference — as
// response-file text, which is the form the compiler wants anyway. It replaces
// GenerateAssembliesJson and GenerateGhulOptionsJson, which carried the same
// two things as JSON for a reader that then had to turn them back into flags.
//
// An explicit -t: replaces the default target, so this runs that target and
// the chain it depends on — FindReferenceAssembliesForReferences,
// ResolveReferences, ResolveProjectReferences — and stops there. CoreCompile is
// not in that chain, so the project being analysed is resolved but never
// compiled, which is what we want: the analyser reads that project's sources
// itself and has no use for its output assembly.
//
// ResolveProjectReferences does build each referenced project, and that is
// also what we want. A reference is only ever visible to the analyser as
// metadata it reflects over, so an assembly that is absent or out of date is
// not a slower start-up, it is the wrong answer: the analyser reports symbols
// added since the last build as not found, and nothing downstream can tell
// that from the truth.
function argumentsFor(response_file: string, source_globs_file: string): string[] {
    return [
        "build",
        "-verbosity:minimal",
        "-t:GenerateGhulResponseFile",
        `-p:GhulResponseFile=${response_file}`,
        `-p:GhulSourceGlobsFile=${source_globs_file}`
    ];
}

function describeFailure(e: unknown): string {
    return `could not resolve the project's references and options — ` +
        `the ghūl project may be missing or invalid: ` +
        `${e instanceof Error ? e.message : String(e)}`;
}

function hasProject(workspace: string): boolean {
    let files: string[];

    try {
        files = readdirSync(workspace);
    } catch (e) {
        log(`could not read ${workspace}: cannot build references or resolve options`);
        return false;
    }

    if (!files.find(file => file.endsWith(".ghulproj"))) {
        log("no .ghulproj found: cannot build references or resolve options");
        return false;
    }

    return true;
}

// Build the referenced projects and write the resolved options and reference
// paths to response_file, and this project's source globs - the patterns, as
// written rather than as expanded - to source_globs_file. Returns a
// human-readable problem description if that failed, or null on success /
// nothing-to-do. Never rejects: a broken .ghulproj is a degraded load to be
// reported, not a reason to abandon the rest of the startup.
//
// The caller decides what a run that reports no problem but leaves no file
// behind means — on a project pinned to a ghul.runtime older than 14.3.0 it
// means the target is not there, which is ordinary rather than broken. The
// globs file is separately absent on a runtime older than 14.4.0, and on one
// whose GhulSources declarations are all conditional, which the target
// deliberately does not try to evaluate.
export function generateResponseFile(
    workspace: string,
    response_file: string,
    source_globs_file: string
): Promise<string | null> {
    if (!hasProject(workspace)) {
        return Promise.resolve(null);
    }

    // So that whether each file is there afterwards says whether this run
    // wrote it, rather than whether some earlier one did.
    rmSync(response_file, { force: true });
    rmSync(source_globs_file, { force: true });

    log("building project references and resolving compiler options...");

    return new Promise(resolve => {
        execFile(COMMAND, argumentsFor(response_file, source_globs_file), { cwd: workspace }, (error, stdout) => {
            if (error) {
                let problem = describeFailure(error);
                log(problem);
                resolve(problem);
                return;
            }

            log(stdout);
            log("finished building project references and resolving compiler options");
            resolve(null);
        });
    });
}
