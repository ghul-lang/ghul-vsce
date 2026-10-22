import {
    AnalysisMetrics, PoolState, describeDetails, describeTooltip, formatMemory, relativeToFolders
} from '../../client/src/status-tooltip';

function metrics(root: string, extra: Partial<AnalysisMetrics> = {}): AnalysisMetrics {
    return {
        workspace: root,
        edit_ms: 20,
        compile_ms: 60,
        incremental_requested: true,
        incremental: { body_rewalk: 6, interface_incremental: 0, full_rebuild: 2, total: 8, top_decline_reason: null, top_decline_count: 0 },
        memory_bytes: 0.75 * 1024 * 1024 * 1024,
        ...extra
    };
}

describe('formatMemory', () => {
    it('writes gigabytes from a tenth of one up', () => {
        expect(formatMemory(0.75 * 1024 ** 3)).toBe('0.75GB');
        expect(formatMemory(1.5 * 1024 ** 3)).toBe('1.50GB');
    });

    it('writes megabytes below that', () => {
        expect(formatMemory(85 * 1024 ** 2)).toBe('85MB');
    });
});

describe('relativeToFolders', () => {
    it('is relative to the folder that holds the root', () => {
        expect(relativeToFolders('/w/a/b', ['/w/a'])).toBe('b');
    });

    it('is the folder name for the folder itself', () => {
        expect(relativeToFolders('/w/a', ['/w/a'])).toBe('a');
    });

    it('prefers the innermost folder', () => {
        expect(relativeToFolders('/w/a/b/c', ['/w', '/w/a'])).toBe('b/c');
    });

    it('is the full path when no folder holds it', () => {
        expect(relativeToFolders('/other/x', ['/w/a'])).toBe('/other/x');
    });
});

describe('describeTooltip', () => {
    const pool: PoolState = { started: ['/w/a', '/w/b', '/w/c'], running: ['/w/a', '/w/c'], cap: 4, pinned: [] };

    it('lists only running analysers, in full', () => {
        const map = new Map([['/w/a', metrics('/w/a')], ['/w/c', metrics('/w/c', { incremental: null })]]);

        expect(describeTooltip(pool, map, ['/w'])).toBe(
            'a:\n' +
            '0.75GB / 20ms edit / 60ms full / 75% incremental\n' +
            '\n' +
            'c:\n' +
            '0.75GB / 20ms edit / 60ms full'
        );
    });

    it('lists the most recently used analyser first, never-used ones last', () => {
        const withUse: PoolState = {
            ...pool,
            running: ['/w/a', '/w/b', '/w/c'],
            last_used: { '/w/c': 2000, '/w/a': 1000 }
        };

        expect(describeTooltip(withUse, new Map(), ['/w'])).toBe(
            'c:\n' +
            '\n' +
            'a:\n' +
            '\n' +
            'b:'
        );
    });

    it('keeps the running order without last-use times', () => {
        expect(describeTooltip(pool, new Map(), ['/w'])).toBe(
            'a:\n' +
            '\n' +
            'c:'
        );
    });

    it('leaves out memory the analyser cannot report', () => {
        const map = new Map([['/w/a', metrics('/w/a', { memory_bytes: null })]]);

        expect(describeTooltip({ ...pool, running: ['/w/a'] }, map, ['/w']))
            .toBe('a:\n20ms edit / 60ms full / 75% incremental');
    });

    it('leaves out the incremental share when incremental analysis is off', () => {
        const map = new Map([['/w/a', metrics('/w/a', { incremental_requested: false })]]);

        expect(describeTooltip({ ...pool, running: ['/w/a'] }, map, ['/w']))
            .toBe('a:\n0.75GB / 20ms edit / 60ms full');
    });

    it('lists every started analyser for a server that does not say which run', () => {
        expect(describeTooltip({ started: ['/w/a'], cap: 2, pinned: [] }, new Map(), ['/w']))
            .toBe('a:');
    });

    it('says what it is when nothing runs', () => {
        expect(describeTooltip({ ...pool, running: [] }, new Map(), ['/w'])).toBe('ghūl language support');
        expect(describeTooltip(null, new Map(), [])).toBe('ghūl language support');
    });
});

describe('describeDetails', () => {
    it('carries the full figures for each running analyser', () => {
        const pool: PoolState = { started: ['/w/a'], running: ['/w/a'], cap: 4, pinned: ['/w/a'] };
        const text = describeDetails(pool, new Map([['/w/a', metrics('/w/a')]]), ['/w']);

        expect(text).toContain('path: /w/a (visible)');
        expect(text).toContain('memory: 0.75GB');
        expect(text).toContain('incremental analysis: on, 75% of 8 edits');
        expect(text).toContain('full rebuild: 2');
        expect(text).not.toContain('/4');
        expect(text).not.toContain('of 4');
    });
});
