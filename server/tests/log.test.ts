import { LineLog } from '../src/log';

describe('LineLog', () => {
    let logged: string[];
    let spy: jest.SpyInstance;

    beforeEach(() => {
        logged = [];
        spy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => { logged.push(args.join(' ')); });
    });

    afterEach(() => {
        spy.mockRestore();
    });

    it('logs each complete line, holding a partial one for the next chunk', () => {
        const lines = new LineLog("compiler: ");

        lines.write(Buffer.from("first\nsec"));
        expect(logged).toEqual(["ghūl: compiler: first"]);

        lines.write(Buffer.from("ond\r\n\nthird"));
        expect(logged).toEqual(["ghūl: compiler: first", "ghūl: compiler: second"]);

        lines.flush();
        expect(logged).toEqual(["ghūl: compiler: first", "ghūl: compiler: second", "ghūl: compiler: third"]);
    });

    it('keeps a character split across chunks whole', () => {
        const lines = new LineLog("");
        const bytes = Buffer.from("ghūl\n");

        lines.write(bytes.subarray(0, 3));
        lines.write(bytes.subarray(3));

        expect(logged).toEqual(["ghūl: ghūl"]);
    });
});
