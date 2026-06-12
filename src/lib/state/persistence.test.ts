import { describe, expect, it } from 'vitest';
import type { Plan } from '$lib/model/types';
import { planFromJSON, planToJSON } from './persistence';

function fixture(): Plan {
	return {
		id: 'p',
		name: 'Q3 2026',
		schemaVersion: 1,
		startDate: '2026-07-01',
		numWeeks: 13,
		workdays: [1, 2, 3, 4, 5],
		showWeekends: true,
		holidays: ['2026-08-15'],
		groups: [{ id: 'g1', name: 'FE' }],
		members: [{ id: 'm1', name: 'Nicola', groupId: 'g1' }],
		tasks: [{ id: 'T', name: 'Task', color: '#abc' }],
		assignments: [{ id: 'a1', taskId: 'T', memberId: 'm1', days: 3, order: 0 }],
		absences: [{ id: 'pto', memberId: 'm1', startDate: '2026-07-06', endDate: '2026-07-07' }]
	};
}

describe('plan file round-trip', () => {
	it('preserves the period (dates/quarter) and everything else through export → import', () => {
		expect(planFromJSON(planToJSON(fixture()))).toEqual(fixture());
	});

	it('rejects a file without a period', () => {
		const noStart = { ...fixture(), startDate: undefined };
		const noWeeks = { ...fixture(), numWeeks: undefined };
		expect(() => planFromJSON(JSON.stringify(noStart))).toThrow();
		expect(() => planFromJSON(JSON.stringify(noWeeks))).toThrow();
	});

	it('rejects a file with a malformed period', () => {
		const badDate = { ...fixture(), startDate: 'July 1st' };
		const badWeeks = { ...fixture(), numWeeks: 0 };
		expect(() => planFromJSON(JSON.stringify(badDate))).toThrow();
		expect(() => planFromJSON(JSON.stringify(badWeeks))).toThrow();
	});
});
