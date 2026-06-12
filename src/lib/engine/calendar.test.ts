import { describe, expect, it } from 'vitest';
import {
	addDays,
	dateRange,
	enumerateDays,
	formatDay,
	formatMonthDay,
	isWorkingDay,
	isoWeekday,
	periodEndOf,
	quarterOf,
	startOfWeek
} from './calendar';

describe('calendar', () => {
	it('adds days across month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
	});

	it('computes ISO weekdays (2026-01-05 is a Monday)', () => {
		expect(isoWeekday('2026-01-05')).toBe(1);
		expect(isoWeekday('2026-01-10')).toBe(6);
		expect(isoWeekday('2026-01-11')).toBe(7);
	});

	it('finds the Monday of a week', () => {
		expect(startOfWeek('2026-01-05')).toBe('2026-01-05');
		expect(startOfWeek('2026-01-08')).toBe('2026-01-05');
		expect(startOfWeek('2026-01-11')).toBe('2026-01-05');
	});

	it('enumerates inclusive ranges', () => {
		expect(dateRange('2026-01-05', '2026-01-07')).toEqual([
			'2026-01-05',
			'2026-01-06',
			'2026-01-07'
		]);
		expect(enumerateDays('2026-01-05', 2)).toEqual(['2026-01-05', '2026-01-06']);
	});

	it('checks working days against workweek and holidays', () => {
		const cal = { workdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-01-06']) };
		expect(isWorkingDay('2026-01-05', cal)).toBe(true);
		expect(isWorkingDay('2026-01-06', cal)).toBe(false); // holiday
		expect(isWorkingDay('2026-01-10', cal)).toBe(false); // Saturday
	});

	it('formats labels', () => {
		expect(formatDay('2026-01-05')).toBe('Mon 5');
		expect(formatMonthDay('2026-06-11')).toBe('Jun 11');
	});

	it('quarters know their exact last day', () => {
		expect(quarterOf('2026-08-15')).toMatchObject({
			label: 'Q3 2026',
			start: '2026-07-01',
			end: '2026-09-30',
			weeks: 14 // 92 days → ceil, which must never leak into the rendered period
		});
		expect(quarterOf('2026-12-31').end).toBe('2026-12-31');
	});

	it('clamps quarter-shaped periods to the quarter, leaves custom ranges alone', () => {
		// Quarter-shaped: exactly what the picker creates.
		expect(periodEndOf('2026-07-01', 14)).toBe('2026-09-30');
		expect(periodEndOf('2026-01-01', quarterOf('2026-01-01').weeks)).toBe('2026-03-31');
		// Custom ranges keep the plain weeks math.
		expect(periodEndOf('2026-07-01', 2)).toBe('2026-07-14');
		expect(periodEndOf('2026-07-06', 14)).toBe('2026-10-11');
	});
});
