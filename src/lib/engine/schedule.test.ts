import { describe, expect, it } from 'vitest';
import type { Plan } from '$lib/model/types';
import { computeSchedule, toRuns } from './schedule';

/** 2026-01-05 is a Monday. */
function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		id: 'plan',
		name: 'Test',
		schemaVersion: 1,
		startDate: '2026-01-05',
		numWeeks: 12,
		workdays: [1, 2, 3, 4, 5],
		holidays: [],
		groups: [],
		members: [{ id: 'm1', name: 'Nicola' }],
		tasks: [{ id: 't1', name: 'Task 1', color: '#fadbd8' }],
		assignments: [],
		absences: [],
		...overrides
	};
}

describe('computeSchedule', () => {
	it('packs a member queue front-to-back, skipping weekends', () => {
		const plan = makePlan({
			assignments: [
				{ id: 'a1', taskId: 't1', memberId: 'm1', days: 3, order: 0 },
				{ id: 'a2', taskId: 't1', memberId: 'm1', days: 4, order: 1 }
			]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
		expect(s.placements['a2'].days).toEqual([
			'2026-01-08',
			'2026-01-09',
			'2026-01-12', // Sat 10 / Sun 11 skipped
			'2026-01-13'
		]);
		expect(s.dayMap['m1']['2026-01-12']).toBe('a2');
		expect(s.dayMap['m1']['2026-01-10']).toBeUndefined();
	});

	it('splits an assignment around PTO', () => {
		const plan = makePlan({
			assignments: [{ id: 'a1', taskId: 't1', memberId: 'm1', days: 5, order: 0 }],
			absences: [{ id: 'pto', memberId: 'm1', startDate: '2026-01-07', endDate: '2026-01-08' }]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-09',
			'2026-01-12',
			'2026-01-13'
		]);
		const runs = toRuns(s.placements['a1'].days);
		expect(runs).toHaveLength(3);
		expect(runs[0]).toEqual({ startDate: '2026-01-05', endDate: '2026-01-06', days: 2 });
		expect(s.dayMap['m1']['2026-01-07']).toBeUndefined();
	});

	it('PTO of one member does not affect another', () => {
		const plan = makePlan({
			members: [
				{ id: 'm1', name: 'Nicola' },
				{ id: 'm2', name: 'Ale' }
			],
			assignments: [
				{ id: 'a1', taskId: 't1', memberId: 'm1', days: 2, order: 0 },
				{ id: 'a2', taskId: 't1', memberId: 'm2', days: 2, order: 0 }
			],
			absences: [{ id: 'pto', memberId: 'm1', startDate: '2026-01-05', endDate: '2026-01-05' }]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual(['2026-01-06', '2026-01-07']);
		expect(s.placements['a2'].days).toEqual(['2026-01-05', '2026-01-06']);
	});

	it('skips company holidays for everyone', () => {
		const plan = makePlan({
			holidays: ['2026-01-06'],
			members: [
				{ id: 'm1', name: 'Nicola' },
				{ id: 'm2', name: 'Ale' }
			],
			assignments: [
				{ id: 'a1', taskId: 't1', memberId: 'm1', days: 2, order: 0 },
				{ id: 'a2', taskId: 't1', memberId: 'm2', days: 2, order: 0 }
			]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual(['2026-01-05', '2026-01-07']);
		expect(s.placements['a2'].days).toEqual(['2026-01-05', '2026-01-07']);
	});

	it('reordering the queue repacks deterministically', () => {
		const base = {
			assignments: [
				{ id: 'a1', taskId: 't1', memberId: 'm1', days: 2, order: 0 },
				{ id: 'a2', taskId: 't1', memberId: 'm1', days: 2, order: 1 }
			]
		};
		const before = computeSchedule(makePlan(base));
		expect(before.placements['a1'].days[0]).toBe('2026-01-05');
		const after = computeSchedule(
			makePlan({
				assignments: base.assignments.map((a) => ({ ...a, order: a.id === 'a2' ? -1 : a.order }))
			})
		);
		expect(after.placements['a2'].days).toEqual(['2026-01-05', '2026-01-06']);
		expect(after.placements['a1'].days).toEqual(['2026-01-07', '2026-01-08']);
	});

	it('rolls up a task split across members', () => {
		const plan = makePlan({
			members: [
				{ id: 'm1', name: 'Nicola' },
				{ id: 'm2', name: 'Ale' }
			],
			tasks: [
				{ id: 't0', name: 'Filler', color: '#eee' },
				{ id: 't1', name: 'Task 1', color: '#fadbd8' }
			],
			assignments: [
				{ id: 'a1', taskId: 't1', memberId: 'm1', days: 3, order: 0 },
				{ id: 'a0', taskId: 't0', memberId: 'm2', days: 5, order: 0 },
				{ id: 'a2', taskId: 't1', memberId: 'm2', days: 2, order: 1 }
			]
		});
		const r = computeSchedule(plan).rollups['t1'];
		expect(r.startDate).toBe('2026-01-05');
		expect(r.endDate).toBe('2026-01-13'); // m2 finishes filler Fri 9, works t1 Mon 12 + Tue 13
		expect(r.assignedDays).toBe(5);
		expect(r.memberIds.sort()).toEqual(['m1', 'm2']);
	});

	it('rolls up a parent task across child workstreams (sub-teams)', () => {
		const plan = makePlan({
			groups: [
				{ id: 'fe', name: 'Frontend' },
				{ id: 'be', name: 'Backend' }
			],
			members: [
				{ id: 'm1', name: 'Nicola', groupId: 'fe' },
				{ id: 'm2', name: 'Dani', groupId: 'be' }
			],
			tasks: [
				{ id: 'main', name: 'Supply Chain MVP', color: '#abc' },
				{ id: 'fe-ws', name: 'FE workstream', color: '#abc', parentId: 'main', groupId: 'fe' },
				{ id: 'be-ws', name: 'BE workstream', color: '#abc', parentId: 'main', groupId: 'be' }
			],
			assignments: [
				{ id: 'a1', taskId: 'fe-ws', memberId: 'm1', days: 2, order: 0 },
				{ id: 'a2', taskId: 'be-ws', memberId: 'm2', days: 4, order: 0 }
			]
		});
		const s = computeSchedule(plan);
		expect(s.rollups['fe-ws'].endDate).toBe('2026-01-06');
		expect(s.rollups['be-ws'].endDate).toBe('2026-01-08');
		expect(s.rollups['main'].startDate).toBe('2026-01-05');
		expect(s.rollups['main'].endDate).toBe('2026-01-08');
		expect(s.rollups['main'].assignedDays).toBe(6);
	});

	it('handles zero-day assignments and unassigned tasks', () => {
		const plan = makePlan({
			tasks: [
				{ id: 't1', name: 'Task 1', color: '#abc' },
				{ id: 't2', name: 'Unassigned', color: '#def' }
			],
			assignments: [{ id: 'a1', taskId: 't1', memberId: 'm1', days: 0, order: 0 }]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual([]);
		expect(s.rollups['t1'].startDate).toBeNull();
		expect(s.rollups['t2'].startDate).toBeNull();
		expect(s.rollups['t2'].assignedDays).toBe(0);
	});

	it('terminates and reports overflow when no capacity exists', () => {
		const plan = makePlan({
			assignments: [{ id: 'a1', taskId: 't1', memberId: 'm1', days: 5, order: 0 }],
			absences: [{ id: 'pto', memberId: 'm1', startDate: '2026-01-01', endDate: '2046-01-01' }]
		});
		const s = computeSchedule(plan);
		expect(s.placements['a1'].days).toEqual([]);
		expect(s.placements['a1'].overflowDays).toBe(5);
	});
});

describe('computeSchedule – dependencies', () => {
	const twoMembers = [
		{ id: 'm1', name: 'Nicola' },
		{ id: 'm2', name: 'Dani' }
	];

	it('a dependent task waits for its dependency across members', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'A', name: 'A', color: '#aaa' },
				{ id: 'B', name: 'B', color: '#bbb', dependsOn: ['A'] }
			],
			assignments: [
				{ id: 'aA', taskId: 'A', memberId: 'm1', days: 3, order: 0 },
				{ id: 'aB', taskId: 'B', memberId: 'm2', days: 2, order: 0 }
			]
		});
		const s = computeSchedule(plan);
		expect(s.placements['aA'].days).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
		// B may not start before A ends (Wed Jan 7) → starts Thu Jan 8.
		expect(s.placements['aB'].days).toEqual(['2026-01-08', '2026-01-09']);
	});

	it('a blocked assignment lets later queue items run first (no idle gaps)', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'A', name: 'A', color: '#aaa' },
				{ id: 'B', name: 'B', color: '#bbb', dependsOn: ['A'] },
				{ id: 'C', name: 'C', color: '#ccc' }
			],
			assignments: [
				{ id: 'aA', taskId: 'A', memberId: 'm1', days: 3, order: 0 },
				{ id: 'aB', taskId: 'B', memberId: 'm2', days: 2, order: 0 },
				{ id: 'aC', taskId: 'C', memberId: 'm2', days: 2, order: 1 }
			]
		});
		const s = computeSchedule(plan);
		// B is blocked until Jan 8, so C (behind it in the queue) runs immediately.
		expect(s.placements['aC'].days).toEqual(['2026-01-05', '2026-01-06']);
		expect(s.placements['aB'].days).toEqual(['2026-01-08', '2026-01-09']);
	});

	it('depending on a parent waits for all of its workstreams', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'P', name: 'Parent', color: '#aaa' },
				{ id: 'C1', name: 'WS1', color: '#aaa', parentId: 'P' },
				{ id: 'C2', name: 'WS2', color: '#aaa', parentId: 'P' },
				{ id: 'D', name: 'Dependent', color: '#ddd', dependsOn: ['P'] }
			],
			assignments: [
				{ id: 'a1', taskId: 'C1', memberId: 'm1', days: 3, order: 0 },
				{ id: 'a2', taskId: 'C2', memberId: 'm2', days: 1, order: 0 },
				{ id: 'aD', taskId: 'D', memberId: 'm2', days: 2, order: 1 }
			]
		});
		const s = computeSchedule(plan);
		// Subtree of P ends Wed Jan 7 (C1), so D starts Thu Jan 8 even though m2 was free.
		expect(s.placements['aD'].days).toEqual(['2026-01-08', '2026-01-09']);
	});

	it('workstreams inherit dependencies from their parent task', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'A', name: 'A', color: '#aaa' },
				{ id: 'P', name: 'Parent', color: '#bbb', dependsOn: ['A'] },
				{ id: 'C1', name: 'WS', color: '#bbb', parentId: 'P' }
			],
			assignments: [
				{ id: 'aA', taskId: 'A', memberId: 'm1', days: 2, order: 0 },
				{ id: 'aC', taskId: 'C1', memberId: 'm2', days: 2, order: 0 }
			]
		});
		const s = computeSchedule(plan);
		// C1 inherits P's dependency on A (ends Tue Jan 6) → starts Wed Jan 7.
		expect(s.placements['aC'].days).toEqual(['2026-01-07', '2026-01-08']);
	});

	it('dependency cycles are broken instead of hanging', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'A', name: 'A', color: '#aaa', dependsOn: ['B'] },
				{ id: 'B', name: 'B', color: '#bbb', dependsOn: ['A'] }
			],
			assignments: [
				{ id: 'aA', taskId: 'A', memberId: 'm1', days: 2, order: 0 },
				{ id: 'aB', taskId: 'B', memberId: 'm2', days: 2, order: 0 }
			]
		});
		const s = computeSchedule(plan);
		const total = s.placements['aA'].days.length + s.placements['aB'].days.length;
		expect(total).toBe(4);
	});

	it('chained dependencies resolve over multiple passes', () => {
		const plan = makePlan({
			members: twoMembers,
			tasks: [
				{ id: 'A', name: 'A', color: '#aaa' },
				{ id: 'B', name: 'B', color: '#bbb', dependsOn: ['A'] },
				{ id: 'C', name: 'C', color: '#ccc', dependsOn: ['B'] }
			],
			assignments: [
				{ id: 'aA', taskId: 'A', memberId: 'm1', days: 2, order: 0 },
				{ id: 'aB', taskId: 'B', memberId: 'm2', days: 2, order: 0 },
				{ id: 'aC', taskId: 'C', memberId: 'm1', days: 2, order: 1 }
			]
		});
		const s = computeSchedule(plan);
		expect(s.placements['aA'].days).toEqual(['2026-01-05', '2026-01-06']);
		expect(s.placements['aB'].days).toEqual(['2026-01-07', '2026-01-08']);
		expect(s.placements['aC'].days).toEqual(['2026-01-09', '2026-01-12']);
	});
});
