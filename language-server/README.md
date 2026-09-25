# ghūl language server

Language server for the [ghūl programming language](https://ghul.dev), for any
editor that speaks LSP.

This is the same server the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=degory.ghul)
runs, packaged to be launched directly. VS Code users do not need it: install
the extension instead.

## Requirements

- Node.js 20 or later, to run the server itself.
- The .NET SDK, and a ghūl project whose `.config/dotnet-tools.json` pins
  `ghul.compiler`. The server restores and drives that compiler in analysis
  mode; it does no analysis of its own.

## Install

```sh
npm install -g @ghul/language-server
```

The command the package installs is `ghul-language-server`.

Or download `ghul-language-server-<version>.tgz` from a
[release](https://github.com/ghul-lang/ghul-vsce/releases) and unpack it. The
contents are under `package/`, and the executable is
`package/bin/ghul-language-server.js`.

## Run

```sh
ghul-language-server --stdio
```

`--node-ipc`, `--socket=<port>` and `--pipe=<name>` also work. With no
transport argument the server defaults to stdio.

The workspace root the client reports must be the directory containing the
`.ghulproj`, so the server can find the project and its tool manifest.

## Editor configuration

### Neovim

```lua
vim.filetype.add({ extension = { ghul = "ghul" } })

vim.lsp.config.ghul = {
  cmd = { "ghul-language-server", "--stdio" },
  filetypes = { "ghul" },
  root_markers = { "*.ghulproj", ".git" },
}

vim.lsp.enable("ghul")
```

### Helix

In `languages.toml`:

```toml
[language-server.ghul]
command = "ghul-language-server"
args = ["--stdio"]

[[language]]
name = "ghul"
scope = "source.ghul"
file-types = ["ghul"]
roots = ["*.ghulproj"]
language-servers = ["ghul"]
```

### Emacs (eglot)

```elisp
(define-derived-mode ghul-mode prog-mode "ghūl")
(add-to-list 'auto-mode-alist '("\\.ghul\\'" . ghul-mode))
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '(ghul-mode . ("ghul-language-server" "--stdio"))))
```

## Supported requests

Completion, hover, definition, declaration, type definition, implementation,
references, rename, document and workspace symbols, signature help, document
and range formatting, semantic tokens, inlay hints, quick-fix code actions,
and diagnostics.

Syntax highlighting comes from semantic tokens, so an editor that does not
request them shows unhighlighted text. There is no TextMate grammar or
tree-sitter parser in this package; the VS Code extension carries its own
grammar.
