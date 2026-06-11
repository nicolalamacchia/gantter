import { buildAbsenceDayMap } from '$lib/engine/board';
import {
	addDays,
	addWorkingDays,
	countWorkingDays,
	nextWorkingDay,
	type WorkCalendar
} from '$lib/engine/calendar';
import {
	carveChunk,
	mergeAdjacentChunks,
	moveShare,
	paintChunk,
	moveWholeTask,
	shiftAbsence,
	splitDrop,
	type MoveContext
} from '$lib/engine/moves';
import { computeSchedule } from '$lib/engine/schedule';
import {
	newId,
	SCHEMA_VERSION,
	type Absence,
	type Assignment,
	type ISODate,
	type Plan,
	type Task
} from '$lib/model/types';
import { loadBoot, saveRegistry, type PlanBoot } from './persistence';
import { createDemoPlan } from './seed';

const UNDO_LIMIT = 200;

/**
 * Single source of truth. Every mutation funnels through #commit with a
 * command name — that is the seam where a future sync layer (server / CRDT)
 * plugs in, and what powers undo/redo today.
 */
function boot(): PlanBoot & { fresh: boolean } {
	const loaded = loadBoot();
	if (loaded) {
		// Heal plans saved before the merge invariant existed.
		for (const plan of Object.values(loaded.registry)) {
			plan.assignments = mergeAdjacentChunks(plan.assignments);
		}
		return { ...loaded, fresh: false };
	}
	const demo = createDemoPlan();
	return { registry: { [demo.id]: demo }, active: demo, fresh: true };
}

export class PlanStore {
	#boot = boot();
	/** All plans, one per period; the active one is mirrored here on every change. */
	#registry: Record<string, Plan> = this.#boot.registry;
	plan = $state<Plan>(this.#boot.active);
	/** True when nothing was stored at startup (first run in this browser). */
	readonly bootWasFresh = this.#boot.fresh;
	/** Bumped when the registry changes, so the UI can re-derive period markers. */
	registryVersion = $state(0);
	schedule = $derived(computeSchedule(this.plan));

	canUndo = $state(false);
	canRedo = $state(false);
	#undoStack: Plan[] = [];
	#redoStack: Plan[] = [];

	// ---- derived lookups ----------------------------------------------------

	tasksById = $derived(new Map(this.plan.tasks.map((t) => [t.id, t])));
	membersById = $derived(new Map(this.plan.members.map((m) => [m.id, m])));
	groupsById = $derived(new Map(this.plan.groups.map((g) => [g.id, g])));
	rootTasks = $derived(this.plan.tasks.filter((t) => !t.parentId));
	childrenByParent = $derived.by(() => {
		const map = new Map<string, Task[]>();
		for (const t of this.plan.tasks) {
			if (!t.parentId) continue;
			const list = map.get(t.parentId) ?? [];
			list.push(t);
			map.set(t.parentId, list);
		}
		return map;
	});
	/** memberId → ISO date → absenceId, for cell rendering and PTO removal. */
	absenceDayMap = $derived(buildAbsenceDayMap(this.plan.absences));
	holidaySet = $derived(new Set(this.plan.holidays));

	// ---- command plumbing ---------------------------------------------------

	#snapshot(): Plan {
		return structuredClone($state.snapshot(this.plan)) as Plan;
	}

	#commit(_command: string, mutate: (plan: Plan) => void) {
		this.#undoStack.push(this.#snapshot());
		if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
		this.#redoStack = [];
		mutate(this.plan);
		// Invariant: back-to-back chunks of the same task are one block.
		this.plan.assignments = mergeAdjacentChunks(
			$state.snapshot(this.plan.assignments) as Assignment[]
		);
		this.#afterChange();
	}

	#afterChange() {
		this.canUndo = this.#undoStack.length > 0;
		this.canRedo = this.#redoStack.length > 0;
		this.#registry[this.plan.id] = $state.snapshot(this.plan) as Plan;
		this.registryVersion++;
		saveRegistry(this.plan.id, this.#registry);
	}

	undo() {
		const prev = this.#undoStack.pop();
		if (!prev) return;
		this.#redoStack.push(this.#snapshot());
		this.plan = prev;
		this.#afterChange();
	}

	redo() {
		const next = this.#redoStack.pop();
		if (!next) return;
		this.#undoStack.push(this.#snapshot());
		this.plan = next;
		this.#afterChange();
	}

	// ---- plan meta ----------------------------------------------------------

	updatePlanMeta(patch: Partial<Pick<Plan, 'name' | 'startDate' | 'numWeeks' | 'showWeekends'>>) {
		this.#commit('updatePlanMeta', (plan) => Object.assign(plan, patch));
	}

	/**
	 * Applies the server-provisioned team/board config to the active plan:
	 * groups and members upsert by id (never deleted — assignments stay safe),
	 * board defaults are set when provided. No-ops commit nothing.
	 */
	applyServerTeam(
		team: { groups?: Plan['groups']; members?: Plan['members'] } | undefined,
		board: { workdays?: number[]; showWeekends?: boolean } | undefined
	) {
		if (!team && !board) return;
		const before = JSON.stringify({
			g: this.plan.groups,
			m: this.plan.members,
			w: this.plan.workdays,
			s: this.plan.showWeekends
		});
		const preview = structuredClone($state.snapshot(this.plan)) as Plan;
		const upsert = (plan: Plan) => {
			for (const group of team?.groups ?? []) {
				const existing = plan.groups.find((g) => g.id === group.id);
				if (existing) Object.assign(existing, group);
				else plan.groups.push({ ...group });
			}
			for (const member of team?.members ?? []) {
				const existing = plan.members.find((m) => m.id === member.id);
				if (existing) Object.assign(existing, member);
				else plan.members.push({ ...member });
			}
			if (board?.workdays?.length) plan.workdays = [...board.workdays];
			if (board?.showWeekends !== undefined) plan.showWeekends = board.showWeekends;
		};
		upsert(preview);
		const after = JSON.stringify({
			g: preview.groups,
			m: preview.members,
			w: preview.workdays,
			s: preview.showWeekends
		});
		if (after === before) return;
		this.#commit('applyServerTeam', upsert);
	}

	/** Working weekdays (ISO 1–7); at least one must remain. */
	setWorkdays(days: number[]) {
		const cleaned = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
		if (!cleaned.length) return;
		this.#commit('setWorkdays', (plan) => {
			plan.workdays = cleaned;
		});
	}

	/** Merges fetched holiday dates into the plan; returns how many were new. */
	addHolidays(dates: ISODate[]): number {
		const existing = new Set(this.plan.holidays);
		const fresh = [...new Set(dates)].filter((d) => !existing.has(d));
		if (fresh.length) {
			this.#commit('addHolidays', (plan) => {
				plan.holidays = [...plan.holidays, ...fresh].sort();
			});
		}
		return fresh.length;
	}

	toggleHoliday(date: ISODate) {
		this.#commit('toggleHoliday', (plan) => {
			const i = plan.holidays.indexOf(date);
			if (i >= 0) plan.holidays.splice(i, 1);
			else plan.holidays.push(date);
		});
	}

	/** Imports attach to the period they describe, replacing that period's plan. */
	importPlan(plan: Plan) {
		const competitor = Object.values(this.#registry).find(
			(p) => p.id !== plan.id && p.startDate === plan.startDate && p.numWeeks === plan.numWeeks
		);
		if (competitor) delete this.#registry[competitor.id];
		this.#undoStack.push(this.#snapshot());
		if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
		this.#redoStack = [];
		plan.assignments = mergeAdjacentChunks(plan.assignments);
		this.plan = plan;
		this.#afterChange();
	}

	planForPeriod(startDate: ISODate, numWeeks: number): Plan | undefined {
		if (this.plan.startDate === startDate && this.plan.numWeeks === numWeeks) return this.plan;
		return Object.values(this.#registry).find(
			(p) => p.id !== this.plan.id && p.startDate === startDate && p.numWeeks === numWeeks
		);
	}

	hasDataForPeriod(startDate: ISODate, numWeeks: number): boolean {
		const plan = this.planForPeriod(startDate, numWeeks);
		return !!plan && (plan.tasks.length > 0 || plan.absences.length > 0);
	}

	/**
	 * Each period owns its own plan. Switching stashes the current one and
	 * loads the target period's plan — or starts a fresh one with the team
	 * carried over. Undo history is per-period and resets on switch.
	 */
	switchToPeriod(startDate: ISODate, numWeeks: number, label: string) {
		if (this.plan.startDate === startDate && this.plan.numWeeks === numWeeks) return;
		this.#registry[this.plan.id] = this.#snapshot();
		const existing = Object.values(this.#registry).find(
			(p) => p.startDate === startDate && p.numWeeks === numWeeks
		);
		this.#undoStack = [];
		this.#redoStack = [];
		this.plan =
			existing ??
			({
				id: `period-${startDate}-${numWeeks}`,
				name: label,
				schemaVersion: SCHEMA_VERSION,
				startDate,
				numWeeks,
				workdays: [...($state.snapshot(this.plan.workdays) as number[])],
				showWeekends: this.plan.showWeekends,
				holidays: [],
				groups: structuredClone($state.snapshot(this.plan.groups)) as Plan['groups'],
				members: structuredClone($state.snapshot(this.plan.members)) as Plan['members'],
				tasks: [],
				assignments: [],
				absences: []
			} satisfies Plan);
		this.#afterChange();
	}

	resetToDemo() {
		this.importPlan(createDemoPlan());
	}

	/**
	 * Creates continuation shells of the given tasks (same ids, no assignments)
	 * in another period's plan, leaving the current period untouched. Returns
	 * how many tasks were added (already-present ids are skipped).
	 */
	continueTasksInPeriod(
		taskIds: string[],
		startDate: ISODate,
		numWeeks: number,
		label: string
	): number {
		if (this.plan.startDate === startDate && this.plan.numWeeks === numWeeks) return 0;
		const source = this.#snapshot();
		const stored = Object.values(this.#registry).find(
			(p) => p.id !== source.id && p.startDate === startDate && p.numWeeks === numWeeks
		);
		const target: Plan = stored
			? (structuredClone(stored) as Plan)
			: {
					id: `period-${startDate}-${numWeeks}`,
					name: label,
					schemaVersion: SCHEMA_VERSION,
					startDate,
					numWeeks,
					workdays: [...source.workdays],
					showWeekends: source.showWeekends,
					holidays: [],
					groups: structuredClone(source.groups),
					members: structuredClone(source.members),
					tasks: [],
					assignments: [],
					absences: []
				};
		for (const g of source.groups) {
			if (!target.groups.some((x) => x.id === g.id)) target.groups.push({ ...g });
		}
		let added = 0;
		for (const id of taskIds) {
			const task = source.tasks.find((t) => t.id === id);
			if (!task) continue;
			if (task.parentId && !target.tasks.some((x) => x.id === task.parentId)) {
				const parent = source.tasks.find((x) => x.id === task.parentId);
				if (parent) target.tasks.push({ ...parent, dependsOn: undefined });
			}
			if (!target.tasks.some((x) => x.id === id)) {
				target.tasks.push({ ...task, dependsOn: undefined });
				added++;
			}
		}
		if (added) {
			this.#registry[target.id] = target;
			this.registryVersion++;
			saveRegistry(this.plan.id, this.#registry);
		}
		return added;
	}

	/**
	 * Rolls over only the overflowing part of a task (and its workstreams): each
	 * assignment's days beyond the period end move to the target period as a
	 * continuation of the same task (same id, same member, queued first there);
	 * the work that fits stays exactly where it is.
	 */
	rolloverTaskSpill(taskId: string, startDate: ISODate, numWeeks: number, label: string): number {
		if (this.plan.startDate === startDate && this.plan.numWeeks === numWeeks) return 0;
		const periodEnd = addDays(this.plan.startDate, this.plan.numWeeks * 7 - 1);
		const source = this.#snapshot();
		const schedule = this.schedule;
		const closure = new Set<string>();
		const walk = (id: string) => {
			closure.add(id);
			for (const c of this.childrenByParent.get(id) ?? []) walk(c.id);
		};
		walk(taskId);

		const spills: Array<{ assignment: Assignment; spillDays: number }> = [];
		for (const assignment of source.assignments) {
			if (!closure.has(assignment.taskId)) continue;
			const placement = schedule.placements[assignment.id];
			if (!placement) continue;
			const beyond = placement.days.filter((d) => d > periodEnd).length + placement.overflowDays;
			if (beyond > 0) {
				spills.push({ assignment, spillDays: Math.min(beyond, assignment.days) });
			}
		}
		if (!spills.length) return 0;

		const stored = Object.values(this.#registry).find(
			(p) => p.id !== source.id && p.startDate === startDate && p.numWeeks === numWeeks
		);
		const target: Plan = stored
			? (structuredClone(stored) as Plan)
			: {
					id: `period-${startDate}-${numWeeks}`,
					name: label,
					schemaVersion: SCHEMA_VERSION,
					startDate,
					numWeeks,
					workdays: [...source.workdays],
					showWeekends: source.showWeekends,
					holidays: [],
					groups: structuredClone(source.groups),
					members: structuredClone(source.members),
					tasks: [],
					assignments: [],
					absences: []
				};

		// Continuation shells (same ids) + the people whose work spills.
		for (const g of source.groups) {
			if (!target.groups.some((x) => x.id === g.id)) target.groups.push({ ...g });
		}
		const spillTaskIds = new Set(spills.map((s) => s.assignment.taskId));
		for (const id of spillTaskIds) {
			const task = source.tasks.find((t) => t.id === id);
			if (!task) continue;
			if (task.parentId && !target.tasks.some((x) => x.id === task.parentId)) {
				const parent = source.tasks.find((x) => x.id === task.parentId);
				if (parent) target.tasks.push({ ...parent, dependsOn: undefined });
			}
			if (!target.tasks.some((x) => x.id === id)) {
				target.tasks.push({ ...task, dependsOn: undefined });
			}
		}
		for (const { assignment } of spills) {
			const member = source.members.find((m) => m.id === assignment.memberId);
			if (member && !target.members.some((m) => m.id === member.id)) {
				target.members.push({ ...member });
			}
		}
		// Spilled work continues first in each member's next-period queue.
		const byMember = new Map<string, Array<{ assignment: Assignment; spillDays: number }>>();
		for (const spill of spills) {
			const list = byMember.get(spill.assignment.memberId) ?? [];
			list.push(spill);
			byMember.set(spill.assignment.memberId, list);
		}
		for (const [memberId, list] of byMember) {
			const existingMin = target.assignments
				.filter((a) => a.memberId === memberId)
				.reduce((min, a) => Math.min(min, a.order), 0);
			list.forEach(({ assignment, spillDays }, index) => {
				target.assignments.push({
					id: newId(),
					taskId: assignment.taskId,
					memberId,
					days: spillDays,
					order: existingMin - list.length + index
				});
			});
		}
		target.assignments = mergeAdjacentChunks(target.assignments);
		this.#registry[target.id] = target;
		this.registryVersion++;
		saveRegistry(this.plan.id, this.#registry);

		// Shrink (or drop) the source assignments by their spilled days.
		this.#commit('rolloverTaskSpill', (plan) => {
			const removeIds = new Set<string>();
			for (const { assignment, spillDays } of spills) {
				const a = plan.assignments.find((x) => x.id === assignment.id);
				if (!a) continue;
				if (a.days <= spillDays) removeIds.add(a.id);
				else a.days -= spillDays;
			}
			plan.assignments = plan.assignments.filter((x) => !removeIds.has(x.id));
		});
		return spills.reduce((sum, s) => sum + s.spillDays, 0);
	}

	/** Tasks from other periods that don't exist here yet — candidates for continuation. */
	registryTaskChoices(): Array<{ planName: string; task: Task }> {
		void this.registryVersion;
		const currentIds = new Set(this.plan.tasks.map((t) => t.id));
		const seen = new Set<string>();
		const out: Array<{ planName: string; task: Task }> = [];
		for (const plan of Object.values(this.#registry)) {
			if (plan.id === this.plan.id) continue;
			for (const task of plan.tasks) {
				if (currentIds.has(task.id) || seen.has(task.id)) continue;
				seen.add(task.id);
				out.push({ planName: plan.name, task });
			}
		}
		return out.sort((a, b) => a.task.name.localeCompare(b.task.name));
	}

	/**
	 * Moves tasks (with their whole subtrees and assignments) to another
	 * period's plan, keeping each assignment's working-day offset from the
	 * period start. Follows the tasks by switching to the target period; the
	 * action spans two plans, so it is not undoable. Returns how many tasks moved.
	 */
	moveTasksToPeriod(
		taskIds: string[],
		startDate: ISODate,
		numWeeks: number,
		label: string
	): number {
		const closure = new Set<string>();
		const walk = (id: string) => {
			if (closure.has(id)) return;
			closure.add(id);
			for (const c of this.childrenByParent.get(id) ?? []) walk(c.id);
		};
		for (const id of taskIds) walk(id);
		if (!closure.size) return 0;
		if (this.plan.startDate === startDate && this.plan.numWeeks === numWeeks) return 0;

		const source = this.#snapshot();
		const sourceSchedule = this.schedule;
		const sourceCal: WorkCalendar = {
			workdays: new Set(source.workdays),
			holidays: new Set(source.holidays)
		};

		const stored = Object.values(this.#registry).find(
			(p) => p.id !== source.id && p.startDate === startDate && p.numWeeks === numWeeks
		);
		const target: Plan = stored
			? (structuredClone(stored) as Plan)
			: {
					id: `period-${startDate}-${numWeeks}`,
					name: label,
					schemaVersion: SCHEMA_VERSION,
					startDate,
					numWeeks,
					workdays: [...source.workdays],
					showWeekends: source.showWeekends,
					holidays: [],
					groups: [],
					members: [],
					tasks: [],
					assignments: [],
					absences: []
				};

		// The moved work may involve people the target plan doesn't know yet.
		for (const g of source.groups) {
			if (!target.groups.some((x) => x.id === g.id)) target.groups.push({ ...g });
		}
		for (const m of source.members) {
			if (!target.members.some((x) => x.id === m.id)) target.members.push({ ...m });
		}

		// Tasks: moved subtrees, plus parent shells for children whose parent stays.
		const movedTasks = source.tasks.filter((t) => closure.has(t.id));
		for (const t of movedTasks) {
			if (
				t.parentId &&
				!closure.has(t.parentId) &&
				!target.tasks.some((x) => x.id === t.parentId)
			) {
				const parent = source.tasks.find((x) => x.id === t.parentId);
				if (parent) target.tasks.push({ ...parent, dependsOn: undefined });
			}
		}
		for (const t of movedTasks) {
			if (!target.tasks.some((x) => x.id === t.id)) target.tasks.push({ ...t });
		}
		const targetTaskIds = new Set(target.tasks.map((t) => t.id));
		for (const t of target.tasks) {
			if (t.dependsOn) {
				const kept = t.dependsOn.filter((d) => targetTaskIds.has(d));
				t.dependsOn = kept.length ? kept : undefined;
			}
		}

		// Assignments: re-inserted at the same working-day offset from the period start.
		const targetCal: WorkCalendar = {
			workdays: new Set(target.workdays),
			holidays: new Set(target.holidays)
		};
		const targetStart = nextWorkingDay(target.startDate, targetCal);
		const moved = source.assignments
			.filter((a) => closure.has(a.taskId))
			.sort((a, b) =>
				(sourceSchedule.placements[a.id]?.days[0] ?? '9999').localeCompare(
					sourceSchedule.placements[b.id]?.days[0] ?? '9999'
				)
			);
		for (const assignment of moved) {
			const firstDay = sourceSchedule.placements[assignment.id]?.days[0];
			const offset = firstDay
				? countWorkingDays(source.startDate, addDays(firstDay, -1), sourceCal)
				: 0;
			const targetDate = addWorkingDays(targetStart, offset, targetCal);
			const maxOrder = target.assignments
				.filter((x) => x.memberId === assignment.memberId)
				.reduce((max, x) => Math.max(max, x.order), -1);
			target.assignments.push({ ...assignment, order: maxOrder + 1 });
			target.assignments = moveShare(
				{ plan: target, schedule: computeSchedule(target) },
				assignment.id,
				assignment.memberId,
				targetDate
			);
		}

		target.assignments = mergeAdjacentChunks(target.assignments);
		this.#registry[target.id] = target;
		this.#commit('moveTasksToPeriod', (plan) => {
			plan.tasks = plan.tasks.filter((t) => !closure.has(t.id));
			plan.assignments = plan.assignments.filter((a) => !closure.has(a.taskId));
			for (const t of plan.tasks) {
				if (t.dependsOn?.some((d) => closure.has(d))) {
					const kept = t.dependsOn.filter((d) => !closure.has(d));
					t.dependsOn = kept.length ? kept : undefined;
				}
			}
		});
		this.switchToPeriod(startDate, numWeeks, label);
		return movedTasks.length;
	}

	// ---- groups & members ---------------------------------------------------

	addGroup(name: string): string {
		const id = newId();
		this.#commit('addGroup', (plan) => plan.groups.push({ id, name }));
		return id;
	}

	updateGroup(id: string, patch: { name?: string; emoji?: string }) {
		this.#commit('updateGroup', (plan) => {
			const g = plan.groups.find((g) => g.id === id);
			if (!g) return;
			if (patch.name !== undefined) g.name = patch.name;
			if ('emoji' in patch) g.emoji = patch.emoji?.trim() || undefined;
		});
	}

	removeGroup(id: string) {
		this.#commit('removeGroup', (plan) => {
			plan.groups = plan.groups.filter((g) => g.id !== id);
			for (const m of plan.members) if (m.groupId === id) m.groupId = undefined;
			for (const t of plan.tasks) if (t.groupId === id) t.groupId = undefined;
		});
	}

	addMember(name: string, groupId?: string): string {
		const id = newId();
		this.#commit('addMember', (plan) => plan.members.push({ id, name, groupId }));
		return id;
	}

	updateMember(id: string, patch: { name?: string; groupId?: string; googleEmail?: string }) {
		this.#commit('updateMember', (plan) => {
			const m = plan.members.find((m) => m.id === id);
			if (!m) return;
			if (patch.name !== undefined) m.name = patch.name;
			if ('groupId' in patch) m.groupId = patch.groupId || undefined;
			if ('googleEmail' in patch) m.googleEmail = patch.googleEmail?.trim() || undefined;
		});
	}

	removeMember(id: string) {
		this.#commit('removeMember', (plan) => {
			plan.members = plan.members.filter((m) => m.id !== id);
			plan.assignments = plan.assignments.filter((a) => a.memberId !== id);
			plan.absences = plan.absences.filter((a) => a.memberId !== id);
		});
	}

	// ---- tasks ----------------------------------------------------------------

	/** A caller-provided id links the task to its namesake in other periods ("continuation"). */
	addTask(task: Omit<Task, 'id'>, id: string = newId()): string {
		this.#commit('addTask', (plan) => plan.tasks.push({ ...task, id }));
		return id;
	}

	/** Bulk estimate update (e.g. story-points sync from Jira). */
	setTaskEstimates(updates: Array<{ taskId: string; estimateDays: number }>) {
		if (!updates.length) return;
		this.#commit('setTaskEstimates', (plan) => {
			for (const update of updates) {
				const task = plan.tasks.find((t) => t.id === update.taskId);
				if (task) task.estimateDays = update.estimateDays;
			}
		});
	}

	/** Bulk import (e.g. from Jira). Returns how many were added. */
	addTasks(tasks: Array<Omit<Task, 'id'> & { id?: string }>): number {
		if (!tasks.length) return 0;
		this.#commit('addTasks', (plan) => {
			// Jira import pre-generates ids so children can point at their parent.
			for (const task of tasks) plan.tasks.push({ ...task, id: task.id ?? newId() });
		});
		return tasks.length;
	}

	updateTask(id: string, patch: Partial<Omit<Task, 'id'>>) {
		this.#commit('updateTask', (plan) => {
			const t = plan.tasks.find((t) => t.id === id);
			if (t) Object.assign(t, patch);
		});
	}

	/**
	 * Re-parents the selection's top-most tasks under a new parent (or to top
	 * level, with undefined). Selected descendants of other selected tasks move
	 * with their subtree instead of being re-parented individually; a parent
	 * inside the moved subtrees (a cycle) is refused. Dependencies of moved
	 * tasks on the new ancestor chain are dropped — a task cannot run after a
	 * parent whose rollup includes it.
	 */
	setTasksParent(taskIds: string[], parentId: string | undefined) {
		this.#commit('setTasksParent', (plan) => {
			const byId = new Map(plan.tasks.map((t) => [t.id, t]));
			if (parentId && !byId.has(parentId)) return;
			const selected = new Set(taskIds);
			const roots = taskIds.filter((id) => {
				for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId) {
					if (selected.has(p)) return false;
				}
				return true;
			});
			const moved = new Set<string>();
			const collect = (id: string) => {
				if (moved.has(id)) return;
				moved.add(id);
				for (const t of plan.tasks) if (t.parentId === id) collect(t.id);
			};
			for (const id of roots) collect(id);
			if (parentId && moved.has(parentId)) return;
			const ancestors = new Set<string>();
			for (let p: string | undefined = parentId; p; p = byId.get(p)?.parentId) {
				if (ancestors.has(p)) break;
				ancestors.add(p);
			}
			for (const id of roots) {
				const task = byId.get(id);
				if (task) task.parentId = parentId;
			}
			for (const id of moved) {
				const task = byId.get(id);
				if (!task?.dependsOn) continue;
				const kept = task.dependsOn.filter((d) => !ancestors.has(d));
				task.dependsOn = kept.length ? kept : undefined;
			}
		});
	}

	/** Jira sync: batch-refresh linked tasks in a single (undoable) commit. */
	applySyncUpdates(updates: Array<{ taskId: string; fields: Partial<Omit<Task, 'id'>> }>) {
		if (!updates.length) return;
		this.#commit('jiraSync', (plan) => {
			for (const update of updates) {
				const task = plan.tasks.find((t) => t.id === update.taskId);
				if (task) Object.assign(task, update.fields);
			}
		});
	}

	/** Freezes an explicit Gantt order for a sibling group (after an up/down nudge). */
	setGanttOrder(orderedIds: string[]) {
		this.#commit('setGanttOrder', (plan) => {
			orderedIds.forEach((id, index) => {
				const task = plan.tasks.find((t) => t.id === id);
				if (task) task.ganttRank = index;
			});
		});
	}

	removeTask(id: string) {
		this.removeTasks([id]);
	}

	/** Deletes tasks (the whole selection in one undoable commit), cascading to subtrees. */
	removeTasks(ids: string[]) {
		this.#commit('removeTasks', (plan) => {
			const doomed = new Set<string>(ids);
			let grew = true;
			while (grew) {
				grew = false;
				for (const t of plan.tasks) {
					if (t.parentId && doomed.has(t.parentId) && !doomed.has(t.id)) {
						doomed.add(t.id);
						grew = true;
					}
				}
			}
			plan.tasks = plan.tasks.filter((t) => !doomed.has(t.id));
			plan.assignments = plan.assignments.filter((a) => !doomed.has(a.taskId));
			for (const t of plan.tasks) {
				if (t.dependsOn?.some((d) => doomed.has(d))) {
					const kept = t.dependsOn.filter((d) => !doomed.has(d));
					t.dependsOn = kept.length ? kept : undefined;
				}
			}
		});
	}

	// ---- assignments ----------------------------------------------------------

	#nextOrder(memberId: string): number {
		const orders = this.plan.assignments.filter((a) => a.memberId === memberId).map((a) => a.order);
		return orders.length ? Math.max(...orders) + 1 : 0;
	}

	/** Schedule a task: one assignment per share, appended to each member's queue. */
	assignTask(taskId: string, shares: Array<{ memberId: string; days: number }>) {
		const orders = new Map(shares.map((s) => [s.memberId, this.#nextOrder(s.memberId)]));
		this.#commit('assignTask', (plan) => {
			for (const share of shares) {
				if (share.days <= 0) continue;
				plan.assignments.push({
					id: newId(),
					taskId,
					memberId: share.memberId,
					days: Math.round(share.days),
					order: orders.get(share.memberId)!
				});
			}
		});
	}

	setAssignmentDays(id: string, days: number) {
		this.#commit('setAssignmentDays', (plan) => {
			const a = plan.assignments.find((a) => a.id === id);
			if (a) a.days = Math.max(1, Math.round(days));
		});
	}

	removeAssignment(id: string) {
		this.#commit('removeAssignment', (plan) => {
			plan.assignments = plan.assignments.filter((a) => a.id !== id);
		});
	}

	#moveContext(): MoveContext {
		return { plan: this.plan, schedule: this.schedule };
	}

	/** Move a single share, possibly to another member's lane. */
	moveShareTo(id: string, targetMemberId: string, targetDate: ISODate) {
		const assignments = moveShare(this.#moveContext(), id, targetMemberId, targetDate);
		this.#commit('moveShareTo', (plan) => {
			plan.assignments = assignments;
		});
	}

	/** Move the whole block: every member's share of the task shifts to the target date together. */
	moveTaskTo(taskId: string, targetDate: ISODate) {
		const assignments = moveWholeTask(this.#moveContext(), taskId, targetDate);
		this.#commit('moveTaskTo', (plan) => {
			plan.assignments = assignments;
		});
	}

	/** Paint a chunk of a task onto a member's days (extends adjacent blocks of the same task). */
	paintTaskChunk(taskId: string, memberId: string, startDate: ISODate, endDate: ISODate) {
		const assignments = paintChunk(this.#moveContext(), taskId, memberId, startDate, endDate);
		this.#commit('paintTaskChunk', (plan) => {
			plan.assignments = assignments;
		});
	}

	/** Carve the chunk from `grabDate` to the end off a block and move it independently. */
	carveShareAt(id: string, grabDate: ISODate, targetMemberId: string, targetDate: ISODate) {
		const assignments = carveChunk(this.#moveContext(), id, grabDate, targetMemberId, targetDate);
		this.#commit('carveShareAt', (plan) => {
			plan.assignments = assignments;
		});
	}

	/** Drop a share into the middle of the block under the target date, splitting it. */
	splitShareAt(id: string, targetMemberId: string, targetDate: ISODate) {
		const assignments = splitDrop(this.#moveContext(), id, targetMemberId, targetDate);
		this.#commit('splitShareAt', (plan) => {
			plan.assignments = assignments;
		});
	}

	// ---- absences ---------------------------------------------------------------

	addAbsence(memberId: string, startDate: ISODate, endDate: ISODate, note = 'PTO') {
		if (endDate < startDate) [startDate, endDate] = [endDate, startDate];
		this.#commit('addAbsence', (plan) => {
			plan.absences.push({ id: newId(), memberId, startDate, endDate, note });
		});
	}

	removeAbsence(id: string) {
		this.#commit('removeAbsence', (plan) => {
			plan.absences = plan.absences.filter((a) => a.id !== id);
		});
	}

	/**
	 * Move an absence so the grabbed day lands on the drop cell, possibly onto
	 * another member. The working-day length is preserved and the range rolls
	 * over weekends and holidays — moving a Wed–Fri PTO to start on Thursday
	 * yields Thu, Fri and the following Monday.
	 */
	moveAbsence(id: string, targetMemberId: string, targetDate: ISODate, grabDate: ISODate) {
		const absences = shiftAbsence(this.plan, id, targetMemberId, targetDate, grabDate);
		this.#commit('moveAbsence', (plan) => {
			plan.absences = absences;
		});
	}

	resizeAbsence(id: string, newEndDate: ISODate) {
		this.#commit('resizeAbsence', (plan) => {
			const a = plan.absences.find((a) => a.id === id);
			if (a) a.endDate = newEndDate < a.startDate ? a.startDate : newEndDate;
		});
	}

	updateAbsenceNote(id: string, note: string) {
		this.#commit('updateAbsenceNote', (plan) => {
			const a = plan.absences.find((a) => a.id === id);
			if (a) a.note = note.trim() || 'PTO';
		});
	}

	/**
	 * Upserts calendar-sourced absences for the given members: matching
	 * externalIds are updated in place, new ones added, and google-sourced
	 * absences of those members that no longer exist upstream are removed
	 * (manual PTO is never touched). Returns counts for the status message.
	 */
	syncExternalAbsences(
		memberIds: string[],
		incoming: Array<Omit<Absence, 'id'> & { externalId: string }>
	): { added: number; updated: number; removed: number } {
		const members = new Set(memberIds);
		const incomingIds = new Set(incoming.map((a) => a.externalId));
		let added = 0;
		let updated = 0;
		let removed = 0;
		this.#commit('syncExternalAbsences', (plan) => {
			plan.absences = plan.absences.filter((a) => {
				const stale =
					a.source === 'google' &&
					a.externalId &&
					members.has(a.memberId) &&
					!incomingIds.has(a.externalId);
				if (stale) removed++;
				return !stale;
			});
			for (const candidate of incoming) {
				const existing = plan.absences.find(
					(a) => a.source === 'google' && a.externalId === candidate.externalId
				);
				if (existing) {
					if (
						existing.startDate !== candidate.startDate ||
						existing.endDate !== candidate.endDate ||
						existing.note !== candidate.note ||
						existing.memberId !== candidate.memberId
					) {
						Object.assign(existing, candidate);
						updated++;
					}
				} else {
					plan.absences.push({ ...candidate, id: newId() });
					added++;
				}
			}
		});
		return { added, updated, removed };
	}

	absenceAt(memberId: string, date: ISODate): Absence | undefined {
		const id = this.absenceDayMap[memberId]?.[date];
		return id ? this.plan.absences.find((a) => a.id === id) : undefined;
	}

	/** Full hierarchy path, e.g. "EOL Policies / FE". */
	taskPath(taskId: string): string {
		const parts: string[] = [];
		let task = this.tasksById.get(taskId);
		for (let i = 0; task && i < 10; i++) {
			parts.unshift(task.name);
			task = task.parentId ? this.tasksById.get(task.parentId) : undefined;
		}
		return parts.join(' / ');
	}

	assignmentById(id: string): Assignment | undefined {
		return this.plan.assignments.find((a) => a.id === id);
	}
}

export const store = new PlanStore();
