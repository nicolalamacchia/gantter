import type { Absence, ISODate, Plan } from '$lib/model/types';
import { addDays, isoWeekday, periodEndOf, startOfWeek } from './calendar';

/** memberId → ISO date → absenceId, for cell rendering and PTO removal. */
export function buildAbsenceDayMap(absences: Absence[]): Record<string, Record<ISODate, string>> {
	const map: Record<string, Record<ISODate, string>> = {};
	for (const a of absences) {
		const byDay = (map[a.memberId] ??= {});
		for (let d = a.startDate; d <= a.endDate; d = addDays(d, 1)) byDay[d] = a.id;
	}
	return map;
}

export interface BoardColumn {
	memberId: string;
	name: string;
	groupId?: string;
	groupName?: string;
}

/** Members ordered by group (in plan order), ungrouped members last. */
export function boardColumns(plan: Plan): BoardColumn[] {
	const cols: BoardColumn[] = [];
	for (const g of plan.groups) {
		for (const m of plan.members.filter((m) => m.groupId === g.id)) {
			cols.push({ memberId: m.id, name: m.name, groupId: g.id, groupName: g.name });
		}
	}
	const groupIds = new Set(plan.groups.map((g) => g.id));
	for (const m of plan.members.filter((m) => !m.groupId || !groupIds.has(m.groupId))) {
		cols.push({ memberId: m.id, name: m.name });
	}
	return cols;
}

export interface BoardRow {
	date: ISODate;
	weekStart: ISODate;
	/** First visible row of its week — gets the week label and a heavier top border. */
	isWeekStart: boolean;
	isHoliday: boolean;
	/** Non-working weekday (only present when plan.showWeekends is on). */
	isWeekend: boolean;
}

/**
 * The visible timeline: one row per working weekday from the plan start.
 * Weekends are collapsed into week-boundary separators unless
 * plan.showWeekends is set (then they appear as gray, non-working rows).
 * Company holidays keep their row, rendered gray across all members.
 */
export function boardRows(plan: Plan): BoardRow[] {
	const workdaySet = new Set(plan.workdays);
	const holidays = new Set(plan.holidays);
	const rows: BoardRow[] = [];
	const end = periodEndOf(plan.startDate, plan.numWeeks);
	for (let date = plan.startDate; date <= end; date = addDays(date, 1)) {
		const isWorkweekDay = workdaySet.has(isoWeekday(date));
		if (!isWorkweekDay && !plan.showWeekends) continue;
		const weekStart = startOfWeek(date);
		const prev = rows[rows.length - 1];
		rows.push({
			date,
			weekStart,
			isWeekStart: !prev || prev.weekStart !== weekStart,
			isHoliday: isWorkweekDay && holidays.has(date),
			isWeekend: !isWorkweekDay
		});
	}
	return rows;
}
