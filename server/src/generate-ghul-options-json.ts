import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import { log } from './log';

const COMMAND = "dotnet";

// GenerateGhulOptionsJson ships in ghul.runtime 14.1.0+'s build targets
// (ghul-lang/ghul#2090) and writes the compiler flags the build actually
// resolved — conditions applied, properties evaluated — to
// .ghul-options.json. As with GenerateAssembliesJson, an explicit -t: stops
// short of CoreCompile: nothing here compiles the analysed project.
const ARGUMENTS = ["build", "-verbosity:minimal", "-t:GenerateGhulOptionsJson"];

function hasProject(workspace: string): boolean {
    let files: string[];

    try {
        files = readdirSync(workspace);
    } catch (e) {
        log(`could not read ${workspace}: cannot generate .ghul-options.json`);
        return false;
    }

    if (!files.find(file => file.endsWith(".ghulproj"))) {
        log("no .ghulproj found: cannot generate .ghul-options.json");
        return false;
    }

    return true;
}

// Build just enough of the project to resolve GenerateGhulOptionsJson.
// Best-effort and never surfaced as a load-time problem: a project still
// referencing a ghul.runtime older than 14.1.0 has no such target, and that
// is the ordinary case for most existing projects rather than something
// broken — getGhulConfig falls back to hand-parsing the .ghulproj when
// .ghul-options.json never appears.
export function generateGhulOptionsJson(workspace: string): Promise<void> {
    if (!hasProject(workspace)) {
        return Promise.resolve();
    }

    log("resolving compiler options...");

    return new Promise(resolve => {
        execFile(COMMAND, ARGUMENTS, { cwd: workspace }, (error, stdout) => {
            if (error) {
                log(`could not generate .ghul-options.json (falling back to hand-parsed .ghulproj options): ${error.message}`);
            } else {
                log(stdout);
                log("finished resolving compiler options");
            }

            resolve();
        });
    });
}
