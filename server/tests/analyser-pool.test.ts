import { AnalyserPool } from '../src/analyser-pool';

describe('AnalyserPool', () => {
    it('evicts nothing while within the cap', () => {
        const pool = new AnalyserPool(3);

        expect(pool.evictions(['/a', '/b', '/c'])).toEqual([]);
    });

    it('evicts the least recently used interactively first', () => {
        const pool = new AnalyserPool(2);

        pool.touch('/a', 10);
        pool.touch('/b', 30);
        pool.touch('/c', 20);

        expect(pool.evictions(['/a', '/b', '/c'])).toEqual(['/a']);
        expect(pool.evictions(['/a', '/b', '/c', '/d'], '/d')).toEqual(['/a', '/c']);
    });

    it('treats a project never used interactively as older than any that was', () => {
        const pool = new AnalyserPool(1);

        pool.touch('/used', 5);

        expect(pool.evictions(['/used', '/never'])).toEqual(['/never']);
    });

    it('breaks ties by start order', () => {
        const pool = new AnalyserPool(1);

        expect(pool.evictions(['/first', '/second'])).toEqual(['/first']);
    });

    it('never evicts a pinned project, or the one being kept', () => {
        const pool = new AnalyserPool(1);

        pool.touch('/a', 1);
        pool.touch('/b', 2);
        pool.touch('/c', 3);
        pool.setPinned(['/a']);

        expect(pool.evictions(['/a', '/b', '/c'], '/c')).toEqual(['/b']);
    });

    it('lets pinned projects exceed the cap and says by how many', () => {
        const pool = new AnalyserPool(1);

        pool.setPinned(['/a', '/b', '/c']);

        expect(pool.evictions(['/a', '/b', '/c'])).toEqual([]);
        expect(pool.overCap(['/a', '/b', '/c'])).toBe(2);
        expect(pool.overCap(['/a'])).toBe(0);
    });

    it('forgets a project it is told to', () => {
        const pool = new AnalyserPool(1);

        pool.touch('/a', 1);
        pool.setPinned(['/a']);
        pool.forget('/a');

        expect(pool.idleSince('/a')).toBeUndefined();
        expect(pool.isPinned('/a')).toBe(false);
    });
});
