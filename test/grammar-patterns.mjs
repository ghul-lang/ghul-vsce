// What the TextMate grammar reads as a name, as a type and as an operator.
//
//   node test/grammar-patterns.mjs
//
// Runs Oniguruma, which is the engine VS Code matches these patterns with.
// Its answers differ from JavaScript's - it takes \p{...} with no flag to
// enable it, and its \b is Unicode-aware - so checking the patterns with
// JavaScript regular expressions could pass while the grammar was wrong.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const oniguruma = require('vscode-oniguruma');

await oniguruma.loadWASM(
    readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);

const grammar = JSON.parse(readFileSync('syntaxes/ghul.tmLanguage.json', 'utf8'));

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

// Every rule in the grammar that matches text, with the scope it gives it.
function* rules(node) {
    if (Array.isArray(node)) {
        for (const child of node) yield* rules(child);
    } else if (node && typeof node === 'object') {
        if (typeof node.match === 'string' && typeof node.name === 'string') {
            yield { match: node.match, name: node.name };
        }
        for (const [key, child] of Object.entries(node)) {
            if (key !== 'match' && key !== 'name') yield* rules(child);
        }
    }
}

const all = [...rules(grammar)];

check(`the grammar has rules to check`, all.length > 20, `${all.length} found`);

// A rule that does not compile is dead: VS Code drops it and colours nothing
// with it, silently.
for (const rule of all) {
    try {
        new oniguruma.OnigScanner([rule.match]);
    } catch (e) {
        check(`${rule.name} compiles`, false, e.message);
    }
}

// The scopes that claim a piece of text, starting at its first character.
function scopes(text) {
    const claimed = new Set();

    for (const rule of all) {
        let scanner;
        try {
            scanner = new oniguruma.OnigScanner([rule.match]);
        } catch {
            continue;
        }

        const m = scanner.findNextMatchSync(new oniguruma.OnigString(text), 0);

        if (m && m.captureIndices[0].start === 0 && m.captureIndices[0].end === text.length) {
            claimed.add(rule.name);
        }
    }

    return claimed;
}

const NAME = 'entity.name.ghul variable.other.ghul';
const TYPE = 'entity.name.type.ghul';
const OPERATOR = 'keyword.operator.ghul';

for (const [text, scope] of [
    ['value', NAME],
    ['café', NAME],
    ['таблица', NAME],
    ['説明', NAME],
    ['μέγεθος', NAME],
    ['SHAPE', TYPE],
    ['Shape', TYPE],
    ['ТИП', TYPE],
    ['Σχήμα', TYPE],
    ['+', OPERATOR],
    ['=~', OPERATOR],
    ['×', OPERATOR],
    ['∪', OPERATOR],
]) check(`${text} is ${scope.split(' ')[0]}`, scopes(text).has(scope));

// A letter is never a symbol, so a name and an operator never share a
// character, and the backtick escapes a name rather than starting an operator.
for (const [text, scope] of [
    ['café', OPERATOR],
    ['×', NAME],
    ['`', OPERATOR],
]) check(`${text} is not ${scope.split(' ')[0]}`, !scopes(text).has(scope));

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
