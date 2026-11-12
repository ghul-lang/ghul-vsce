# ghūl programming language Visual Studio Code extension

[![CI/CD](https://img.shields.io/github/actions/workflow/status/ghul-lang/ghul-vsce/CICD.yaml?branch=main)](https://github.com/ghul-lang/ghul-vsce/actions/workflows/CICD.yaml?query=branch%3Amain)
[![Visual Studio Marketplace](https://img.shields.io/github/v/release/ghul-lang/ghul-vsce?label=Visual%20Studio%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=degory.ghul)
[![Release](https://img.shields.io/github/v/release/ghul-lang/ghul-vsce?label=release)](https://github.com/ghul-lang/ghul-vsce/releases)
[![Release Date](https://img.shields.io/github/release-date/ghul-lang/ghul-vsce)](https://github.com/ghul-lang/ghul-vsce/releases)
[![Issues](https://img.shields.io/github/issues-search/ghul-lang/ghul?query=is%3Aopen%20is%3Aissue%20label%3Aghul-vsce&label=issues)](https://github.com/ghul-lang/ghul/issues?q=is%3Aopen+is%3Aissue+label%3Aghul-vsce)
[![License](https://img.shields.io/github/license/ghul-lang/ghul-vsce)](https://github.com/ghul-lang/ghul-vsce/blob/main/LICENSE)
[![ghūl](https://img.shields.io/badge/gh%C5%ABl-100%25!-information)](https://ghul.dev)

This Visual Studio Code extension provides support for the [ghūl programming language](https://www.ghul.dev/), including:
- syntax highlighting
- error highlighting as you type
- code snippets
- symbol information on hover
- code completion
- function signature help
- go to/peek definition
- go to/peek references
- go to/peek implementations
- go to symbol in file
- go to symbol in workspace
- rename symbol

## Projects and folders

Open a ghūl project's folder, or a folder holding several, and the extension
runs one analyser for each project it finds. A project is a directory with a
`.ghulproj` or a `ghul-project.json`. The explorer shows the folder as it is;
no workspace file is needed.

- A folder that is a project is analysed as one.
- A folder that is not (no marker, or a manifest of kind `workspace` or
  `collection`) is never analysed itself. The extension looks under it for
  projects, skipping `bin`, `obj`, `node_modules` and hidden directories, and
  starts a project's analyser when a file in it is first opened.
- A `ghul-project.json` of kind `workspace` lists the projects under it as
  `members` (paths or globs), and the extension uses that list instead of
  looking.
- A manifest of kind `collection` marks a directory of independent programs,
  such as examples or test cases. The extension does not look inside it and does
  not analyse its files, and says so once. Open a project inside it as a folder
  to analyse that project.
- A project's own sources stop at any other project nested inside it: a file
  belongs to the nearest enclosing project. The exception is a folder read
  from its manifest under `ghul.projectFile` `manifest`, which takes in the
  nested projects its `sources` cover.
- A workspace file listing each project as a folder keeps working as it did.

A `ghul-project.json` project is read by the ghul command-line tool, which
says what the project compiles and which compiler analyses it. The manifest
is in the shape ghul 10.0.0 and later read, described in the
[ghul-cli README](https://github.com/ghul-lang/ghul-cli#projects); one the
tool refuses, such as one with the keys of the first version (`tools`,
`options`, `prefer`, `engine`, `host` or `compiler-build`), is reported with the
tool's own message, which names what replaced each key.

Each project's analyser is a compiler process holding the whole project in
memory, so the extension keeps at most `ghul.analysers.max` of them running
(four unless you change it). A project with a visible editor always keeps its
analyser, so more than that can run when more are visible. Opening a file in a
project that is not running starts it when you use the file, or when it is
visible; tabs restored in the background start nothing. Where starting one would
go over the limit, the project you used least recently is stopped, and starts
again the next time you use it. The status bar tooltip lists what is running.

## Settings

How the extension behaves is configured through ordinary editor settings, so
they appear in the Settings UI and can be set per user, per workspace, or per
workspace folder:

- `ghul.incrementalAnalysis` — reuse the analyser's existing state across an
  edit instead of rebuilding the whole project for each one. Much faster on a
  large project, at the cost of some answers being briefly out of date after an
  edit that changes a declaration. Off unless turned on.
- `ghul.plaintextHover` — render hovers as plain text rather than markdown.
- `ghul.projectFile` — which file a project is read from where a folder holds
  both a `.ghulproj` and a `ghul-project.json`: `auto` takes the `.ghulproj`,
  and `manifest` takes the `ghul-project.json`, read by the ghul tool. Under
  `manifest`, a nested project whose directory the manifest's `sources` cover
  is part of it rather than a project of its own.
- `ghul.compilerHost` — how the compiler that analyses a `ghul-project.json`
  project is run: `dotnet`, `llvm` (the compiler built for llvm, a native
  executable, on Linux x64 and arm64), `wasm` (under Node), or `auto` for the
  ghul tool's own choice. Unset leaves it to the ghul tool. Needs the ghul tool
  9.8.0 or later; an older one is reported and the setting is ignored.
- `ghul.compilerPath` — a compiler to analyse a `ghul-project.json` project
  with, in place of the one the ghul tool would install: a native `ghul`
  executable, or a command such as `dotnet /path/to/ghul.dll`.

The output channel says, for each project, which file it was read from and
why, and which compiler analyses it.

How the *project* is built stays in the project file: `<GhulCompiler>`,
`<GhulSources>` and `<GhulOptions>` in the `.ghulproj` govern an ordinary
build. Diagnostics options (`<GhulOptions>`, `<GhulUnderscoreAccess>` and
friends) reach the extension the same way, but not by re-reading the XML: on
a ghul.runtime 14.3.0+ project, the extension asks MSBuild to resolve them
first, along with the project's references, and reads the answer out of the
response file the build writes, so it sees what the build actually resolved
rather than a guess at it - conditions applied, properties evaluated. A
project on an older `ghul.runtime` pin falls back to the two JSON files that
runtime publishes instead, or, on one older still, to a direct (best-effort)
reading of the unconditioned `<GhulOptions>` entries.

Nothing generated is written into the project. The response file the build
writes, and the one the analyser is launched with, both live in a directory
of the extension's own under the system temporary directory, and go away with
the workspace that owns them.

A `ghul.json` in the workspace root is still read, and still sets
`incremental_analysis` and `want_plaintext_hover` for a project that already
does. An editor setting wins over it wherever the user has expressed a
preference.

## Other editors

The language server this extension runs is also published on its own, for any
editor that speaks LSP, as the `@ghul/language-server` npm package and as a
tarball attached to each [release](https://github.com/ghul-lang/ghul-vsce/releases).
See [language-server/README.md](language-server/README.md) for setup.



## Issues

[View open issues](https://github.com/ghul-lang/ghul/issues?q=is%3Aopen+is%3Aissue+label%3Aghul-vsce) or [raise a new one](https://github.com/ghul-lang/ghul/issues/new?labels=ghul-vsce).
