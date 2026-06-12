import type { Plan, Task } from '$lib/model/types';

/**
 * Shared label logic for the Excel export and the Google Sheets mirror: board
 * cells wear the topmost parent's identity, the side legend shows the
 * per-task breakdown.
 */

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
