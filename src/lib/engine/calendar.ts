import type { ISODate } from '$lib/model/types';

/** All date math is done in UTC so local timezones can never shift a day. */
export function toDate(iso: ISODate): Date {
	return new Date(`${iso}T00:00:00Z`);
}

export function toISO(date: Date): ISODate {
	return date.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, n: number): ISODate {
	const d = toDate(iso);
	d.setUTCDate(d.getUTCDate() + n);
	return toISO(d);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: ISODate): number {
	const day = toDate(iso).getUTCDay();
	return day === 0 ? 7 : day;
}

/** Monday of the week containing `iso`. */
export function startOfWeek(iso: ISODate): ISODate {
	return addDays(iso, 1 - isoWeekday(iso));
}

/** Calendar days from `a` to `b` (positive when b is later). */
export function diffDays(a: ISODate, b: ISODate): number {
	return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

export interface Quarter {
	label: string;
	start: ISODate;
	/** Weeks needed to cover the quarter (ceil). */
	weeks: number;
}

export function quarterOf(iso: ISODate): Quarter {
	const year = Number(iso.slice(0, 4));
	const q = Math.floor((Number(iso.slice(5, 7)) - 1) / 3);
	const start: ISODate = `${year}-${String(q * 3 + 1).padStart(2, '0')}-01`;
	const nextStart =
		q === 3 ? `${year + 1}-01-01` : `${year}-${String(q * 3 + 4).padStart(2, '0')}-01`;
	return {
		label: `Q${q + 1} ${year}`,
		start,
		weeks: Math.ceil(diffDays(start, nextStart) / 7)
	};
}

/** Quarters surrounding `iso`, e.g. 2 back and 5 ahead. */
export function quartersAround(iso: ISODate, before = 2, after = 5): Quarter[] {
	const quarters: Quarter[] = [];
	let cursor = quarterOf(iso).start;
	for (let i = 0; i < before; i++) cursor = quarterOf(addDays(cursor, -1)).start;
	for (let i = 0; i < before + after + 1; i++) {
		const q = quarterOf(cursor);
		quarters.push(q);
		cursor = addDays(q.start, q.weeks * 7 + 1);
		cursor = quarterOf(cursor).start;
	}
	return quarters;
}

/** Every date from `start` to `end`, both inclusive. */
export function dateRange(start: ISODate, end: ISODate): ISODate[] {
	const days: ISODate[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
	return days;
}

export function enumerateDays(start: ISODate, count: number): ISODate[] {
	const days: ISODate[] = [];
	for (let i = 0, d = start; i < count; i++, d = addDays(d, 1)) days.push(d);
	return days;
}

export interface WorkCalendar {
	workdays: Set<number>;
	holidays: Set<ISODate>;
}

export function isWorkingDay(iso: ISODate, cal: WorkCalendar): boolean {
	return cal.workdays.has(isoWeekday(iso)) && !cal.holidays.has(iso);
}

const WORKDAY_SCAN_CAP = 3660;

/** First working day on or after `iso`. */
export function nextWorkingDay(iso: ISODate, cal: WorkCalendar): ISODate {
	let d = iso;
	for (let i = 0; !isWorkingDay(d, cal) && i < WORKDAY_SCAN_CAP; i++) d = addDays(d, 1);
	return d;
}

/** Steps `n` working days from a working day (negative steps backwards). */
export function addWorkingDays(iso: ISODate, n: number, cal: WorkCalendar): ISODate {
	let d = iso;
	let left = Math.abs(n);
	const step = n < 0 ? -1 : 1;
	for (let i = 0; left > 0 && i < WORKDAY_SCAN_CAP; i++) {
		d = addDays(d, step);
		if (isWorkingDay(d, cal)) left--;
	}
	return d;
}

/** Working days within `[start, end]`, both inclusive. */
export function countWorkingDays(start: ISODate, end: ISODate, cal: WorkCalendar): number {
	let count = 0;
	for (let d = start; d <= end; d = addDays(d, 1)) if (isWorkingDay(d, cal)) count++;
	return count;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];

/** e.g. 'Mon 15' */
export function formatDay(iso: ISODate): string {
	return `${DAY_NAMES[isoWeekday(iso) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** e.g. 'Jun 15' */
export function formatMonthDay(iso: ISODate): string {
	return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** e.g. 'Jun 15, 2026' */
export function formatFull(iso: ISODate): string {
	return `${formatMonthDay(iso)}, ${iso.slice(0, 4)}`;
}
