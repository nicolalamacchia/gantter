import { addDays, formatMonthDay, periodEndOf, quarterOf } from '$lib/engine/calendar';
import type { ISODate } from '$lib/model/types';
import { store } from './plan.svelte';

function spillDaysFor(taskId: string, periodEnd: ISODate): number {
	let total = 0;
	const walk = (id: string) => {
		for (const assignment of store.plan.assignments) {
			if (assignment.taskId !== id) continue;
			const placement = store.schedule.placements[assignment.id];
			if (!placement) continue;
			total += placement.days.filter((d) => d > periodEnd).length + placement.overflowDays;
		}
		for (const c of store.childrenByParent.get(id) ?? []) walk(c.id);
	};
	walk(taskId);
	return total;
}

/**
 * After an edit pushed a task past the period's end, offer to roll over ONLY
 * the overflowing days: they continue in the next quarter as the same task,
 * just for the people whose work spills. The work that fits stays put.
 * Returns true when something was rolled over.
 */
export function maybeOfferRollover(taskId: string, prevEnd: ISODate | null): boolean {
	const periodEnd = periodEndOf(store.plan.startDate, store.plan.numWeeks);
	const end = store.schedule.rollups[taskId]?.endDate ?? null;
	if (!end || end <= periodEnd) return false;
	// Only when this edit pushed the end LATER: reducing days, or rearranging a
	// task that already rolled over, never prompts.
	if (prevEnd && end <= prevEnd) return false;
	const spill = spillDaysFor(taskId, periodEnd);
	if (spill <= 0) return false;
	const next = quarterOf(addDays(periodEnd, 1));
	const name = store.tasksById.get(taskId)?.name ?? 'This task';
	if (
		confirm(
			`"${name}" runs ${spill}d past this period (ends ${formatMonthDay(end)}, period ends ` +
				`${formatMonthDay(periodEnd)}).\n\nMove only those ${spill} day${spill === 1 ? '' : 's'} to ` +
				`${next.label} as a continuation of the same task? The work that fits stays here. ` +
				`Cancel keeps everything here, marked with ⚠.`
		)
	) {
		return store.rolloverTaskSpill(taskId, next.start, next.weeks, next.label) > 0;
	}
	return false;
}
