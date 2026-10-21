import { Connection } from 'vscode-languageserver';

import { log } from './log';
import { IncrementalStats } from './incremental-stats';

// The notification the status bar item in the client listens for. Not part of
// LSP: a custom method, ignored by any other client.
export const METRICS_NOTIFICATION = 'ghul/metrics';

export interface AnalysisMetrics {
    // Identifies which workspace folder the numbers belong to, so a client
    // hosting several does not attribute one folder's latency to another.
    workspace: string;
    // Smoothed round-trip time of an incremental (per-edit) analysis, in
    // milliseconds; null until one has completed.
    edit_ms: number | null;
    // Smoothed round-trip time of a full compile of the project, in
    // milliseconds; null until one has completed.
    compile_ms: number | null;
    // Whether the extension asked the analyser for incremental analysis. What
    // was asked for and what is happening are separate facts, and the case
    // worth diagnosing is exactly where they disagree.
    incremental_requested: boolean;
    // What the analyser's own counters say it did, or null before it has been
    // asked or if it answered nothing.
    incremental: IncrementalStats | null;
    // Bytes of memory the analyser's process occupies, or null where it cannot
    // say. Not the managed heap: the resident or working set.
    memory_bytes: number | null;
}

// Rate at which measurements reach the status bar. Compiles complete far more
// often than a number in the corner of the screen can usefully change, and a
// figure that flickers on every keystroke is harder to read than one that
// settles.
const REPORT_INTERVAL_MS = 2000;

// Pushes analysis timings to the client for display, at a readable rate.
//
// Sends the first measurement immediately — the user has just opened a project
// and an empty status bar item that fills in seconds later reads as broken —
// then at most one every REPORT_INTERVAL_MS, always carrying the latest
// numbers rather than the ones that happened to fall on the boundary.
export class MetricsReporter {
    private connection: Connection;
    private workspace_root: string;

    private latest: AnalysisMetrics | null = null;
    private last_sent_at: number = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor(connection: Connection, workspace_root: string) {
        this.connection = connection;
        this.workspace_root = workspace_root;
    }

    report(
        edit_ms: number | null,
        compile_ms: number | null,
        incremental_requested: boolean = false,
        incremental: IncrementalStats | null = null,
        memory_bytes: number | null = null
    ) {
        this.latest = {
            workspace: this.workspace_root,
            edit_ms,
            compile_ms,
            incremental_requested,
            incremental,
            memory_bytes
        };

        if (this.timer) {
            return;
        }

        const since = Date.now() - this.last_sent_at;

        if (since >= REPORT_INTERVAL_MS) {
            this.send();

            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.send();
        }, REPORT_INTERVAL_MS - since);

        this.timer.unref?.();
    }

    // Stop the trailing send. The queue calls this when the compiler goes away,
    // so a pending timer cannot fire into a torn-down connection.
    dispose() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private send() {
        if (!this.latest || !this.connection?.sendNotification) {
            return;
        }

        this.last_sent_at = Date.now();

        try {
            this.connection.sendNotification(METRICS_NOTIFICATION, this.latest);
        } catch (e) {
            // A closed connection is the ordinary case here — the editor
            // shutting down while a trailing send is queued. Nothing depends
            // on the notification arriving.
            log(`could not report analysis metrics: ${e}`);
        }
    }
}
