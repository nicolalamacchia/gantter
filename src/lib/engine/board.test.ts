import { describe, expect, it } from 'vitest';
import type { Plan } from '$lib/model/types';
import { boardRows } from './board';

/** 2026-01-05 is a Monday. */
function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		id: 'p',
		name: 'Test',
		schemaVersion: 1,
		startDate: '2026-01-05',
		numWeeks: 2,
		workdays: [1, 2, 3, 4, 5],
		holidays: [],
		groups: [],
		members: [],
		tasks: [],
		assignments: [],
		absences: [],
		...overrides
	};
}

describe('boardRows', () => {
	it('collapses weekends by default', () => {
		const rows = boardRows(makePlan());
		expect(rows).toHaveLength(10); // 2 weeks × 5 workdays
		expect(rows.every((r) => !r.isWeekend)).toBe(true);
		expect(rows[5].date).toBe('2026-01-12'); // Monday follows Friday directly
		expect(rows[5].isWeekStart).toBe(true);
	});

	it('includes weekend rows when showWeekends is on', () => {
		const rows = boardRows(makePlan({ showWeekends: true }));
		expect(rows).toHaveLength(14);
		const saturday = rows.find((r) => r.date === '2026-01-10')!;
		expect(saturday.isWeekend).toBe(true);
		expect(saturday.isHoliday).toBe(false);
		// Monday still starts the week, not the weekend days.
		expect(rows.filter((r) => r.isWeekStart).map((r) => r.date)).toEqual([
			'2026-01-05',
			'2026-01-12'
		]);
	});

	it('keeps holiday rows distinct from weekends', () => {
		const rows = boardRows(makePlan({ holidays: ['2026-01-06'], showWeekends: true }));
		const holiday = rows.find((r) => r.date === '2026-01-06')!;
		expect(holiday.isHoliday).toBe(true);
		expect(holiday.isWeekend).toBe(false);
	});
});
