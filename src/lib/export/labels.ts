import { quarterOf } from '$lib/engine/calendar';
import { PALETTE } from '$lib/model/colors';
import type { Plan, Task } from '$lib/model/types';

/**
 * Shared label logic for the Excel export and the Google Sheets mirror: board
 * cells wear the topmost parent's identity, the side legend shows the
 * per-task breakdown.
 */

/**
 * Stable per-period color, worn by both of the period's spreadsheet tabs (and
 * the Excel tabs): consecutive quarters cycle the palette, custom ranges hash.
 */
export function periodColor(p: { startDate: string; numWeeks: number }): string {
	const q = quarterOf(p.startDate);
	if (q.start === p.startDate && q.weeks === p.numWeeks) {
		const year = Number(p.startDate.slice(0, 4));
		const quarter = Math.floor((Number(p.startDate.slice(5, 7)) - 1) / 3);
		return PALETTE[(year * 4 + quarter) % PALETTE.length];
	}
	let hash = 0;
	for (const ch of `${p.startDate}:${p.numWeeks}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return PALETTE[hash % PALETTE.length];
}

/** The topmost ancestor (the task itself when top-level). */
export function rootOf(task: Task, tasksById: Map<string, Task>): Task {
	let t = task;
	for (let i = 0; t.parentId && i < 10; i++) {
		const parent = tasksById.get(t.parentId);
		if (!parent) break;
		t = parent;
	}
	return t;
}

/** Legend rows: the task tree depth-first, each entry with its nesting depth. */
export function legendEntries(plan: Plan): Array<{ task: Task; depth: number }> {
	const childrenOf = new Map<string, Task[]>();
	for (const t of plan.tasks) {
		if (!t.parentId) continue;
		const list = childrenOf.get(t.parentId) ?? [];
		list.push(t);
		childrenOf.set(t.parentId, list);
	}
	const out: Array<{ task: Task; depth: number }> = [];
	const walk = (t: Task, depth: number) => {
		out.push({ task: t, depth });
		for (const c of childrenOf.get(t.id) ?? []) walk(c, depth + 1);
	};
	for (const t of plan.tasks.filter((t) => !t.parentId)) walk(t, 0);
	return out;
}
