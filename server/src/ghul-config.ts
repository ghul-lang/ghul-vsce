import { readFileSync, existsSync } from 'fs';

import { globSync } from 'glob';

import { parseString as parseXmlString } from 'xml2js';
import { log } from './log';
import { spawnSync } from 'child_process';
import { parse, quote } from 'shell-quote';

export interface GhulConfig {
	block: boolean,
	compiler: string[],
	source: string[],
	// Patterns an Exclude attribute on the project's <GhulSources> items
	// takes back out of the source set, relative to the workspace. Applied to
	// every source pattern, not only the item that declared it.
	exclude?: string[],
	arguments: string[],
	want_plaintext_hover: boolean,
	incremental_analysis: boolean,
	// Referenced assemblies the build named that do not exist on disk yet —
	// typically the build outputs of ProjectReference'd projects in
	// a tree that has never been built. They are withheld from the -a flags
	// because the analyser reads each one eagerly and would die on the first
	// missing file. Analysis is correspondingly incomplete until they appear,
	// so consumers watch this set and reinitialize once it empties.
	missing_assemblies: string[],
	// Human-readable descriptions of anything that went wrong while loading
	// the configuration — an unreadable project file, malformed JSON, no
	// compiler found. Empty when the workspace loaded cleanly. Consumers use
	// this to surface a diagnostic and to decide whether to back off rather
	// than spawn-and-fail in a loop.
	problems: string[],
}

interface GhulOptionsFileJson {
	options?: string
}

interface GhulConfigJson {
	compiler?: string[] | string,
	source?: string[],
	other_flags?: string[] | string,
	want_plaintext_hover?: boolean,
	incremental_analysis?: boolean,
	update_compiler_tool?: boolean
}

interface DotNetToolsJson {
	version: number,
	isRoot: boolean,
	tools: {
		[name: string]: {
			version: string,
			commands: string[]
		}
	}
}

interface GhulProjectXml {
	Project: {
		"$": {
			Sdk: string
		},
		PropertyGroup: [
			{
				GhulCompiler: string[],
				UpdateCompilerTool: boolean
			}
		],
		ItemGroup: [
			{
				"$"?: {
					"Condition"?: string
				},
				GhulSources: {
					"$": {
						"Include": string,
						"Exclude"?: string,
						"Condition"?: string
					}
				}[],
				GhulOptions: {
					"$": {
						"Include": string,
						"Condition"?: string
					}
				}[]
			}
		]
	}
}

function describeError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// What the editor's own settings say, once its User / Workspace / Workspace
// Folder layers have been resolved into one value per setting. Null means the
// user has expressed no preference, which is distinct from having chosen the
// default: only then does ghul.json get a say.
export interface EditorSettings {
	incremental_analysis?: boolean | null,
	want_plaintext_hover?: boolean | null,
	inlay_narrowing?: boolean | null,
	inlay_definition_virtuality?: boolean | null,
	inlay_terminators?: boolean | null,
}

// Settings that govern how the extension behaves rather than how the project
// is built belong to the editor, where they are discoverable, validated and
// overridable per user, per workspace and per folder. ghul.json is still read
// for them, so a project that already sets one keeps working, but it is the
// weaker voice and the project file is the right home for anything that
// genuinely changes the build.
function prefer(setting: boolean | null | undefined, from_json: boolean | undefined): boolean {
	return setting ?? from_json ?? false;
}

// One line of the build's response file, tokenized. A line is one flag with
// its argument - `-a "/path/to/thing.dll"`, `--suppress null-deref` - so the
// tokens of a line are read together and never across lines.
function tokenizeResponseFile(text: string): string[][] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line => parse(line).map(token => token.toString()));
}

// Read what the build resolved - the compiler options and one -a flag per
// reference - out of the response file GenerateGhulResponseFile wrote, into
// the argument list the analyser will be launched with.
//
// The compiler follows a nested @<path> itself, so this could have been a
// single argument naming the file. It is read instead because a reference the
// build could not produce has to be withheld: the analyser reads each -a
// eagerly and stops at the first one that is not there, and keeping it up
// through a half-built tree is the whole reason analysis mode is separate.
function readResponseFile(
	response_file: string,
	args: string[],
	missing_assemblies: string[],
	problems: string[]
): boolean {
	if (!existsSync(response_file)) {
		return false;
	}

	try {
		let text = ('' + readFileSync(response_file, "utf-8")).replace(/^\uFEFF/, '');

		for (let tokens of tokenizeResponseFile(text)) {
			if (tokens[0] === "-a" && tokens.length > 1) {
				if (!existsSync(tokens[1])) {
					missing_assemblies.push(tokens[1]);
					continue;
				}
			}

			args.push(...tokens);
		}

		if (missing_assemblies.length) {
			log(
				`${missing_assemblies.length} referenced assembly/assemblies not present yet, ` +
				`analysis will be incomplete until they are built: ${missing_assemblies.join(", ")}`
			);
		}

		return true;
	} catch (e) {
		let problem = `could not load ${response_file}: ${describeError(e)}`;
		log(problem);
		problems.push(problem);

		return false;
	}
}

// The glob patterns the build says this project's sources are found by, as
// written rather than as expanded - the form a filesystem watcher needs - or
// null when the build published none.
// An MSBuild item spec: patterns separated by semicolons, surrounding
// whitespace ignored.
function splitItemSpec(spec: string): string[] {
	return spec
		.split(';')
		.map(pattern => pattern.trim())
		.filter(pattern => pattern.length > 0);
}

function readSourceGlobs(source_globs_file: string, problems: string[]): string[] | null {
	if (!existsSync(source_globs_file)) {
		return null;
	}

	try {
		let text = ('' + readFileSync(source_globs_file, "utf-8")).replace(/^\uFEFF/, '');

		let globs = text
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);

		return globs.length ? globs : null;
	} catch (e) {
		let problem = `could not load ${source_globs_file}: ${describeError(e)}`;
		log(problem);
		problems.push(problem);

		return null;
	}
}

export function getGhulConfig(
	workspace: string,
	settings: EditorSettings = {},
	response_file: string | null = null,
	source_globs_file: string | null = null
): GhulConfig {
	let problems: string[] = [];

	let config: GhulConfigJson = {};

	if (existsSync(workspace + "/ghul.json")) {
		try {
			let buffer = '' + readFileSync(workspace + "/ghul.json", "utf-8").replace(/^\uFEFF/, '');
			config = <GhulConfigJson>JSON.parse(buffer);
		} catch (e) {
			let problem = `could not load ghul.json: ${describeError(e)}`;
			log(problem);
			problems.push(problem);
		}
	}

	let config_json_source = config.source;

	let compiler: string[];

	if (config.compiler) {
		if (typeof config.compiler == "string") {
			compiler = parse(config.compiler).map(e => e.toString());
		} else {
			compiler = config.compiler;
		}
	}

	let block = false;

	if (existsSync(workspace + "/.block-compiler")) {
		block = true;
	}

	let args = config.other_flags ?? [];

	if (typeof args == "string") {
		args = parse(args as string).map(e => e.toString());
	}

	// Whether the compiler flags came from the build itself - conditions
	// applied, properties evaluated - rather than from the hand-rolled
	// <GhulOptions> forwarding below, which cannot see a Condition on the
	// item's enclosing ItemGroup, a property-form GhulOptions, or a $(...)
	// reference inside one. Either the response file or, on a runtime too old
	// to write one, .ghul-options.json (ghul.runtime 14.1.0+'s
	// GenerateGhulOptionsJson target, see degory/ghul#2090) supplies them.
	// Older still and there is neither, so the XML fallback runs as before.
	let resolved_options = false;
	let missing_assemblies: string[] = [];

	// ghul.runtime 14.3.0+'s GenerateGhulResponseFile (degory/ghul#2132)
	// carries the resolved options and the resolved references together, as
	// response-file text. Where it has been written it is the whole answer,
	// and neither of the two JSON files it replaced is consulted.
	let resolved_from_response_file =
		response_file != null &&
		readResponseFile(response_file, args as string[], missing_assemblies, problems);

	if (resolved_from_response_file) {
		resolved_options = true;
	} else if (existsSync(workspace + "/.ghul-options.json")) {
		try {
			let buffer = ('' + readFileSync(workspace + "/.ghul-options.json", "utf-8")).replace(/^\uFEFF/, '');
			let { options } = JSON.parse(buffer) as GhulOptionsFileJson;

			if (options) {
				args.push(...parse(options).map(e => e.toString()));
			}

			resolved_options = true;
		} catch (e) {
			let problem = `could not load .ghul-options.json: ${describeError(e)}`;
			log(problem);
			problems.push(problem);
		}
	}

	let project_excludes: string[] = [];

	let projects = globSync(workspace + "/*.ghulproj");

	if (projects.length == 1) {
		let ghulProjFileName = projects[0];

		try {
			let buffer = '' + readFileSync(ghulProjFileName, "utf-8").replace(/^\uFEFF/, '');

			parseXmlString(buffer, (error, projectXml: GhulProjectXml) => {
				if (!error && projectXml && projectXml.Project) {
					if (!config.update_compiler_tool && projectXml.Project.PropertyGroup) {
						let updateCompilerTool =
							projectXml.Project.PropertyGroup
							.filter(pg => pg.UpdateCompilerTool)
							.map(pg => pg.UpdateCompilerTool)[0]

						if (updateCompilerTool) {
							log('will update any locally installed compiler tool to latest version');
							config.update_compiler_tool = true;
						}
					}

					if (!compiler && projectXml.Project.PropertyGroup) {
						let compilerCommandLine =
							projectXml.Project.PropertyGroup
								.filter(pg => pg.GhulCompiler)
								.map(pg => pg.GhulCompiler)
									[0]?.[0];

						if ((compilerCommandLine ?? "") != "") {
							compiler = parse(compilerCommandLine).map(e => e.toString());

							log(`will use compiler '${quote([...compiler, ...args])}' specified in ${ghulProjFileName}`);
						}
					}

					// Read whichever source the includes come from: the
					// build's published globs carry no excludes, so these are
					// the only record of them.
					if (projectXml.Project.ItemGroup) {
						projectXml.Project.ItemGroup
							.filter(ig => ig.GhulSources && !ig["$"]?.Condition)
							.map(ig => ig.GhulSources)

							.forEach(item => {
								item
									.filter(pattern => pattern["$"]?.Exclude && !pattern["$"]?.Condition)
									.forEach(pattern => {
										project_excludes.push(...splitItemSpec(pattern["$"].Exclude))
									})
								}
							);
					}

					if (!config.source?.length && projectXml.Project.ItemGroup) {
						let patterns: string[] = [];

						projectXml.Project.ItemGroup
							.filter(ig => ig.GhulSources)
							.map(ig => ig.GhulSources)

							.forEach(item => {
								item
									.filter(pattern => pattern["$"]?.Include)
									.map(pattern => pattern["$"]?.Include)

									.forEach(pattern => {
										patterns.push(...splitItemSpec(pattern))
									})
								}
							);

						// Only when the project file actually named some. A
						// project that keeps its <GhulSources> in a shared
						// Directory.Build.props - the convention across this
						// ecosystem - has none to find here, and taking that
						// for "this project has no sources" left the analyser
						// with nothing to compile but the files the editor
						// happened to have open, so every symbol declared in
						// an unopened file reported as not defined. Leaving
						// config.source unset falls through to the same
						// default a project file with no ItemGroup at all
						// already gets.
						if (patterns.length) {
							config.source = patterns;
						}
					} else if(config.source) {
						config.source = config.source.map(directory => directory + "/**/*.ghul");
					}

					// Fallback for a project on a ghul.runtime older than
					// 14.1.0, where .ghul-options.json was never written:
					// forward unconditioned <GhulOptions Include="…" /> so
					// the analyser tracks the command-line build (e.g.
					// --warn-as-hint). Condition-guarded options (e.g.
					// CI-only --define) are skipped so the analyser matches
					// a local build rather than a CI build - the same
					// Condition-blindness .ghul-options.json exists to fix
					// (it cannot see a Condition on the enclosing ItemGroup,
					// GhulOptions in property form, or a $(...) reference),
					// so this path is deliberately left as-is rather than
					// hardened further.
					if (!resolved_options && projectXml.Project.ItemGroup) {
						projectXml.Project.ItemGroup
							.filter(ig => ig.GhulOptions)
							.map(ig => ig.GhulOptions)

							.forEach(item => {
								item
									.filter(option => option["$"]?.Include && !option["$"]?.Condition)
									.map(option => option["$"].Include)

									.forEach(include => {
										args.push(...parse(include).map(e => e.toString()));
									})
								}
							);
					}
				} else {
					let problem = `could not parse ghūl project file ${ghulProjFileName}` +
						(error ? `: ${describeError(error)}` : "");
					log(problem);
					problems.push(problem);
				}
			})
		} catch (e) {
			let problem = `could not read ghūl project file ${ghulProjFileName}: ${describeError(e)}`;
			log(problem);
			problems.push(problem);
		}
	} else if(projects.length > 0) {
		log("ignoring multiple .ghulproj files:" + projects.join(','));
	}

	if (!compiler) {
		if (existsSync(workspace + "/.config/dotnet-tools.json")) {
			try {
				let buffer = ('' + readFileSync(workspace + "/.config/dotnet-tools.json", "utf-8")).replace(/^\uFEFF/, '');

				let toolConfig = JSON.parse(buffer) as DotNetToolsJson;

				let { tools } = toolConfig;

				let ghulCompilerTool = tools["ghul.compiler"];

				if (ghulCompilerTool && ghulCompilerTool.commands.length == 1) {
					compiler = ["dotnet", "tool", "run", ghulCompilerTool.commands[0]]

					log(`will use compiler '${quote([...compiler, ...args])}' version ${ghulCompilerTool.version} from local tool manifest`);
				}
			} catch (e) {
				let problem = `could not load .config/dotnet-tools.json: ${describeError(e)}`;
				log(problem);
				problems.push(problem);
			}
		}

		if (!compiler) {
			let result = spawnSync("dotnet", ["ghul-compiler"], { encoding: "utf-8", cwd: workspace });

			if (result.status === 0 && result.stdout.startsWith("ghūl")) {
				compiler = ["dotnet", "ghul-compiler"];

				log(`will use compiler '${quote([...compiler, ...args])}'`);
			}
		}

		if (!compiler) {
			let result = spawnSync("ghul-compiler", { encoding: "utf-8", cwd: workspace });

			if (result.status === 0 && result.stdout.startsWith("ghūl")) {
				compiler = ["ghul-compiler"]

				log(`will use compiler '${quote([...compiler, ...args])}'`);
			}
		}
	}

	if (!compiler) {
		let problem = "no usable ghūl compiler found: install the ghul.compiler tool or set 'compiler' in ghul.json";
		log(problem);
		problems.push(problem);
	}

	if (config.update_compiler_tool) {
		let result = spawnSync("dotnet", ["tool", "update", "ghul.compiler", "--local"], { encoding: "utf-8", cwd: workspace });

		log(result.stdout);

		if (result.status === 0) {
			log('compiler tool update successful');
		} else {
			log(result.stderr);
			log('compiler tool update failed');
		}
	}

	if (!resolved_from_response_file && existsSync(workspace + "/.assemblies.json")) {
		try {
			let buffer = ('' + readFileSync(workspace + "/.assemblies.json", "utf-8")).replace(/^\uFEFF/, '');

			let { assemblies } = JSON.parse(buffer) as { assemblies: string[] };

			for (let assembly of assemblies) {
				if (!existsSync(assembly)) {
					missing_assemblies.push(assembly);
					continue;
				}

				args.push("-a");
				args.push(assembly);
			}

			if (missing_assemblies.length) {
				log(
					`${missing_assemblies.length} referenced assembly/assemblies not present yet, ` +
					`analysis will be incomplete until they are built: ${missing_assemblies.join(", ")}`
				);
			}
		} catch (e) {
			let problem = `could not load .assemblies.json: ${describeError(e)}`;
			log(problem);
			problems.push(problem);
		}
	}

	args.push("-A");

	let incremental_analysis = prefer(settings.incremental_analysis, config.incremental_analysis);

	if (incremental_analysis) {
		args.push("--incremental-analysis");
	}

	// Inlay-kind settings are editor-only: unset defers to the compiler's
	// own defaults (narrowing and definition-virtuality on, terminators
	// off), so the flags are sent only for an explicit choice. A disabled
	// kind is never collected by the analyser, so it costs nothing there
	// either. Settings become launch flags, so a change restarts the
	// analyser — the ordinary reinitialize path.
	for (const [setting, kind] of [
		[settings.inlay_narrowing, "narrowing"],
		[settings.inlay_definition_virtuality, "definition-virtuality"],
		[settings.inlay_terminators, "terminator"],
	] as const) {
		if (setting === true) {
			args.push("--inlay", kind);
		} else if (setting === false) {
			args.push("--no-inlay", kind);
		}
	}

	// What the build said, then what the project file parse found, then the
	// default. The build is preferred because it sees a Directory.Build.props
	// and the parse does not, and because its patterns are what the build
	// actually compiles rather than this reader's guess at them.
	let published_globs = source_globs_file ? readSourceGlobs(source_globs_file, problems) : null;

	let ghul_json_names_sources = !!config_json_source?.length;

	let source = [...(published_globs ?? config.source ?? ["./**/*.ghul"])];

	// Sources ghul.json names are its own answer, and the project file's
	// excludes say nothing about them.
	let exclude = published_globs || !ghul_json_names_sources ? project_excludes : [];

    return {
		block,
		compiler,
		source,
		exclude,
		arguments: args,
		want_plaintext_hover: prefer(settings.want_plaintext_hover, config.want_plaintext_hover),
		incremental_analysis,
		missing_assemblies,
		problems
	};
}
