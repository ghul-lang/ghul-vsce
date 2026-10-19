import { appendFileSync } from 'fs';

import { ExtensionState } from './extension-state';

// Measuring aid: when GHUL_REQUEST_TRACE names a file, every document
// notification and per-document request appends one JSON line to it, with the time, the kind, the document and
// where the registry routes it, without starting anything.
export const TRACE_PATH = process.env.GHUL_REQUEST_TRACE;

export function trace(kind: string, uri: string | undefined, state: ExtensionState) {
    if (!TRACE_PATH) {
        return;
    }

    try {
        const route = uri ? state.describeRoute(uri) : 'none';

        appendFileSync(TRACE_PATH, JSON.stringify({ t: Date.now(), kind, uri, route }) + '\n');
    } catch {
        // a measuring aid never gets in the way
    }
}
