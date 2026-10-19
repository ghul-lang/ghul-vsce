import { log } from './log';

// The compiler reads an `@file` as whitespace-separated arguments. An
// argument may be wrapped in double or single quotes, and what is between
// the quotes is taken literally: there are no escapes, so a backslash or a
// comma means itself. That is also the form the build's response file is
// written in, and it is what lets a Windows path pass through untouched.
//
// Shell quoting is a different dialect and cannot be used here: it
// backslash-escapes punctuation such as `,`, which this reader keeps.
export function toResponseFileText(args: string[]): string {
    return args.map(quoteArgument).join(" ");
}

function quoteArgument(arg: string): string {
    if (arg.length > 0 && !/[\s"']/.test(arg)) {
        return arg;
    }

    if (!arg.includes('"')) {
        return `"${arg}"`;
    }

    if (!arg.includes("'")) {
        return `'${arg}'`;
    }

    // No quoting can carry both kinds of quote in one argument.
    log(`cannot represent argument in a response file: ${arg}`);

    return `'${arg}'`;
}
