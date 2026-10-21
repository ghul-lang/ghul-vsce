import { Connection } from 'vscode-languageserver';

import { METRICS_NOTIFICATION, MetricsReporter } from '../src/metrics-reporter';

describe('MetricsReporter', () => {
    let sendNotification: jest.Mock;
    let connection: Connection;
    let reporter: MetricsReporter;

    beforeEach(() => {
        jest.useFakeTimers();

        sendNotification = jest.fn();
        connection = { sendNotification } as unknown as Connection;
        reporter = new MetricsReporter(connection, '/path/to/workspace');
    });

    afterEach(() => {
        reporter.dispose();
        jest.useRealTimers();
    });

    it('sends the first measurement straight away', () => {
        reporter.report(100, null);

        expect(sendNotification).toHaveBeenCalledWith(METRICS_NOTIFICATION, {
            workspace: '/path/to/workspace',
            edit_ms: 100,
            compile_ms: null,
            incremental_requested: false,
            incremental: null,
            memory_bytes: null,
        });
    });

    it('holds later measurements back to a readable rate', () => {
        reporter.report(100, null);
        reporter.report(110, null);
        reporter.report(120, null);

        expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it('sends the latest measurement when the rate limit expires, not the one that hit it', () => {
        // Compiles complete far faster than the status bar can usefully
        // change, so the figure that eventually shows must be the current
        // one rather than whichever happened to fall on the boundary.
        reporter.report(100, null);
        reporter.report(110, null);
        reporter.report(120, 900);

        jest.advanceTimersByTime(2000);

        expect(sendNotification).toHaveBeenCalledTimes(2);
        expect(sendNotification).toHaveBeenLastCalledWith(METRICS_NOTIFICATION, {
            workspace: '/path/to/workspace',
            edit_ms: 120,
            compile_ms: 900,
            incremental_requested: false,
            incremental: null,
            memory_bytes: null,
        });
    });

    it('does not fire a queued send after being disposed', () => {
        reporter.report(100, null);
        reporter.report(110, null);

        reporter.dispose();
        jest.advanceTimersByTime(2000);

        expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it('survives a connection that has gone away', () => {
        sendNotification.mockImplementation(() => { throw new Error('connection is closed'); });

        expect(() => reporter.report(100, null)).not.toThrow();
    });
});
