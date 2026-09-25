# ghūl programming language Visual Studio Code extension

[![CI/CD](https://img.shields.io/github/actions/workflow/status/ghul-lang/ghul-vsce/CICD.yaml?branch=main)](https://github.com/ghul-lang/ghul-vsce/actions/workflows/CICD.yaml?query=branch%3Amain)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/degory.ghul)](https://marketplace.visualstudio.com/items?itemName=degory.ghul)
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

## Settings

How the extension behaves is configured through ordinary editor settings, so
they appear in the Settings UI and can be set per user, per workspace, or per
workspace folder:

- `ghul.incrementalAnalysis` — reuse the analyser's existing state across an
  edit instead of rebuilding the whole project for each one. Much faster on a
  large project, at the cost of some answers being briefly out of date after an
  edit that changes a declaration. Off unless turned on.
- `ghul.plaintextHover` — render hovers as plain text rather than markdown.

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
