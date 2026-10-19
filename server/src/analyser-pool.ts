// Which started analysers to stop, so that no more run than the cap allows.
// Pure bookkeeping: the registry starts and stops them.
//
// The cap is soft: a project with a visible editor is pinned and never chosen,
// so more pinned projects than the cap simply run. Among the rest, the one
// least recently used interactively goes first; a project never used
// interactively counts as older than any that was.
export class AnalyserPool {
    private last_interactive: Map<string, number> = new Map();
    private pinned: Set<string> = new Set();

    constructor(public cap: number) {
    }

    touch(root: string, now: number = Date.now()) {
        this.last_interactive.set(root, now);
    }

    forget(root: string) {
        this.last_interactive.delete(root);
        this.pinned.delete(root);
    }

    setPinned(roots: Iterable<string>) {
        this.pinned = new Set(roots);
    }

    isPinned(root: string): boolean {
        return this.pinned.has(root);
    }

    idleSince(root: string): number | undefined {
        return this.last_interactive.get(root);
    }

    // The roots to stop, oldest interactive use first, given the roots now
    // started in the order they were started. `keep` is never chosen, for the
    // project being started.
    evictions(started: string[], keep?: string): string[] {
        const chosen: string[] = [];
        let remaining = started.length;

        const candidates = started
            .map((root, index) => ({ root, index }))
            .filter(c => c.root !== keep && !this.pinned.has(c.root))
            .sort((a, b) =>
                (this.last_interactive.get(a.root) ?? -Infinity) - (this.last_interactive.get(b.root) ?? -Infinity) ||
                a.index - b.index);

        for (const candidate of candidates) {
            if (remaining <= this.cap) {
                break;
            }

            chosen.push(candidate.root);
            remaining--;
        }

        return chosen;
    }

    // How many of `started` are pinned beyond the cap, for the log.
    overCap(started: string[]): number {
        const pinned = started.filter(root => this.pinned.has(root)).length;

        return Math.max(0, pinned - this.cap);
    }
}
