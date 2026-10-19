import { toResponseFileText } from '../src/response-file-text';

// Reads text the way the compiler's argument parser does: whitespace
// separates arguments, quotes group them, and nothing is escaped.
function readLikeCompiler(text: string): string[] {
    const result: string[] = [];
    let i = 0;

    while (i < text.length) {
        if (/\s/.test(text[i])) {
            i++;
        } else if (text[i] === '"' || text[i] === "'") {
            const quote = text[i++];
            const end = text.indexOf(quote, i);
            result.push(text.substring(i, end));
            i = end + 1;
        } else {
            let end = i;
            while (end < text.length && !/\s/.test(text[end])) {
                end++;
            }
            result.push(text.substring(i, end));
            i = end;
        }
    }

    return result;
}

describe('toResponseFileText', () => {
    it('joins plain arguments with spaces', () => {
        expect(toResponseFileText(['-a', '/path/to/A.dll', '-A'])).toBe('-a /path/to/A.dll -A');
    });

    it('leaves a comma list unescaped', () => {
        const text = toResponseFileText(['--warn-as-hint', 'impure-function-argument,cast-may-throw']);

        expect(text).toBe('--warn-as-hint impure-function-argument,cast-may-throw');
        expect(readLikeCompiler(text)).toEqual(['--warn-as-hint', 'impure-function-argument,cast-may-throw']);
    });

    it('wraps an argument containing whitespace in double quotes', () => {
        const args = ['-a', '/path with spaces/A.dll'];

        expect(toResponseFileText(args)).toBe('-a "/path with spaces/A.dll"');
        expect(readLikeCompiler(toResponseFileText(args))).toEqual(args);
    });

    it('keeps backslashes literal', () => {
        const args = ['-a', 'C:\\Users\\me\\ghul runtime\\ghul-runtime.dll', '-o', 'C:\\out\\x.dll'];

        expect(readLikeCompiler(toResponseFileText(args))).toEqual(args);
    });

    it('leaves shell metacharacters alone', () => {
        const args = ['-a', '/a(b)&c#d$e.dll'];

        expect(toResponseFileText(args)).toBe('-a /a(b)&c#d$e.dll');
    });

    it('uses single quotes for an argument containing a double quote', () => {
        const args = ['--x', 'say "hi"'];

        expect(readLikeCompiler(toResponseFileText(args))).toEqual(args);
    });
});
