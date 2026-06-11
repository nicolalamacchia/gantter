import type { Assignment, ISODate, Plan, Task } from '$lib/model/types';
import { addDays, isWorkingDay, type WorkCalendar } from './calendar';

/** Where one assignment landed on the calendar. */
export interface Placement {
	assignmentId: string;
	taskId: string;
	memberId: string;
	/** Every working day consumed, ascending. Gaps appear where weekends/holidays/PTO interrupted. */
	days: ISODate[];
	/** Work that did not fit inside the safety horizon (should be 0 in practice). */
	overflowDays: number;
}

/** A run of consecutive calendar days within a placement. */
export interface Run {
	startDate: ISODate;
	endDate: ISODate;
	days: number;
}

export interface TaskRollup {
	taskId: string;
	/** Aggregated over the task itself and all descendant tasks. */
	startDate: ISODate | null;
	endDate: ISODate | null;
	assignedDays: number;
	memberIds: string[];
}

export interface Schedule {
	/** By assignment id. */
	placements: Record<string, Placement>;
	/** Placements per member, in execution order. */
	byMember: Record<string, Placement[]>;
	/** memberId → ISO date → assignmentId, for O(1) cell lookups. */
	dayMap: Record<string, Record<ISODate, string>>;
	/** By task id; includes every task, assigned or not. */
	rollups: Record<string, TaskRollup>;
}

/** Hard bound on calendar scanning, so degenerate input (all days absent) terminates. */
const MAX_SCAN_DAYS = 366 * 10;

function expandAbsences(plan: Plan): Map<string, Set<ISODate>> {
	const byMember = new Map<string, Set<ISODate>>();
	for (const a of plan.absences) {
		let set = byMember.get(a.memberId);
		if (!set) byMember.set(a.memberId, (set = new Set()));
		for (let d = a.startDate; d <= a.endDate; d = addDays(d, 1)) set.add(d);
	}
	return byMember;
}

function sortQueue(assignments: Assignment[]): Assignment[] {
	return [...assignments].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Dependency edges with unknown ids, self-references and cycles removed. */
function sanitizeDeps(tasks: Task[]): Map<string, string[]> {
	const known = new Set(tasks.map((t) => t.id));
	const deps = new Map<string, string[]>();
	for (const t of tasks) {
		const list = (t.dependsOn ?? []).filter((d) => d !== t.id && known.has(d));
		if (list.length) deps.set(t.id, list);
	}
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (id: string) => {
		state.set(id, 'visiting');
		const list = deps.get(id);
		if (list) {
			for (let i = list.length - 1; i >= 0; i--) {
				const d = list[i];
				if (state.get(d) === 'visiting')
					list.splice(i, 1); // break the cycle
				else if (state.get(d) !== 'done') visit(d);
			}
		}
		state.set(id, 'done');
	};
	for (const id of known) if (state.get(id) !== 'done') visit(id);
	return deps;
}

/**
 * Packs one member's queue front-to-back without idle gaps: at each free day,
 * the first assignment in queue order whose dependencies are satisfied runs to
 * completion. If nothing is ready, time advances to the earliest release date
 * (a dependency wait is the only thing that can leave empty days).
 */
function packMember(
	queue: Assignment[],
	startDate: ISODate,
	isAvailable: (d: ISODate) => boolean,
	notBefore: (taskId: string) => ISODate | undefined,
	placements: Record<string, Placement>,
	dayMap: Record<ISODate, string>
): Placement[] {
	const remaining = [...queue];
	const result: Placement[] = [];
	let cursor = startDate;
	let scanned = 0;
	while (remaining.length && scanned < MAX_SCAN_DAYS) {
		if (!isAvailable(cursor)) {
			cursor = addDays(cursor, 1);
			scanned++;
			continue;
		}
		const readyIdx = remaining.findIndex((a) => (notBefore(a.taskId) ?? '') <= cursor);
		if (readyIdx === -1) {
			const release = remaining.map((a) => notBefore(a.taskId)!).sort()[0];
			cursor = release > cursor ? release : addDays(cursor, 1);
			scanned++;
			continue;
		}
		const assignment = remaining.splice(readyIdx, 1)[0];
		let left = Math.max(0, Math.round(assignment.days));
		const consumed: ISODate[] = [];
		while (left > 0 && scanned < MAX_SCAN_DAYS) {
			if (isAvailable(cursor)) {
				consumed.push(cursor);
				dayMap[cursor] = assignment.id;
				left--;
			}
			cursor = addDays(cursor, 1);
			scanned++;
		}
		const placement: Placement = {
			assignmentId: assignment.id,
			taskId: assignment.taskId,
			memberId: assignment.memberId,
			days: consumed,
			overflowDays: left
		};
		placements[assignment.id] = placement;
		result.push(placement);
	}
	for (const assignment of remaining) {
		const placement: Placement = {
			assignmentId: assignment.id,
			taskId: assignment.taskId,
			memberId: assignment.memberId,
			days: [],
			overflowDays: Math.max(0, Math.round(assignment.days))
		};
		placements[assignment.id] = placement;
		result.push(placement);
	}
	return result;
}

/**
 * Deterministically computes the whole board from plan facts.
 * Dependencies couple members' lanes, so scheduling iterates to a fixpoint:
 * each pass packs every member, then release dates ("not before") are derived
 * from the dependency tasks' subtree end dates and the passes repeat until
 * stable. Constraints only push work later, so this converges.
 */
export function computeSchedule(plan: Plan): Schedule {
	const cal: WorkCalendar = {
		workdays: new Set(plan.workdays),
		holidays: new Set(plan.holidays)
	};
	const absences = expandAbsences(plan);
	const deps = sanitizeDeps(plan.tasks);
	const parentOf = new Map(plan.tasks.filter((t) => t.parentId).map((t) => [t.id, t.parentId!]));
	const queues = new Map(
		plan.members.map((m) => [m.id, sortQueue(plan.assignments.filter((a) => a.memberId === m.id))])
	);

	let releaseByTask: Record<string, ISODate> = {};
	let placements: Record<string, Placement> = {};
	let dayMap: Record<string, Record<ISODate, string>> = {};
	let byMember: Record<string, Placement[]> = {};

	/** Dependencies are inherited: a workstream may not start before its ancestors' deps allow. */
	const effectiveRelease = (taskId: string): ISODate | undefined => {
		let release: ISODate | undefined;
		for (let id: string | undefined = taskId; id; id = parentOf.get(id)) {
			const r = releaseByTask[id];
			if (r && (!release || r > release)) release = r;
		}
		return release;
	};

	const maxIterations = Math.min(50, plan.tasks.length + 2);
	for (let iteration = 0; iteration < maxIterations; iteration++) {
		placements = {};
		dayMap = {};
		byMember = {};
		for (const member of plan.members) {
			const absent = absences.get(member.id) ?? new Set<ISODate>();
			const memberDays: Record<ISODate, string> = {};
			byMember[member.id] = packMember(
				queues.get(member.id) ?? [],
				plan.startDate,
				(d) => isWorkingDay(d, cal) && !absent.has(d),
				effectiveRelease,
				placements,
				memberDays
			);
			dayMap[member.id] = memberDays;
		}

		if (deps.size === 0) break;
		const subtreeEnd = computeSubtreeEnds(plan, placements);
		const next: Record<string, ISODate> = {};
		for (const [taskId, depIds] of deps) {
			let release: ISODate | undefined;
			for (const depId of depIds) {
				const end = subtreeEnd.get(depId);
				if (end) {
					const candidate = addDays(end, 1);
					if (!release || candidate > release) release = candidate;
				}
			}
			if (release) next[taskId] = release;
		}
		const stable =
			Object.keys(next).length === Object.keys(releaseByTask).length &&
			Object.entries(next).every(([k, v]) => releaseByTask[k] === v);
		releaseByTask = next;
		if (stable) break;
	}

	return { placements, byMember, dayMap, rollups: computeRollups(plan, placements) };
}

function childrenIndex(tasks: Task[]): Map<string, string[]> {
	const children = new Map<string, string[]>();
	for (const t of tasks) {
		if (t.parentId) {
			const list = children.get(t.parentId) ?? [];
			list.push(t.id);
			children.set(t.parentId, list);
		}
	}
	return children;
}

function subtreePlacementsIndex(
	plan: Plan,
	placements: Record<string, Placement>
): Map<string, Placement[]> {
	const children = childrenIndex(plan.tasks);
	const own = new Map<string, Placement[]>();
	for (const a of plan.assignments) {
		const p = placements[a.id];
		if (!p) continue;
		const list = own.get(a.taskId) ?? [];
		list.push(p);
		own.set(a.taskId, list);
	}
	const memo = new Map<string, Placement[]>();
	const collect = (taskId: string): Placement[] => {
		const cached = memo.get(taskId);
		if (cached) return cached;
		const all = [...(own.get(taskId) ?? []), ...(children.get(taskId) ?? []).flatMap(collect)];
		memo.set(taskId, all);
		return all;
	};
	for (const t of plan.tasks) collect(t.id);
	return memo;
}

/** Last scheduled day of each task's subtree (own assignments + all descendants'). */
function computeSubtreeEnds(
	plan: Plan,
	placements: Record<string, Placement>
): Map<string, ISODate | null> {
	const subtree = subtreePlacementsIndex(plan, placements);
	const ends = new Map<string, ISODate | null>();
	for (const t of plan.tasks) {
		const dated = (subtree.get(t.id) ?? []).filter((p) => p.days.length > 0);
		ends.set(
			t.id,
			dated.length
				? dated
						.map((p) => p.days[p.days.length - 1])
						.sort()
						.at(-1)!
				: null
		);
	}
	return ends;
}

function computeRollups(
	plan: Plan,
	placements: Record<string, Placement>
): Record<string, TaskRollup> {
	const subtree = subtreePlacementsIndex(plan, placements);
	const rollups: Record<string, TaskRollup> = {};
	for (const task of plan.tasks) {
		const all = subtree.get(task.id) ?? [];
		const dated = all.filter((p) => p.days.length > 0);
		rollups[task.id] = {
			taskId: task.id,
			startDate: dated.length ? dated.map((p) => p.days[0]).sort()[0] : null,
			endDate: dated.length
				? dated
						.map((p) => p.days[p.days.length - 1])
						.sort()
						.at(-1)!
				: null,
			assignedDays: all.reduce((sum, p) => sum + p.days.length + p.overflowDays, 0),
			memberIds: [...new Set(all.map((p) => p.memberId))]
		};
	}
	return rollups;
}

/** Groups a placement's days into runs of consecutive calendar days. */
export function toRuns(days: ISODate[]): Run[] {
	const runs: Run[] = [];
	for (const day of days) {
		const last = runs[runs.length - 1];
		if (last && addDays(last.endDate, 1) === day) {
			last.endDate = day;
			last.days++;
		} else {
			runs.push({ startDate: day, endDate: day, days: 1 });
		}
	}
	return runs;
}
