import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getGhulConfig } from '../src/ghul-config';

// Real fs is used here intentionally: per workspace convention, prefer real
// collaborators over mocks. We carve out a tmpdir per test, write fixture
// files, and assert against the parsed result.

function makeWorkspace(): string {
    return mkdtempSync(join(tmpdir(), 'ghul-vsce-cfg-'));
}

function writeJson(workspace: string, name: string, value: unknown) {
    writeFileSync(join(workspace, name), JSON.stringify(value));
}

describe('getGhulConfig', () => {
    let workspaces: string[];

    beforeEach(() => {
        workspaces = [];
    });

    afterEach(() => {
        for (const w of workspaces) {
            try { rmSync(w, { recursive: true, force: true }); } catch { /* swallow */ }
        }
    });

    function ws(): string {
        const w = makeWorkspace();
        workspaces.push(w);
        return w;
    }

    it('reads nothing from a ghul.json', () => {
        const workspace = ws();
        writeJson(workspace, 'ghul.json', {
            compiler: ['from-json'],
            source: ['from-json'],
            other_flags: ['--json-flag'],
        });

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, { compiler: ['from-host'] });

        expect(cfg.compiler).toEqual(['from-host']);
        expect(cfg.source).toEqual(['./**/*.ghul']);
        expect(cfg.arguments).toEqual(['-A', '--incremental-analysis']);
        expect(cfg.problems).toEqual([]);
    });

    it('returns sane defaults for an empty workspace (no project, no tools)', () => {
        const workspace = ws();
        const cfg = getGhulConfig(workspace);

        expect(cfg.block).toBe(false);
        expect(cfg.source).toEqual(['./**/*.ghul']);
        expect(cfg.want_plaintext_hover).toBe(false);
        // -A is always appended:
        expect(cfg.arguments).toContain('-A');
    });

    it('respects block = true when .block-compiler exists', () => {
        const workspace = ws();
        writeFileSync(join(workspace, '.block-compiler'), '');

        const cfg = getGhulConfig(workspace);
        expect(cfg.block).toBe(true);
    });

    it('uses the compiler and flags a host names when the workspace names neither', () => {
        const workspace = ws();

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, {
            compiler: 'dotnet /opt/ghul.dll',
            flags: ['--target', 'wasm'],
        });

        expect(cfg.compiler).toEqual(['dotnet', '/opt/ghul.dll']);
        expect(cfg.arguments).toEqual(['--target', 'wasm', '-A', '--incremental-analysis']);
    });

    it('passes the references a host names, for a workspace with no .assemblies.json', () => {
        const workspace = ws();

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, { references: ['/r/a.dll', '/r/b.dll'] });

        expect(cfg.arguments).toEqual(['-a', '/r/a.dll', '-a', '/r/b.dll', '-A', '--incremental-analysis']);
    });

    it("prefers an .assemblies.json to the host's references, and takes none for a .ghulproj project", () => {
        const with_json = ws();
        writeJson(with_json, '.assemblies.json', { assemblies: [] });

        expect(getGhulConfig(with_json, {}, null, null, undefined, { references: ['/r/a.dll'] }).arguments)
            .not.toContain('/r/a.dll');

        const with_project = ws();
        writeFileSync(join(with_project, 'p.ghulproj'), '<Project></Project>');

        expect(getGhulConfig(with_project, {}, null, null, undefined, { references: ['/r/a.dll'] }).arguments)
            .not.toContain('/r/a.dll');
    });

    it("prefers a tool manifest's compiler to the host's", () => {
        const workspace = ws();
        mkdirSync(join(workspace, '.config'));
        writeJson(join(workspace, '.config'), 'dotnet-tools.json', {
            version: 1,
            isRoot: true,
            tools: { 'ghul.compiler': { version: '1.0.0', commands: ['ghul-compiler'] } },
        });

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, { compiler: ['from-host'] });

        expect(cfg.compiler).toEqual(['dotnet', 'tool', 'run', 'ghul-compiler']);
    });

    it("prefers a .ghulproj's compiler to the host's, and takes no flags from the host", () => {
        const workspace = ws();
        writeFileSync(join(workspace, 'p.ghulproj'),
            '<Project><PropertyGroup><GhulCompiler>from-project</GhulCompiler></PropertyGroup></Project>');

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, {
            compiler: ['from-host'],
            flags: ['--host-flag'],
        });

        expect(cfg.compiler).toEqual(['from-project']);
        expect(cfg.arguments).not.toContain('--host-flag');
    });

    it("takes no flags from the host for a ghul-project.json project", () => {
        const workspace = ws();

        const cfg = getGhulConfig(workspace, {}, null, null, ['from-manifest'], {
            compiler: ['from-host'],
            flags: ['--host-flag'],
        });

        expect(cfg.compiler).toEqual(['from-manifest']);
        expect(cfg.arguments).not.toContain('--host-flag');
    });

    it('reads compiler from .config/dotnet-tools.json when no other source has set it', () => {
        const workspace = ws();
        mkdirSync(join(workspace, '.config'));
        writeJson(workspace, '.config/dotnet-tools.json', {
            version: 1,
            isRoot: true,
            tools: {
                'ghul.compiler': {
                    version: '0.6.30',
                    commands: ['ghul-compiler'],
                },
            },
        });

        const cfg = getGhulConfig(workspace);
        expect(cfg.compiler).toEqual(['dotnet', 'tool', 'run', 'ghul-compiler']);
    });

    it('appends -a entries from .assemblies.json', () => {
        const workspace = ws();

        const a = join(workspace, 'A.dll');
        const b = join(workspace, 'B.dll');

        writeFileSync(a, '');
        writeFileSync(b, '');

        writeJson(workspace, '.assemblies.json', { assemblies: [a, b] });

        const cfg = getGhulConfig(workspace);
        expect(cfg.arguments).toEqual([
            '-a', a,
            '-a', b,

'-A',
                '--incremental-analysis',
            ]);
        expect(cfg.missing_assemblies).toEqual([]);
    });

    it('withholds -a entries for assemblies that do not exist yet', () => {
        // The output of a referenced project is named in .assemblies.json
        // before anything builds it. The analyser reads every -a path eagerly
        // and dies on the first one it cannot open, so an absent assembly has
        // to be left out and reported instead.
        const workspace = ws();

        const present = join(workspace, 'Present.dll');

        writeFileSync(present, '');

        const absent = join(workspace, 'bin', 'Absent.dll');

        writeJson(workspace, '.assemblies.json', { assemblies: [present, absent] });

        const cfg = getGhulConfig(workspace);
        expect(cfg.arguments).toEqual(['-a', present, '-A', '--incremental-analysis']);
        expect(cfg.missing_assemblies).toEqual([absent]);
    });

    it('produces just ["-A"] when no .assemblies.json is present (bug-trigger for #69)', () => {
        // On a fresh checkout .assemblies.json does not yet exist; if
        // getGhulConfig runs before generateAssembliesJson, this is the
        // state .analysis.rsp gets serialised from. server-manager then
        // spawns the analyser with no -a flags and it falls back to a
        // five-assembly default list. Pin the shape so a future change
        // does not silently start fabricating fake `-a` entries (or
        // dropping `-A` from the empty case).
        const workspace = ws();
        // No .assemblies.json on disk.

        const cfg = getGhulConfig(workspace);
        expect(cfg.arguments).toEqual(['-A', '--incremental-analysis']);
    });

    describe('the source globs the build publishes', () => {
        // ghul.runtime 14.4.0+'s GenerateGhulResponseFile writes the project's
        // GhulSources patterns as written, wherever they were declared - which
        // a parse of the .ghulproj alone cannot see.
        it('prefers them over everything else', () => {
            const workspace = ws();

            const response_file = join(workspace, 'project.rsp');
            const globs_file = join(workspace, 'source-globs.txt');
            writeFileSync(globs_file, 'src/**/*.ghul\nextra/*.ghul\n');

            const cfg = getGhulConfig(workspace, {}, response_file, globs_file);

            expect(cfg.source).toEqual(['src/**/*.ghul', 'extra/*.ghul']);
        });

        it('falls back to the usual sources when none were published', () => {
            // An older runtime has no such target; an all-conditional project
            // gets nothing from the one that exists. Either way the previous
            // resolution stands.
            const workspace = ws();

            const cfg = getGhulConfig(workspace, {}, join(workspace, 'project.rsp'), join(workspace, 'never-written.txt'));

            expect(cfg.source).toEqual(['./**/*.ghul']);
        });
    });

    // The convention across this ecosystem is a shared Directory.Build.props
    // carrying <GhulSources>, so the project file names none of its own. Read
    // as "this project has no sources", that left the analyser compiling only
    // whatever the editor had open, and every symbol declared in an unopened
    // file reported as not defined.
    it('falls back to the default glob when the project file names no sources', () => {
        const workspace = ws();
        writeFileSync(join(workspace, 'test.ghulproj'), `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <None Include="README.md" />
    </ItemGroup>
</Project>`);

        const cfg = getGhulConfig(workspace);
        expect(cfg.source).toEqual(['./**/*.ghul']);
    });

    // ghul.projectFile manifest: the manifest's compiler is the one, and a
    // .ghulproj beside it names neither the compiler nor the sources.
    it('takes nothing from a .ghulproj beside a manifest it is analysing', () => {
        const workspace = ws();
        writeFileSync(join(workspace, 'test.ghulproj'), `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler-from-proj --flag</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <GhulSources Include="proj-only/**/*.ghul" />
    </ItemGroup>
</Project>`);

        const cfg = getGhulConfig(workspace, {}, null, null, ['/opt/ghul-compiler']);
        expect(cfg.compiler).toEqual(['/opt/ghul-compiler']);
        expect(cfg.source).not.toContain('proj-only/**/*.ghul');
    });

    it('reads compiler and sources from a .ghulproj', () => {
        const workspace = ws();
        const proj = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler-from-proj --flag</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <GhulSources Include="src/**/*.ghul" />
    </ItemGroup>
</Project>`;
        writeFileSync(join(workspace, 'test.ghulproj'), proj);

        const cfg = getGhulConfig(workspace);
        expect(cfg.compiler).toEqual(['ghul-compiler-from-proj', '--flag']);
        expect(cfg.source).toEqual(['src/**/*.ghul']);
    });

    describe('an Exclude on a <GhulSources> item', () => {
        const project = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <GhulSources Include="tasks/**/*.ghul" Exclude="tasks/**/stand-in.ghul;tasks/**/scratch.ghul" />
        <GhulSources Include="root/**/*.ghul" />
    </ItemGroup>
</Project>`;

        it('is read from the project file alongside its Include', () => {
            const workspace = ws();
            writeFileSync(join(workspace, 'test.ghulproj'), project);

            const cfg = getGhulConfig(workspace);

            expect(cfg.source).toEqual(['tasks/**/*.ghul', 'root/**/*.ghul']);
            expect(cfg.exclude).toEqual(['tasks/**/stand-in.ghul', 'tasks/**/scratch.ghul']);
        });

        it('still applies when the build published the includes', () => {
            // The published globs carry only includes, so the project file is
            // where the excludes come from either way.
            const workspace = ws();
            writeFileSync(join(workspace, 'test.ghulproj'), project);

            const globs_file = join(workspace, 'source-globs.txt');
            writeFileSync(globs_file, 'tasks/**/*.ghul\nroot/**/*.ghul\n');

            const cfg = getGhulConfig(workspace, {}, join(workspace, 'project.rsp'), globs_file);

            expect(cfg.source).toEqual(['tasks/**/*.ghul', 'root/**/*.ghul']);
            expect(cfg.exclude).toEqual(['tasks/**/stand-in.ghul', 'tasks/**/scratch.ghul']);
        });

        it('is skipped when the item carries a Condition', () => {
            const workspace = ws();
            writeFileSync(join(workspace, 'test.ghulproj'), project.replace(
                'Exclude="tasks/**/stand-in.ghul;tasks/**/scratch.ghul"',
                'Exclude="tasks/**/stand-in.ghul" Condition="\'$(CI)\' == \'true\'"'));

            const cfg = getGhulConfig(workspace);

            expect(cfg.exclude).toEqual([]);
        });
    });

    it('forwards unconditioned <GhulOptions> additively and skips Condition-guarded ones', () => {
        const workspace = ws();
        const proj = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler --underscore-access legacy</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <GhulSources Include="src/**/*.ghul" />
        <GhulOptions Include="--warn-as-hint presence-test-non-optional" />
        <GhulOptions Include="--define release" Condition="'$(CI)' != ''" />
    </ItemGroup>
</Project>`;
        writeFileSync(join(workspace, 'test.ghulproj'), proj);

        const cfg = getGhulConfig(workspace);
        // <GhulCompiler> flags stay on `compiler`; the unconditioned
        // <GhulOptions> land additively on `arguments` (ahead of -A); the
        // Condition-guarded --define release is skipped.
        expect(cfg.compiler).toEqual(['ghul-compiler', '--underscore-access', 'legacy']);
        expect(cfg.arguments).toEqual(['--warn-as-hint', 'presence-test-non-optional', '-A', '--incremental-analysis']);
    });

    it('reads flags from .ghul-options.json and skips the <GhulOptions> XML fallback', () => {
        const workspace = ws();
        const proj = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup>
        <GhulCompiler>ghul-compiler</GhulCompiler>
    </PropertyGroup>
    <ItemGroup>
        <GhulSources Include="src/**/*.ghul" />
        <GhulOptions Include="--should-be-ignored" />
    </ItemGroup>
</Project>`;
        writeFileSync(join(workspace, 'test.ghulproj'), proj);
        writeJson(workspace, '.ghul-options.json', {
            options: '--underscore-access legacy --suppress "null-deref,impure-function-value"',
        });

        const cfg = getGhulConfig(workspace);
        expect(cfg.arguments).toEqual([
            '--underscore-access', 'legacy',
            '--suppress', 'null-deref,impure-function-value',
            '-A',
            '--incremental-analysis',
        ]);
        expect(cfg.arguments).not.toContain('--should-be-ignored');
    });

    it('falls back to the <GhulOptions> XML forwarding when .ghul-options.json is absent', () => {
        const workspace = ws();
        const proj = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <ItemGroup>
        <GhulSources Include="src/**/*.ghul" />
        <GhulOptions Include="--warn-as-hint presence-test-non-optional" />
    </ItemGroup>
</Project>`;
        writeFileSync(join(workspace, 'test.ghulproj'), proj);
        // No .ghul-options.json — the project's ghul.runtime pin predates
        // GenerateGhulOptionsJson (< 14.1.0).

        const cfg = getGhulConfig(workspace);
        expect(cfg.arguments).toEqual(['--warn-as-hint', 'presence-test-non-optional', '-A', '--incremental-analysis']);
    });

    it('records a problem for malformed .ghul-options.json instead of throwing', () => {
        const workspace = ws();
        writeFileSync(join(workspace, '.ghul-options.json'), 'not json at all');

        let cfg!: ReturnType<typeof getGhulConfig>;
        expect(() => { cfg = getGhulConfig(workspace); }).not.toThrow();
        expect(cfg.problems.some(p => p.includes('.ghul-options.json'))).toBe(true);
    });

    it('ignores .ghulproj contents when multiple are present', () => {
        const workspace = ws();
        const proj = `<?xml version="1.0"?>
<Project Sdk="Ghul.Sdk">
    <PropertyGroup><GhulCompiler>should-be-ignored</GhulCompiler></PropertyGroup>
</Project>`;
        writeFileSync(join(workspace, 'a.ghulproj'), proj);
        writeFileSync(join(workspace, 'b.ghulproj'), proj);

        const cfg = getGhulConfig(workspace, {}, null, null, undefined, { compiler: ['from-host'] });
        // Compiler must come from the fallback, not the proj files:
        expect(cfg.compiler).toEqual(['from-host']);
    });

    describe('problem reporting', () => {
        // getGhulConfig must never throw on bad input: a malformed file or a
        // missing compiler becomes a recorded problem so the caller can back
        // off and surface a diagnostic, rather than crashing the server.

        it('records no problems for a cleanly-configured workspace', () => {
            const workspace = ws();

            const cfg = getGhulConfig(workspace, {}, null, null, undefined, { compiler: ['c'] });
            expect(cfg.problems).toEqual([]);
        });

        it('records a problem for an unparseable .ghulproj instead of throwing', () => {
            const workspace = ws();
            writeFileSync(join(workspace, 'test.ghulproj'), '<Project><not-closed>');

            let cfg!: ReturnType<typeof getGhulConfig>;
            expect(() => { cfg = getGhulConfig(workspace); }).not.toThrow();
            expect(cfg.problems.some(p => p.includes('test.ghulproj'))).toBe(true);
        });

        it('records a problem for malformed .assemblies.json instead of throwing', () => {
            const workspace = ws();
                writeFileSync(join(workspace, '.assemblies.json'), 'not json at all');

            let cfg!: ReturnType<typeof getGhulConfig>;
            expect(() => { cfg = getGhulConfig(workspace); }).not.toThrow();
            expect(cfg.problems.some(p => p.includes('.assemblies.json'))).toBe(true);
        });

        it('records a problem for malformed .config/dotnet-tools.json instead of throwing', () => {
            const workspace = ws();
            mkdirSync(join(workspace, '.config'));
            writeFileSync(join(workspace, '.config/dotnet-tools.json'), '{ broken');

            let cfg!: ReturnType<typeof getGhulConfig>;
            expect(() => { cfg = getGhulConfig(workspace); }).not.toThrow();
            expect(cfg.problems.some(p => p.includes('dotnet-tools.json'))).toBe(true);
        });

        it('records a problem when no compiler can be resolved', () => {
            // An empty workspace names no compiler, has no tool manifest
            // and (in the test environment) no installed ghul-compiler.
            const workspace = ws();

            const cfg = getGhulConfig(workspace);
            expect(cfg.compiler).toBeUndefined();
            expect(cfg.problems.some(p => p.includes('compiler'))).toBe(true);
        });
    });

    describe('the build\'s response file', () => {
        // ghul.runtime 14.3.0+ resolves the options and the references
        // together and writes them as response-file text, which is what the
        // compiler wants anyway. It supersedes .ghul-options.json and
        // .assemblies.json, which carried the same two things as JSON.
        it('takes both options and -a entries from it', () => {
            const workspace = ws();

            const a = join(workspace, 'A.dll');
            const b = join(workspace, 'B.dll');

            writeFileSync(a, '');
            writeFileSync(b, '');

            const response_file = join(workspace, 'project.rsp');
            writeFileSync(response_file, `--suppress null-deref\n-a "${a}"\n-a "${b}"\n`);

            const cfg = getGhulConfig(workspace, {}, response_file);

            expect(cfg.arguments).toEqual([
                '--suppress', 'null-deref',
                '-a', a,
                '-a', b,
                '-A',
                '--incremental-analysis',
            ]);
            expect(cfg.missing_assemblies).toEqual([]);
        });

        // Same reason the .assemblies.json path withholds them: the analyser
        // reads every -a path eagerly and dies on the first one it cannot
        // open, and a referenced project's output is named here before
        // anything has built it.
        it('withholds -a entries for assemblies that do not exist yet', () => {
            const workspace = ws();

            const present = join(workspace, 'Present.dll');
            writeFileSync(present, '');

            const absent = join(workspace, 'bin', 'Absent.dll');

            const response_file = join(workspace, 'project.rsp');
            writeFileSync(response_file, `-a "${present}"\n-a "${absent}"\n`);

            const cfg = getGhulConfig(workspace, {}, response_file);

            expect(cfg.arguments).toEqual(['-a', present, '-A', '--incremental-analysis']);
            expect(cfg.missing_assemblies).toEqual([absent]);
        });

        it('leaves the JSON files it supersedes unread', () => {
            const workspace = ws();

            const from_response_file = join(workspace, 'FromResponseFile.dll');
            const from_json = join(workspace, 'FromJson.dll');

            writeFileSync(from_response_file, '');
            writeFileSync(from_json, '');

            writeJson(workspace, '.assemblies.json', { assemblies: [from_json] });
            writeJson(workspace, '.ghul-options.json', { options: '--warn-as-hint null-deref' });

            const response_file = join(workspace, 'project.rsp');
            writeFileSync(response_file, `-a "${from_response_file}"\n`);

            const cfg = getGhulConfig(workspace, {}, response_file);

            expect(cfg.arguments).toEqual(['-a', from_response_file, '-A', '--incremental-analysis']);
        });

        // A runtime older than 14.3.0 has no target to write one, and the
        // caller passes null; a build that failed leaves the path named but
        // nothing at it. Either way the JSON files are still the answer.
        it('falls back to the JSON files when it was never written', () => {
            const workspace = ws();

            const a = join(workspace, 'A.dll');
            writeFileSync(a, '');

            writeJson(workspace, '.assemblies.json', { assemblies: [a] });

            const cfg = getGhulConfig(workspace, {}, join(workspace, 'never-written.rsp'));

            expect(cfg.arguments).toEqual(['-a', a, '-A', '--incremental-analysis']);
        });
    });
});

// Settings that govern how the extension behaves belong to the editor, where
// they are discoverable and overridable per user, per workspace and per
// folder, and nowhere else.
describe('getGhulConfig editor settings', () => {
    let workspace: string;

    beforeEach(() => {
        const { mkdtempSync } = jest.requireActual('fs');
        const { tmpdir } = jest.requireActual('os');
        const path = jest.requireActual('path');
        workspace = mkdtempSync(path.join(tmpdir(), 'ghul-vsce-settings-'));
    });

    afterEach(() => {
        const { rmSync } = jest.requireActual('fs');
        rmSync(workspace, { recursive: true, force: true });
    });

    function writeGhulJson(contents: object) {
        const { writeFileSync } = jest.requireActual('fs');
        const path = jest.requireActual('path');
        writeFileSync(path.join(workspace, 'ghul.json'), JSON.stringify(contents));
    }

    it('is on when nobody has asked for it', () => {
        expect(getGhulConfig(workspace).incremental_analysis).toBe(true);
        expect(getGhulConfig(workspace).arguments).toContain('--incremental-analysis');
    });

    it('takes the editor setting when one is expressed', () => {
        const cfg = getGhulConfig(workspace, { incremental_analysis: true });

        expect(cfg.incremental_analysis).toBe(true);
        expect(cfg.arguments).toContain('--incremental-analysis');
    });

    it('lets the editor setting turn the default off for real', () => {
        const cfg = getGhulConfig(workspace, { incremental_analysis: false });

        expect(cfg.incremental_analysis).toBe(false);
        expect(cfg.arguments).toContain('--no-incremental-analysis');
    });

    it('takes plaintext hover from the editor setting alone', () => {
        writeGhulJson({ want_plaintext_hover: true, incremental_analysis: false });

        expect(getGhulConfig(workspace, {}).want_plaintext_hover).toBe(false);
        expect(getGhulConfig(workspace, {}).incremental_analysis).toBe(true);
        expect(getGhulConfig(workspace, { want_plaintext_hover: true }).want_plaintext_hover).toBe(true);
    });
});
