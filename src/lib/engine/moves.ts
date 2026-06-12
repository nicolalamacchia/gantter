import { newId, type Absence, type Assignment, type ISODate, type Plan } from '$lib/model/types';
import {
	addDays,
	addWorkingDays,
	countWorkingDays,
	diffDays,
	isWorkingDay,
	nextWorkingDay,
	type WorkCalendar
} from './calendar';
import type { Schedule } from './schedule';

/**
 * Pure move semantics, shared between the store commands (commit on release)
 * and the grid's live drag preview. Every function returns new arrays computed
 * against the *committed* plan + schedule; nothing here mutates.
 */
export interface MoveContext {
	plan: Plan;
	schedule: Schedule;
}

/**
 * Invariant: two chunks of the same task sitting back-to-back in a member's
 * queue are really one block — merge them (summing days, keeping the first).
 * Applied after every command and on load.
 */
export function mergeAdjacentChunks(assignments: Assignment[]): Assignment[] {
	const byMember = new Map<string, Assignment[]>();
	for (const a of assignments) {
		const list = byMember.get(a.memberId) ?? [];
		list.push(a);
		byMember.set(a.memberId, list);
	}
	const out: Assignment[] = [];
	for (const queue of byMember.values()) {
		queue.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		let prev: Assignment | null = null;
		for (const a of queue) {
			if (prev && prev.taskId === a.taskId) {
				prev.days += a.days;
			} else {
				prev = { ...a };
				out.push(prev);
			}
		}
	}
	return out;
}

function sortedQueue(plan: Plan, memberId: string, exclude: Set<string>): Assignment[] {
	return plan.assignments
		.filter((a) => a.memberId === memberId && !exclude.has(a.id))
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Midpoint rule: first half of a block → take its place, second half → right after it. */
function insertionIndex(queue: Assignment[], schedule: Schedule, targetDate: ISODate): number {
	for (let i = 0; i < queue.length; i++) {
		const days = schedule.placements[queue[i].id]?.days ?? [];
		if (!days.length) continue;
		if (targetDate <= days[days.length - 1]) {
			const mid = days[Math.floor((days.length - 1) / 2)];
			return targetDate <= mid ? i : i + 1;
		}
	}
	return queue.length;
}

function ordersFor(
	ctx: MoveContext,
	memberId: string,
	movingIds: string[],
	targetDate: ISODate
): Map<string, number> {
	const queue = sortedQueue(ctx.plan, memberId, new Set(movingIds));
	const ids = queue.map((a) => a.id);
	ids.splice(insertionIndex(queue, ctx.schedule, targetDate), 0, ...movingIds);
	return new Map(ids.map((id, i) => [id, i]));
}

/** Move a single share, possibly onto another member's lane. */
export function moveShare(
	ctx: MoveContext,
	movingId: string,
	targetMemberId: string,
	targetDate: ISODate
): Assignment[] {
	const orders = ordersFor(ctx, targetMemberId, [movingId], targetDate);
	return ctx.plan.assignments.map((a) => {
		if (a.id === movingId) {
			return { ...a, memberId: targetMemberId, order: orders.get(movingId)! };
		}
		const order = orders.get(a.id);
		return order !== undefined ? { ...a, order } : { ...a };
	});
}

/** Move every member's share of the task to the target date together. */
export function moveWholeTask(ctx: MoveContext, taskId: string, targetDate: ISODate): Assignment[] {
	const byMember = new Map<string, string[]>();
	for (const a of ctx.plan.assignments) {
		if (a.taskId !== taskId) continue;
		const list = byMember.get(a.memberId) ?? [];
		list.push(a.id);
		byMember.set(a.memberId, list);
	}
	const orders = new Map<string, number>();
	for (const [memberId, ids] of byMember) {
		for (const [id, order] of ordersFor(ctx, memberId, ids, targetDate)) orders.set(id, order);
	}
	return ctx.plan.assignments.map((a) => {
		const order = orders.get(a.id);
		return order !== undefined ? { ...a, order } : { ...a };
	});
}

/**
 * Drop a share into the middle of the block under the target date, splitting
 * that block in two around it. Falls back to a plain move when the target
 * cell is empty, is the moving block itself, or the drop lands on an edge.
 */
export function splitDrop(
	ctx: MoveContext,
	movingId: string,
	targetMemberId: string,
	targetDate: ISODate,
	tailId: string = newId()
): Assignment[] {
	const targetAssignmentId = ctx.schedule.dayMap[targetMemberId]?.[targetDate];
	if (!targetAssignmentId || targetAssignmentId === movingId) {
		return moveShare(ctx, movingId, targetMemberId, targetDate);
	}
	const target = ctx.plan.assignments.find((a) => a.id === targetAssignmentId);
	const placement = ctx.schedule.placements[targetAssignmentId];
	if (!target || !placement) return moveShare(ctx, movingId, targetMemberId, targetDate);
	const before = placement.days.filter((d) => d < targetDate).length;
	const after = Math.max(0, Math.round(target.days)) - before;
	if (before === 0 || after <= 0) {
		return moveShare(ctx, movingId, targetMemberId, targetDate);
	}
	const queue = sortedQueue(ctx.plan, targetMemberId, new Set([movingId]));
	const ids = queue.map((a) => a.id);
	ids.splice(ids.indexOf(targetAssignmentId) + 1, 0, movingId, tailId);
	const orders = new Map(ids.map((id, i) => [id, i]));
	const result: Assignment[] = ctx.plan.assignments.map((a) => {
		if (a.id === movingId) {
			return { ...a, memberId: targetMemberId, order: orders.get(movingId)! };
		}
		if (a.id === targetAssignmentId) return { ...a, days: before, order: orders.get(a.id)! };
		const order = orders.get(a.id);
		return order !== undefined ? { ...a, order } : { ...a };
	});
	result.push({
		id: tailId,
		taskId: target.taskId,
		memberId: targetMemberId,
		days: after,
		order: orders.get(tailId)!
	});
	return result;
}

/**
 * Carves the chunk of work from `grabDate` to the assignment's end off as its
 * own assignment and moves it to the target; the days before the grab stay
 * where they are. Grabbing the first day moves the whole share instead.
 */
export function carveChunk(
	ctx: MoveContext,
	movingId: string,
	grabDate: ISODate,
	targetMemberId: string,
	targetDate: ISODate,
	chunkId: string = newId()
): Assignment[] {
	const source = ctx.plan.assignments.find((a) => a.id === movingId);
	const placement = ctx.schedule.placements[movingId];
	if (!source || !placement) return ctx.plan.assignments.map((a) => ({ ...a }));
	const keptDays = placement.days.filter((d) => d < grabDate).length;
	if (keptDays === 0) return moveShare(ctx, movingId, targetMemberId, targetDate);
	const chunkDays = Math.max(0, Math.round(source.days)) - keptDays;
	if (chunkDays <= 0) return ctx.plan.assignments.map((a) => ({ ...a }));
	const orders = ordersFor(ctx, targetMemberId, [chunkId], targetDate);
	const result: Assignment[] = ctx.plan.assignments.map((a) => {
		const order = orders.get(a.id);
		if (a.id === movingId) return { ...a, days: keptDays, order: order ?? a.order };
		return order !== undefined ? { ...a, order } : { ...a };
	});
	result.push({
		id: chunkId,
		taskId: source.taskId,
		memberId: targetMemberId,
		days: chunkDays,
		order: orders.get(chunkId)!
	});
	return result;
}

/**
 * Paints a chunk of a task onto (member, date range), PTO-style. The amount is
 * the number of available working days in the range. Touching or overlapping
 * an existing block of the same task extends that assignment; otherwise a new
 * one is inserted at the painted date.
 */
export function paintChunk(
	ctx: MoveContext,
	taskId: string,
	memberId: string,
	startDate: ISODate,
	endDate: ISODate,
	chunkId: string = newId()
): Assignment[] {
	const { plan } = ctx;
	if (endDate < startDate) [startDate, endDate] = [endDate, startDate];
	const cal: WorkCalendar = {
		workdays: new Set(plan.workdays),
		holidays: new Set(plan.holidays)
	};
	const absent = new Set<ISODate>();
	for (const a of plan.absences) {
		if (a.memberId !== memberId) continue;
		for (let d = a.startDate; d <= a.endDate; d = addDays(d, 1)) absent.add(d);
	}
	const available = (d: ISODate) => isWorkingDay(d, cal) && !absent.has(d);
	let amount = 0;
	for (let d = startDate; d <= endDate; d = addDays(d, 1)) if (available(d)) amount++;
	if (amount === 0) return plan.assignments.map((a) => ({ ...a }));

	const step = (from: ISODate, direction: 1 | -1): ISODate => {
		let d = addDays(from, direction);
		for (let i = 0; !available(d) && i < 3660; i++) d = addDays(d, direction);
		return d;
	};
	for (const a of plan.assignments) {
		if (a.taskId !== taskId || a.memberId !== memberId) continue;
		const days = ctx.schedule.placements[a.id]?.days ?? [];
		if (!days.length) continue;
		const expandedStart = step(days[0], -1);
		const expandedEnd = step(days[days.length - 1], 1);
		if (startDate <= expandedEnd && endDate >= expandedStart) {
			return plan.assignments.map((x) =>
				x.id === a.id ? { ...x, days: x.days + amount } : { ...x }
			);
		}
	}
	const orders = ordersFor(ctx, memberId, [chunkId], startDate);
	const result: Assignment[] = plan.assignments.map((a) => {
		const order = orders.get(a.id);
		return order !== undefined ? { ...a, order } : { ...a };
	});
	result.push({ id: chunkId, taskId, memberId, days: amount, order: orders.get(chunkId)! });
	return result;
}

/**
 * Backlog drop: brand-new assignments (one per task) enter a member's queue
 * so the first lands at the target date and the rest follow in order.
 */
export function dropNewAssignments(
	ctx: MoveContext,
	memberId: string,
	items: Array<{ taskId: string; days: number }>,
	targetDate: ISODate,
	ids: string[] = items.map(() => newId())
): Assignment[] {
	if (!items.length) return ctx.plan.assignments.map((a) => ({ ...a }));
	const orders = ordersFor(ctx, memberId, ids, targetDate);
	const result: Assignment[] = ctx.plan.assignments.map((a) => {
		const order = orders.get(a.id);
		return order !== undefined ? { ...a, order } : { ...a };
	});
	items.forEach((item, i) => {
		result.push({
			id: ids[i],
			taskId: item.taskId,
			memberId,
			days: item.days,
			order: orders.get(ids[i])!
		});
	});
	return result;
}

/**
 * Move an absence so the grabbed day lands on the drop cell, preserving its
 * working-day length (it rolls over weekends and holidays).
 */
export function shiftAbsence(
	plan: Plan,
	absenceId: string,
	targetMemberId: string,
	targetDate: ISODate,
	grabDate: ISODate
): Absence[] {
	const cal: WorkCalendar = {
		workdays: new Set(plan.workdays),
		holidays: new Set(plan.holidays)
	};
	return plan.absences.map((a) => {
		if (a.id !== absenceId) return { ...a };
		const workingLength = countWorkingDays(a.startDate, a.endDate, cal);
		if (workingLength === 0) {
			// Degenerate range with no working days: plain calendar shift.
			const length = diffDays(a.startDate, a.endDate);
			return {
				...a,
				memberId: targetMemberId,
				startDate: targetDate,
				endDate: addDays(targetDate, length)
			};
		}
		const grabOffset =
			grabDate > a.startDate ? countWorkingDays(a.startDate, addDays(grabDate, -1), cal) : 0;
		const newGrab = nextWorkingDay(targetDate, cal);
		const start = addWorkingDays(newGrab, -grabOffset, cal);
		return {
			...a,
			memberId: targetMemberId,
			startDate: start,
			endDate: addWorkingDays(start, workingLength - 1, cal)
		};
	});
}
