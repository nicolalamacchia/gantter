import ExcelJS from 'exceljs';
import { boardColumns, boardRows } from '$lib/engine/board';
import { addDays, formatDay, formatMonthDay } from '$lib/engine/calendar';
import { computeSchedule } from '$lib/engine/schedule';
import { bestTextOn } from '$lib/model/colors';
import type { ISODate, Plan, Task } from '$lib/model/types';
import { legendEntries, periodColor, rootOf } from './labels';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const HOLIDAY_GRAY = '#64748b';
const WEEKEND_GRAY = '#dde3ec';
const ABSENCE_GRAY = '#94a3b8';
const HEADER_GRAY = '#e2e8f0';

function argb(hex: string): string {
	return `FF${hex.replace('#', '').toUpperCase()}`;
}

function solid(hex: string): ExcelJS.Fill {
	return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } };
}

/** Black-or-white font color readable on the given fill. */
function fontOn(hex: string): { argb: string } {
	return { argb: argb(bestTextOn(hex)) };
}

/** Builds the people×days board (with colors, like the original sheet) plus a Tasks WBS sheet. */
export async function exportXlsx(plan: Plan): Promise<Blob> {
	const schedule = computeSchedule(plan);
	const columns = boardColumns(plan);
	const rows = boardRows(plan);
	const tasksById = new Map(plan.tasks.map((t) => [t.id, t]));

	const absenceNotes: Record<string, Record<ISODate, string>> = {};
	for (const a of plan.absences) {
		const byDay = (absenceNotes[a.memberId] ??= {});
		for (let d = a.startDate; d <= a.endDate; d = addDays(d, 1)) byDay[d] = a.note ?? 'PTO';
	}

	const wb = new ExcelJS.Workbook();
	wb.creator = plan.name;

	// All tabs of this period's workbook wear the same color, like the sheet mirror.
	const tabProps = { tabColor: { argb: argb(periodColor(plan)) } };

	// ---- Board sheet ----------------------------------------------------------
	const board = wb.addWorksheet('Board', {
		views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
		properties: tabProps
	});
	board.getColumn(1).width = 11;
	columns.forEach((_, i) => (board.getColumn(i + 2).width = 28));
	const legendCol = columns.length + 3;
	board.getColumn(legendCol).width = 52;
	board.getColumn(legendCol + 1).width = 9;

	const groupRow = board.getRow(1);
	const memberRow = board.getRow(2);
	memberRow.getCell(1).value = 'Week';
	columns.forEach((c, i) => {
		groupRow.getCell(i + 2).value = c.groupName ?? '';
		memberRow.getCell(i + 2).value = c.name;
	});
	// Merge contiguous group spans in the group header row.
	let spanStart = 0;
	for (let i = 1; i <= columns.length; i++) {
		if (i === columns.length || columns[i].groupId !== columns[spanStart].groupId) {
			if (i - spanStart > 1 && columns[spanStart].groupId) {
				board.mergeCells(1, spanStart + 2, 1, i + 1);
			}
			spanStart = i;
		}
	}
	for (const row of [groupRow, memberRow]) {
		row.eachCell((cell) => {
			cell.font = { bold: true, size: 10 };
			cell.fill = solid(HEADER_GRAY);
			cell.alignment = { horizontal: 'center' };
		});
	}

	rows.forEach((row, ri) => {
		const r = board.getRow(ri + 3);
		const dateCell = r.getCell(1);
		dateCell.value = row.isWeekStart ? formatMonthDay(row.date) : formatDay(row.date);
		dateCell.font = { size: 8.5, bold: row.isWeekStart, color: { argb: 'FF475569' } };
		dateCell.alignment = { horizontal: 'right' };

		for (let ci = 0; ci <= columns.length; ci++) {
			const cell = r.getCell(ci + 1);
			if (row.isWeekStart) {
				cell.border = { top: { style: 'medium', color: { argb: argb(ABSENCE_GRAY) } } };
			}
			if (ci === 0) continue;
			const col = columns[ci - 1];
			if (row.isHoliday) {
				cell.fill = solid(HOLIDAY_GRAY);
				continue;
			}
			if (row.isWeekend) {
				cell.fill = solid(WEEKEND_GRAY);
				continue;
			}
			const absNote = absenceNotes[col.memberId]?.[row.date];
			if (absNote !== undefined) {
				cell.fill = solid(ABSENCE_GRAY);
				cell.value = absNote;
				cell.font = { size: 8.5, color: { argb: 'FFF1F5F9' } };
				cell.alignment = { wrapText: true };
				continue;
			}
			const assignmentId = schedule.dayMap[col.memberId]?.[row.date];
			if (assignmentId) {
				// Board cells wear the TOPMOST parent's identity; the legend
				// on the side carries the per-task breakdown.
				const task = tasksById.get(schedule.placements[assignmentId].taskId);
				const root = task ? rootOf(task, tasksById) : undefined;
				const color = root?.color ?? '#cccccc';
				cell.value = root?.name ?? '?';
				cell.fill = solid(color);
				cell.font = { size: 9, color: fontOn(color) };
				cell.alignment = { wrapText: true };
			}
		}
		if (row.isHoliday) dateCell.fill = solid(HOLIDAY_GRAY);
		if (row.isWeekend) dateCell.fill = solid(WEEKEND_GRAY);
	});

	// Task legend (the breakdown), like column M of the original sheet.
	const legendHeader = board.getCell(2, legendCol);
	legendHeader.value = 'Task';
	legendHeader.font = { bold: true };
	const estHeader = board.getCell(2, legendCol + 1);
	estHeader.value = 'Est. (d)';
	estHeader.font = { bold: true, size: 9 };
	const legend = legendEntries(plan);
	legend.forEach(({ task, depth }, i) => {
		const cell = board.getCell(3 + i, legendCol);
		cell.value = '    '.repeat(depth) + task.name;
		cell.fill = solid(task.color);
		cell.font = { size: 10, color: fontOn(task.color) };
		cell.alignment = { wrapText: true };
		if (task.estimateDays != null) board.getCell(3 + i, legendCol + 1).value = task.estimateDays;
	});
	// Fixed heights + wrapText = overflow is hidden without truncating the text.
	for (let i = 0; i < Math.max(rows.length, legend.length); i++) {
		board.getRow(3 + i).height = 13;
	}

	// ---- Gantt sheet --------------------------------------------------------------
	const gantt = wb.addWorksheet('Gantt', {
		views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
		properties: tabProps
	});
	gantt.getColumn(1).width = 46;
	rows.forEach((_, i) => (gantt.getColumn(i + 2).width = 3.2));
	const ganttHeader = gantt.getRow(1);
	ganttHeader.getCell(1).value = 'Task';
	ganttHeader.getCell(1).font = { bold: true };
	ganttHeader.getCell(1).fill = solid(HEADER_GRAY);
	rows.forEach((row, i) => {
		const cell = ganttHeader.getCell(i + 2);
		cell.fill = solid(HEADER_GRAY);
		if (row.isWeekStart) {
			cell.value = formatMonthDay(row.date);
			cell.font = { size: 8, bold: true };
			cell.alignment = { horizontal: 'left' };
			cell.border = { left: { style: 'thin', color: { argb: argb(ABSENCE_GRAY) } } };
		}
	});

	const childrenOf = new Map<string, Task[]>();
	for (const t of plan.tasks) {
		if (!t.parentId) continue;
		const list = childrenOf.get(t.parentId) ?? [];
		list.push(t);
		childrenOf.set(t.parentId, list);
	}
	const collectDays = (taskId: string, into: Set<ISODate>) => {
		for (const a of plan.assignments) {
			if (a.taskId !== taskId) continue;
			for (const d of schedule.placements[a.id]?.days ?? []) into.add(d);
		}
		for (const c of childrenOf.get(taskId) ?? []) collectDays(c.id, into);
	};
	let ganttRowIdx = 2;
	const addGanttRow = (task: Task, depth: number) => {
		const r = gantt.getRow(ganttRowIdx++);
		r.height = 13;
		const nameCell = r.getCell(1);
		nameCell.value = `${'    '.repeat(depth)}${task.name}`;
		nameCell.fill = solid(task.color);
		nameCell.font = { size: 10, color: fontOn(task.color) };
		nameCell.alignment = { wrapText: true };
		const active = new Set<ISODate>();
		collectDays(task.id, active);
		rows.forEach((row, i) => {
			const cell = r.getCell(i + 2);
			if (active.has(row.date)) cell.fill = solid(task.color);
			else if (row.isHoliday) cell.fill = solid(HOLIDAY_GRAY);
			else if (row.isWeekend) cell.fill = solid(WEEKEND_GRAY);
			if (row.isWeekStart) {
				cell.border = { left: { style: 'thin', color: { argb: argb(ABSENCE_GRAY) } } };
			}
		});
		for (const c of childrenOf.get(task.id) ?? []) addGanttRow(c, depth + 1);
	};
	for (const t of plan.tasks.filter((t) => !t.parentId)) addGanttRow(t, 0);

	// ---- Tasks (WBS) sheet ------------------------------------------------------
	const wbs = wb.addWorksheet('Tasks', { properties: tabProps });
	wbs.columns = [
		{ header: 'Task', width: 46 },
		{ header: 'Parent', width: 36 },
		{ header: 'Sub-team', width: 14 },
		{ header: 'Estimate (d)', width: 12 },
		{ header: 'Assigned (d)', width: 12 },
		{ header: 'Members', width: 32 },
		{ header: 'Start', width: 12 },
		{ header: 'End', width: 12 }
	];
	wbs.getRow(1).font = { bold: true };
	const membersById = new Map(plan.members.map((m) => [m.id, m]));
	const groupsById = new Map(plan.groups.map((g) => [g.id, g]));
	for (const task of plan.tasks) {
		const rollup = schedule.rollups[task.id];
		const row = wbs.addRow([
			task.name,
			task.parentId ? (tasksById.get(task.parentId)?.name ?? '') : '',
			task.groupId ? (groupsById.get(task.groupId)?.name ?? '') : '',
			task.estimateDays ?? '',
			rollup?.assignedDays || '',
			(rollup?.memberIds ?? []).map((id) => membersById.get(id)?.name ?? '?').join(', '),
			rollup?.startDate ?? '',
			rollup?.endDate ?? ''
		]);
		row.getCell(1).fill = solid(task.color);
		row.getCell(1).font = { color: fontOn(task.color) };
		row.getCell(1).alignment = { wrapText: true };
		row.height = 14;
	}

	const buffer = await wb.xlsx.writeBuffer();
	return new Blob([buffer], { type: XLSX_MIME });
}
