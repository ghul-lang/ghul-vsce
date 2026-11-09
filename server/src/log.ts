import { StringDecoder } from 'string_decoder';

export function log(...args: any[]) {
	console.log("ghūl:",...args);
}

// Logs a stream line by line as its chunks arrive, holding back a partial
// last line until the rest of it comes. The compiler's stderr goes through
// here so its periodic statistics are logged at info: written straight to
// the server's own stderr, the language client logs every line of it as an
// error.
export class LineLog {
	private partial = "";
	private readonly decoder = new StringDecoder('utf8');

	constructor(private readonly prefix: string) {
	}

	write(chunk: Buffer | string) {
		const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
		const lines = (this.partial + text).split(/\r?\n/);

		this.partial = lines.pop() ?? "";

		for (const line of lines) {
			if (line.length > 0) {
				log(this.prefix + line);
			}
		}
	}

	flush() {
		this.partial += this.decoder.end();

		if (this.partial.length > 0) {
			log(this.prefix + this.partial);
			this.partial = "";
		}
	}
}
