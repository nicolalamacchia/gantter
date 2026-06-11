import { describe, expect, it } from 'vitest';
import type { Plan } from '$lib/model/types';
import { PlanStore } from './plan.svelte';

/** 2026-01-05 is a Monday. */
function fixture(): Plan {
	return {
		id: 'p',
		name: 'Test',
		schemaVersion: 1,
		startDate: '2026-01-05',
		numWeeks: 8,
		workdays: [1, 2, 3, 4, 5],
		holidays: [],
		groups: [],
		members: [
			{ id: 'm1', name: 'Nicola' },
			{ id: 'm2', name: 'Ale' }
		],
		tasks: [
			{ id: 'T', name: 'Shared task', color: '#abc' },
			{ id: 'U', name: 'Solo task', color: '#def' }
		],
		assignments: [
			{ id: 'aT1', taskId: 'T', memberId: 'm1', days: 3, order: 0 },
			{ id: 'aU', taskId: 'U', memberId: 'm1', days: 2, order: 1 },
			{ id: 'aT2', taskId: 'T', memberId: 'm2', days: 3, order: 0 }
		],
		absences: [{ id: 'pto', memberId: 'm1', startDate: '2026-01-26', endDate: '2026-01-27' }]
	};
}

function makeStore(): PlanStore {
	const store = new PlanStore();
	store.importPlan(fixture());
	return store;
}

describe('PlanStore commands', () => {
	it('moveTaskTo moves every share of the task together, leaving no gaps', () => {
		const store = makeStore();
		store.moveTaskTo('T', '2026-01-09'); // drop on the second half of U's block
		expect(store.schedule.placements['aU'].days).toEqual(['2026-01-05', '2026-01-06']);
		expect(store.schedule.placements['aT1'].days).toEqual([
			'2026-01-07',
			'2026-01-08',
			'2026-01-09'
		]);
		// m2 has nothing else queued, so their share still packs from the start.
		expect(store.schedule.placements['aT2'].days).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-07'
		]);
	});

	it('moveShareTo reassigns a single share to another member', () => {
		const store = makeStore();
		store.moveShareTo('aU', 'm2', '2026-01-05'); // drop on first half of aT2 → goes first
		expect(store.schedule.placements['aU'].days).toEqual(['2026-01-05', '2026-01-06']);
		expect(store.schedule.placements['aT2'].days).toEqual([
			'2026-01-07',
			'2026-01-08',
			'2026-01-09'
		]);
		// m1 keeps only its T share, repacked to the front — no gap.
		expect(store.schedule.placements['aT1'].days).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-07'
		]);
	});

	it('splitShareAt drops a share into the middle of a block, splitting it', () => {
		const store = makeStore();
		// Drop U into the middle of m1's aT1 (3d, Jan 5-7) at Jan 6.
		store.splitShareAt('aU', 'm1', '2026-01-06');
		expect(store.schedule.placements['aT1'].days).toEqual(['2026-01-05']);
		expect(store.schedule.placements['aU'].days).toEqual(['2026-01-06', '2026-01-07']);
		const tail = store.plan.assignments.find(
			(a) => a.taskId === 'T' && a.memberId === 'm1' && a.id !== 'aT1' && a.id !== 'aT2'
		);
		expect(tail?.days).toBe(2);
		expect(store.schedule.placements[tail!.id].days).toEqual(['2026-01-08', '2026-01-09']);
	});

	it('splitShareAt on an edge or empty cell falls back to a plain move', () => {
		const store = makeStore();
		const count = store.plan.assignments.length;
		store.splitShareAt('aU', 'm2', '2026-01-05'); // first day of aT2 → no split
		expect(store.plan.assignments.length).toBe(count);
		expect(store.schedule.placements['aU'].days[0]).toBe('2026-01-05');
	});

	it('keeps each period’s data separate when switching', () => {
		const store = makeStore(); // fixture period: 2026-01-05, 8 weeks
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		expect(store.plan.tasks).toHaveLength(0);
		expect(store.plan.absences).toHaveLength(0);
		expect(store.plan.members.map((m) => m.id)).toEqual(['m1', 'm2']); // team carried over
		store.addTask({ name: 'Q2 thing', color: '#abc' });
		store.switchToPeriod('2026-01-05', 8, 'back');
		expect(store.plan.tasks.map((t) => t.id)).toEqual(['T', 'U']);
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		expect(store.plan.tasks.map((t) => t.name)).toEqual(['Q2 thing']);
	});

	it('importing a plan replaces the existing plan for that period', () => {
		const store = makeStore();
		store.importPlan({ ...fixture(), id: 'replacement', name: 'Replacement' });
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		store.switchToPeriod('2026-01-05', 8, 'back');
		expect(store.plan.id).toBe('replacement');
	});

	it('carveShareAt splits off the tail from the grab day and moves it independently', () => {
		const store = makeStore();
		// aT1 (3d, Jan 5–7): carve from Jan 6, drop on the second half of aU (Jan 8–9).
		store.carveShareAt('aT1', '2026-01-06', 'm1', '2026-01-09');
		expect(store.schedule.placements['aT1'].days).toEqual(['2026-01-05']);
		const chunk = store.plan.assignments.find(
			(a) => a.taskId === 'T' && a.memberId === 'm1' && a.id !== 'aT1' && a.id !== 'aT2'
		);
		expect(chunk?.days).toBe(2);
		expect(store.schedule.placements['aU'].days).toEqual(['2026-01-06', '2026-01-07']);
		expect(store.schedule.placements[chunk!.id].days).toEqual(['2026-01-08', '2026-01-09']);
	});

	it('moveTasksToPeriod transfers tasks, preserving their relative sequence', () => {
		const store = makeStore(); // fixture: 2026-01-05 (Mon); m1 queue = aT1 (3d) then aU (2d)
		store.moveTasksToPeriod(['T', 'U'], '2026-07-01', 14, 'Q3 2026');
		// We followed the tasks: the active plan is now Q3.
		expect(store.plan.startDate).toBe('2026-07-01');
		expect(store.plan.tasks.map((t) => t.id).sort()).toEqual(['T', 'U']);
		// Insertion happens at the equivalent date, so the source interleaving
		// survives; queues still pack from the start (the no-gaps invariant).
		expect(store.schedule.placements['aT1'].days[0]).toBe('2026-07-01');
		expect(store.schedule.placements['aU'].days[0]).toBe('2026-07-06'); // after aT1's 3 days
		expect(store.schedule.placements['aT2'].days[0]).toBe('2026-07-01'); // m2's share
		// The team came along.
		expect(store.plan.members.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
		// The source plan is now empty of those tasks.
		store.switchToPeriod('2026-01-05', 8, 'back');
		expect(store.plan.tasks).toHaveLength(0);
		expect(store.plan.assignments).toHaveLength(0);
	});

	it('paintTaskChunk extends an adjacent block of the same task', () => {
		const store = makeStore();
		// aT1 = T on m1, 3d (Jan 5–7). Painting Thu–Fri right after it extends it.
		store.paintTaskChunk('T', 'm1', '2026-01-08', '2026-01-09');
		expect(store.assignmentById('aT1')?.days).toBe(5);
		expect(
			store.plan.assignments.filter((a) => a.taskId === 'T' && a.memberId === 'm1')
		).toHaveLength(1);
		expect(store.schedule.placements['aU'].days[0]).toBe('2026-01-12'); // pushed back
	});

	it('paintTaskChunk creates a separate chunk when painted away from the block', () => {
		const store = makeStore();
		// aT1 ends Jan 7 (adjacency reaches Jan 8); painting Jan 13–14 is separate.
		store.paintTaskChunk('T', 'm1', '2026-01-13', '2026-01-14');
		const chunks = store.plan.assignments.filter((a) => a.taskId === 'T' && a.memberId === 'm1');
		expect(chunks).toHaveLength(2);
		expect(chunks.find((a) => a.id !== 'aT1')?.days).toBe(2);
	});

	it('paintTaskChunk counts only available working days', () => {
		const store = makeStore();
		// Fri Jan 9 through Mon Jan 12 spans a weekend → 2 working days on m2.
		store.paintTaskChunk('U', 'm2', '2026-01-09', '2026-01-12');
		const added = store.plan.assignments.find((a) => a.taskId === 'U' && a.memberId === 'm2');
		expect(added?.days).toBe(2);
	});

	it('adjacent same-task chunks always merge back after any command', () => {
		const store = makeStore();
		// Split T around aU: m1 queue becomes T(1d), U(2d), T-tail(2d).
		store.splitShareAt('aU', 'm1', '2026-01-06');
		expect(
			store.plan.assignments.filter((a) => a.taskId === 'T' && a.memberId === 'm1')
		).toHaveLength(2);
		// Move U away: the two T halves become adjacent → merged automatically.
		store.moveShareTo('aU', 'm1', '2026-01-30');
		const tChunks = store.plan.assignments.filter((a) => a.taskId === 'T' && a.memberId === 'm1');
		expect(tChunks).toHaveLength(1);
		expect(tChunks[0].days).toBe(3);
		expect(store.schedule.placements[tChunks[0].id].days).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-07'
		]);
	});

	it('setWorkdays reshapes the calendar (e.g. a 3-day week)', () => {
		const store = makeStore();
		store.setWorkdays([1, 2, 3]); // Mon–Wed only
		expect(store.schedule.placements['aT1'].days).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-07'
		]);
		// aU's 2 days roll into the next week's Mon/Tue.
		expect(store.schedule.placements['aU'].days).toEqual(['2026-01-12', '2026-01-13']);
		store.setWorkdays([]); // ignored: at least one workday must remain
		expect(store.plan.workdays).toEqual([1, 2, 3]);
	});

	it('addHolidays merges and dedupes', () => {
		const store = makeStore();
		expect(store.addHolidays(['2026-01-06', '2026-01-06', '2026-02-02'])).toBe(2);
		expect(store.addHolidays(['2026-01-06'])).toBe(0);
		expect(store.schedule.placements['aT1'].days).toContain('2026-01-08'); // holiday skipped
	});

	it('continueTasksInPeriod creates same-id shells elsewhere without moving anything', () => {
		const store = makeStore();
		expect(store.continueTasksInPeriod(['T'], '2026-07-01', 14, 'Q3 2026')).toBe(1);
		// Source untouched: task and assignments still here.
		expect(store.plan.tasks.some((t) => t.id === 'T')).toBe(true);
		expect(store.plan.assignments.some((a) => a.taskId === 'T')).toBe(true);
		// Idempotent.
		expect(store.continueTasksInPeriod(['T'], '2026-07-01', 14, 'Q3 2026')).toBe(0);
		// The continuation shell exists in Q3 with the same identity and no work.
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		expect(store.plan.tasks.find((t) => t.id === 'T')?.name).toBe('Shared task');
		expect(store.plan.assignments).toHaveLength(0);
	});

	it('addTask accepts an explicit id for continuations', () => {
		const store = makeStore();
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		expect(store.registryTaskChoices().some((c) => c.task.id === 'T')).toBe(true);
		store.addTask({ name: 'Shared task (cont.)', color: '#abc' }, 'T');
		expect(store.plan.tasks.find((t) => t.id === 'T')?.name).toBe('Shared task (cont.)');
		expect(store.registryTaskChoices().some((c) => c.task.id === 'T')).toBe(false);
	});

	it('applyServerTeam upserts groups/members and board defaults, deleting nothing', () => {
		const store = makeStore();
		store.applyServerTeam(
			{
				groups: [{ id: 'g1', name: 'Core' }],
				members: [
					{ id: 'm1', name: 'Nicola (managed)', groupId: 'g1' },
					{ id: 'm9', name: 'New colleague', groupId: 'g1' }
				]
			},
			{ workdays: [1, 2, 3, 4], showWeekends: true }
		);
		expect(store.plan.members.find((m) => m.id === 'm1')?.name).toBe('Nicola (managed)');
		expect(store.plan.members.some((m) => m.id === 'm2')).toBe(true); // untouched
		expect(store.plan.members.some((m) => m.id === 'm9')).toBe(true); // added
		expect(store.plan.workdays).toEqual([1, 2, 3, 4]);
		expect(store.plan.showWeekends).toBe(true);
		expect(store.plan.assignments.length).toBeGreaterThan(0); // never deleted
		// Re-applying identical config is a no-op (no extra commit).
		const version = store.registryVersion;
		store.applyServerTeam(
			{ members: [{ id: 'm9', name: 'New colleague', groupId: 'g1' }] },
			undefined
		);
		expect(store.registryVersion).toBe(version);
	});

	it('taskPath renders the full hierarchy', () => {
		const store = makeStore();
		const parentId = store.addTask({ name: 'EOL Policies', color: '#abc' });
		const childId = store.addTask({ name: 'FE', color: '#abc', parentId });
		expect(store.taskPath(childId)).toBe('EOL Policies / FE');
		expect(store.taskPath(parentId)).toBe('EOL Policies');
	});

	it('rolloverTaskSpill moves only the overflowing days, only for affected people', () => {
		const store = makeStore();
		store.updatePlanMeta({ numWeeks: 2 }); // period ends Sun Jan 18 → 10 working days
		store.setAssignmentDays('aU', 12); // m1: 3d (T) + 12d (U) → U's last 5 days spill
		const moved = store.rolloverTaskSpill('U', '2026-07-01', 14, 'Q3 2026');
		expect(moved).toBe(5);
		// The fitting part stays; nothing else moved.
		expect(store.assignmentById('aU')?.days).toBe(7);
		expect(store.plan.tasks.some((t) => t.id === 'U')).toBe(true);
		expect(store.assignmentById('aT2')?.days).toBe(3); // m2 untouched
		// The spill continues in Q3 as the same task, same member, queued first.
		store.switchToPeriod('2026-07-01', 14, 'Q3 2026');
		const continuation = store.plan.assignments.find(
			(a) => a.taskId === 'U' && a.memberId === 'm1'
		);
		expect(continuation?.days).toBe(5);
		expect(store.schedule.placements[continuation!.id].days[0]).toBe('2026-07-01');
		expect(store.plan.tasks.find((t) => t.id === 'U')?.name).toBe('Solo task');
	});

	it('undo restores the pre-move schedule', () => {
		const store = makeStore();
		const before = store.schedule.placements['aT1'].days;
		store.moveTaskTo('T', '2026-01-09');
		store.undo();
		expect(store.schedule.placements['aT1'].days).toEqual(before);
	});

	it('moveAbsence shifts the range, keeping its working-day length, and can change member', () => {
		const store = makeStore();
		store.moveAbsence('pto', 'm2', '2026-01-13', '2026-01-26');
		const moved = store.plan.absences.find((a) => a.id === 'pto')!;
		expect(moved.memberId).toBe('m2');
		expect(moved.startDate).toBe('2026-01-13');
		expect(moved.endDate).toBe('2026-01-14');
		// m2's task now flows around the moved PTO.
		expect(store.schedule.dayMap['m2']['2026-01-13']).toBeUndefined();
	});

	it('a moved PTO rolls over the weekend instead of losing days', () => {
		const store = makeStore();
		// Wed–Fri PTO (3 working days)…
		store.addAbsence('m2', '2026-01-07', '2026-01-09');
		const id = store.plan.absences.find((a) => a.memberId === 'm2')!.id;
		// …grabbed by its first day and dropped on Thursday.
		store.moveAbsence(id, 'm2', '2026-01-08', '2026-01-07');
		const moved = store.plan.absences.find((a) => a.id === id)!;
		expect(moved.startDate).toBe('2026-01-08');
		expect(moved.endDate).toBe('2026-01-12'); // Thu, Fri, then Monday after the weekend
	});

	it('grabbing the middle of a PTO keeps the grabbed day under the cursor', () => {
		const store = makeStore();
		// Thu–Mon PTO (working days: Thu 8, Fri 9, Mon 12).
		store.addAbsence('m2', '2026-01-08', '2026-01-12');
		const id = store.plan.absences.find((a) => a.memberId === 'm2')!.id;
		// Grab the Monday cell, drop it on Friday → block shifts one working day back.
		store.moveAbsence(id, 'm2', '2026-01-09', '2026-01-12');
		const moved = store.plan.absences.find((a) => a.id === id)!;
		expect(moved.startDate).toBe('2026-01-07');
		expect(moved.endDate).toBe('2026-01-09'); // Wed–Fri, fully before the weekend
	});

	it('resizeAbsence clamps to the start date', () => {
		const store = makeStore();
		store.resizeAbsence('pto', '2026-01-30');
		expect(store.plan.absences[0].endDate).toBe('2026-01-30');
		store.resizeAbsence('pto', '2026-01-01');
		expect(store.plan.absences[0].endDate).toBe('2026-01-26');
	});

	it('syncExternalAbsences upserts by externalId and prunes stale google absences', () => {
		const store = makeStore();
		const first = store.syncExternalAbsences(
			['m1'],
			[
				{
					memberId: 'm1',
					startDate: '2026-02-02',
					endDate: '2026-02-03',
					note: 'OOO',
					source: 'google',
					externalId: 'evt-1'
				}
			]
		);
		expect(first).toEqual({ added: 1, updated: 0, removed: 0 });
		// Re-sync: evt-1 moved, evt-2 new; manual PTO ('pto') must survive.
		const second = store.syncExternalAbsences(
			['m1'],
			[
				{
					memberId: 'm1',
					startDate: '2026-02-09',
					endDate: '2026-02-10',
					note: 'OOO',
					source: 'google',
					externalId: 'evt-1'
				},
				{
					memberId: 'm1',
					startDate: '2026-02-16',
					endDate: '2026-02-16',
					note: 'Conf',
					source: 'google',
					externalId: 'evt-2'
				}
			]
		);
		expect(second).toEqual({ added: 1, updated: 1, removed: 0 });
		// Third sync: upstream cancelled evt-2.
		const third = store.syncExternalAbsences(
			['m1'],
			[
				{
					memberId: 'm1',
					startDate: '2026-02-09',
					endDate: '2026-02-10',
					note: 'OOO',
					source: 'google',
					externalId: 'evt-1'
				}
			]
		);
		expect(third).toEqual({ added: 0, updated: 0, removed: 1 });
		expect(store.plan.absences.find((a) => a.id === 'pto')).toBeDefined();
		expect(store.plan.absences.filter((a) => a.source === 'google')).toHaveLength(1);
	});

	it('removing a task strips it from other tasks’ dependencies', () => {
		const store = makeStore();
		store.updateTask('U', { dependsOn: ['T'] });
		store.removeTask('T');
		expect(store.plan.tasks.find((t) => t.id === 'U')?.dependsOn).toBeUndefined();
	});

	it('removeTasks deletes a whole selection with subtrees, assignments and dep references', () => {
		const store = makeStore();
		const plan = fixture();
		plan.tasks = [
			{ id: 'A', name: 'A', color: '#aaa' },
			{ id: 'B', name: 'B (child of A)', color: '#bbb', parentId: 'A' },
			{ id: 'C', name: 'C', color: '#ccc' },
			{ id: 'D', name: 'D', color: '#ddd', dependsOn: ['A', 'C'] }
		];
		plan.assignments = [
			{ id: 'aB', taskId: 'B', memberId: 'm1', days: 2, order: 0 },
			{ id: 'aC', taskId: 'C', memberId: 'm2', days: 2, order: 0 }
		];
		store.importPlan(plan);

		store.removeTasks(['A', 'C']);
		expect(store.plan.tasks.map((t) => t.id)).toEqual(['D']);
		expect(store.plan.assignments).toEqual([]);
		// D depended on both deleted tasks — references stripped.
		expect(store.plan.tasks[0].dependsOn).toBeUndefined();

		// One undo restores the whole batch.
		store.undo();
		expect(store.plan.tasks.map((t) => t.id)).toEqual(['A', 'B', 'C', 'D']);
	});

	it('setTasksParent re-parents selection roots, keeps subtrees whole and refuses cycles', () => {
		const store = makeStore();
		const plan = fixture();
		plan.tasks = [
			{ id: 'P', name: 'Parent', color: '#aaa' },
			{ id: 'A', name: 'A', color: '#bbb' },
			{ id: 'B', name: 'B (child of A)', color: '#ccc', parentId: 'A' },
			{ id: 'C', name: 'C', color: '#ddd', dependsOn: ['P'] }
		];
		plan.assignments = [];
		store.importPlan(plan);

		// A (selected together with its child B) and C move under P; B stays under A.
		store.setTasksParent(['A', 'B', 'C'], 'P');
		const byId = new Map(store.plan.tasks.map((t) => [t.id, t]));
		expect(byId.get('A')?.parentId).toBe('P');
		expect(byId.get('C')?.parentId).toBe('P');
		expect(byId.get('B')?.parentId).toBe('A');
		// C depended on its new parent — dropped, a rollup cannot wait for itself.
		expect(byId.get('C')?.dependsOn).toBeUndefined();

		// A parent inside a moved subtree would be a cycle — refused, nothing changes.
		store.setTasksParent(['A'], 'B');
		expect(store.plan.tasks.find((t) => t.id === 'A')?.parentId).toBe('P');

		// undefined re-parents to top level.
		store.setTasksParent(['A', 'C'], undefined);
		expect(store.plan.tasks.find((t) => t.id === 'A')?.parentId).toBeUndefined();
		expect(store.plan.tasks.find((t) => t.id === 'C')?.parentId).toBeUndefined();
		expect(store.plan.tasks.find((t) => t.id === 'B')?.parentId).toBe('A');
	});
});
