// The status bar item's tooltip and the detail view behind it. Pure
// formatting, with nothing from the editor, so it can be tested alone.

import * as path from 'path';

// Mirrors the payload of the server's ghul/metrics notification
// (server/src/metrics-reporter.ts). Durations are in milliseconds, and null
// until the analyser has completed one of that kind of run.
export interface IncrementalStats {
	body_rewalk: number;
	interface_incremental: number;
	full_rebuild: number;
	total: number;
	top_decline_reason: string | null;
	top_decline_count: number;
}

export interface AnalysisMetrics {
	workspace: string;
	edit_ms: number | null;
	compile_ms: number | null;
	incremental_requested: boolean;
	incremental: IncrementalStats | null;
	// Absent from a server that predates the field.
	memory_bytes?: number | null;
}

// Mirrors the server's ghul/pool notification. `running` is absent from a
// server that predates it, in which case every started analyser is listed.
export interface PoolState {
	started: string[];
	running?: string[];
	cap: number;
	pinned: string[];
}

export function formatDuration(milliseconds: number): string {
	return milliseconds >= 1000
		? `${(milliseconds / 1000).toFixed(1)}s`
		: `${milliseconds.toFixed(0)}ms`;
}

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

// "0.75GB" from a tenth of a gigabyte up, "85MB" below that.
export function formatMemory(bytes: number): string {
	return bytes >= GIGABYTE / 10
		? `${(bytes / GIGABYTE).toFixed(2)}GB`
		: `${Math.round(bytes / MEGABYTE)}MB`;
}

// The root as the user knows it: relative to the open folder that holds it,
// the folder's own name when it is the folder, and the full path when no open
// folder holds it.
export function relativeToFolders(root: string, folders: string[]): string {
	let best: string | null = null;

	for (const folder of folders) {
		const relative = path.relative(folder, root);

		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			continue;
		}

		if (best == null || folder.length > best.length) {
			best = folder;
		}
	}

	if (best == null) {
		return root;
	}

	const relative = path.relative(best, root);

	return relative === '' ? path.basename(best) : relative;
}

// The share of edits served without rebuilding the project, or null where the
// analyser is not doing incremental analysis, or has had no edits to count.
export function incrementalPercent(m: AnalysisMetrics): number | null {
	if (!m.incremental_requested || !m.incremental || m.incremental.total === 0) {
		return null;
	}

	const { body_rewalk, interface_incremental, total } = m.incremental;

	return Math.round(((body_rewalk + interface_incremental) / total) * 100);
}

function describeAnalyser(
	ordinal: number,
	cap: number,
	root: string,
	m: AnalysisMetrics | undefined,
	folders: string[]
): string {
	const parts = [`${ordinal}/${cap}`, relativeToFolders(root, folders)];

	if (m?.memory_bytes != null && m.memory_bytes > 0) {
		parts.push(formatMemory(m.memory_bytes));
	}

	if (m && (m.edit_ms != null || m.compile_ms != null)) {
		parts.push(
			`edit ${m.edit_ms == null ? '-' : formatDuration(m.edit_ms)} / ` +
			`full ${m.compile_ms == null ? '-' : formatDuration(m.compile_ms)}`
		);
	}

	const percent = m ? incrementalPercent(m) : null;

	if (percent != null) {
		parts.push(`incr ${percent}%`);
	}

	return parts.join('  ');
}

// The roots to list: those with a compiler process alive.
export function runningRoots(pool: PoolState | null): string[] {
	return pool ? (pool.running ?? pool.started) : [];
}

export function describeTooltip(
	pool: PoolState | null,
	metrics: Map<string, AnalysisMetrics>,
	folders: string[]
): string {
	const roots = runningRoots(pool);

	if (!pool || roots.length === 0) {
		return 'ghūl language support';
	}

	return roots
		.map((root, index) => describeAnalyser(index + 1, pool.cap, root, metrics.get(root), folders))
		.join('\n');
}

// What the status bar item opens when clicked: everything known about each
// running analyser, in a document that scrolls.
export function describeDetails(
	pool: PoolState | null,
	metrics: Map<string, AnalysisMetrics>,
	folders: string[]
): string {
	const roots = runningRoots(pool);

	if (!pool || roots.length === 0) {
		return 'ghūl language support: no analysers running\n';
	}

	const blocks = roots.map((root, index) => {
		const m = metrics.get(root);
		const lines = [
			`${index + 1}/${pool.cap}  ${relativeToFolders(root, folders)}`,
			`  path: ${root}${pool.pinned.includes(root) ? ' (visible)' : ''}`
		];

		if (m?.memory_bytes != null && m.memory_bytes > 0) {
			lines.push(`  memory: ${formatMemory(m.memory_bytes)}`);
		}

		if (m) {
			lines.push(`  edit analysis: ${m.edit_ms == null ? '-' : formatDuration(m.edit_ms)}`);
			lines.push(`  full analysis: ${m.compile_ms == null ? '-' : formatDuration(m.compile_ms)}`);
			lines.push(...describeIncremental(m));
		}

		return lines.join('\n');
	});

	return `analysers: ${roots.length} of ${pool.cap}\n\n${blocks.join('\n\n')}\n`;
}

// What the analyser did with the edits it was given, as against what it was
// asked to do with them. The reason is shown with the rate because it tells
// the two ways of getting a low one apart: `not-eligible` for effectively
// every rebuild means incremental analysis is not being attempted, where any
// other reason means it is attempted and the edits are refused on their merits.
function describeIncremental(m: AnalysisMetrics): string[] {
	if (!m.incremental_requested) {
		return ['  incremental analysis: off'];
	}

	if (!m.incremental || m.incremental.total === 0) {
		return ['  incremental analysis: on, no edits yet'];
	}

	const { body_rewalk, interface_incremental, full_rebuild, total } = m.incremental;
	const percent = incrementalPercent(m);

	const lines = [
		`  incremental analysis: on, ${percent}% of ${total} edit${total === 1 ? '' : 's'}`,
		`    body re-walk: ${body_rewalk}`,
		`    interface: ${interface_incremental}`,
		`    full rebuild: ${full_rebuild}`
	];

	if (m.incremental.top_decline_reason) {
		lines.push(`    mostly declined: ${m.incremental.top_decline_reason} (${m.incremental.top_decline_count})`);
	}

	return lines;
}
