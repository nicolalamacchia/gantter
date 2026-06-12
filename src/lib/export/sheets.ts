import { boardColumns, boardRows, type BoardColumn, type BoardRow } from '$lib/engine/board';
import { addDays, formatDay, formatMonthDay } from '$lib/engine/calendar';
import type { Schedule } from '$lib/engine/schedule';
import { bestTextOn } from '$lib/model/colors';
import type { ISODate, Plan, Task } from '$lib/model/types';

/**
 * Pure builders for the Google Sheets `batchUpdate` that mirrors the Excel
 * export (Board / Gantt / Tasks tabs). No fetch here — the sync layer sends
 * the requests; this stays unit-testable.
 */

const HOLIDAY_GRAY = '#64748b';
const WEEKEND_GRAY = '#dde3ec';
const ABSENCE_GRAY = '#94a3b8';
const HEADER_GRAY = '#e2e8f0';

export interface SheetTabIds {
	board: number;
	gantt: number;
	tasks: number;
}

export function hexToColor(hex: string): { red: number; green: number; blue: number } {
	const h = hex.replace('#', '');
	return {
		red: parseInt(h.slice(0, 2), 16) / 255,
		green: parseInt(h.slice(2, 4), 16) / 255,
		blue: parseInt(h.slice(4, 6), 16) / 255
	};
}

type CellData = Record<string, unknown>;
interface RowData {
	values: CellData[];
}

interface CellOpts {
	bg?: string;
	fg?: string;
	bold?: boolean;
	size?: number;
	align?: 'LEFT' | 'CENTER' | 'RIGHT';
}

function cell(value: string | number = '', opts: CellOpts = {}): CellData {
	const data: CellData = {};
	if (value !== '') {
		data.userEnteredValue =
			typeof value === 'number' ? { numberValue: value } : { stringValue: value };
	}
	const format: Record<string, unknown> = {};
	if (opts.bg) format.backgroundColor = hexToColor(opts.bg);
	const text: Record<string, unknown> = {};
	if (opts.fg) text.foregroundColor = hexToColor(opts.fg);
	if (opts.bold) text.bold = true;
	if (opts.size) text.fontSize = opts.size;
	if (Object.keys(text).length) format.textFormat = text;
	if (opts.align) format.horizontalAlignment = opts.align;
	if (Object.keys(format).length) data.userEnteredFormat = format;
	return data;
}

function header(value: string): CellData {
	return cell(value, { bg: HEADER_GRAY, bold: true, size: 10, align: 'CENTER' });
}

function taskLabel(task: Task | undefined, tasksById: Map<string, Task>): string {
	if (!task) return '?';
	const parent = task.parentId ? tasksById.get(task.parentId) : undefined;
	return parent ? `${parent.name} · ${task.name}` : task.name;
}

// ---- Board tab --------------------------------------------------------------------

function boardGrid(
	plan: Plan,
	schedule: Schedule,
	columns: BoardColumn[],
	rows: BoardRow[]
): RowData[] {
	const tasksById = new Map(plan.tasks.map((t) => [t.id, t]));
	const absenceNotes: Record<string, Record<ISODate, string>> = {};
	for (const a of plan.absences) {
		const byDay = (absenceNotes[a.memberId] ??= {});
		for (let d = a.startDate; d <= a.endDate; d = addDays(d, 1)) byDay[d] = a.note ?? 'PTO';
	}

	const legend = (i: number): CellData => {
		const task = plan.tasks[i];
		if (!task) return cell();
		return cell((task.parentId ? '    ' : '') + taskLabel(task, tasksById), {
			bg: task.color,
			fg: bestTextOn(task.color),
			size: 10
		});
	};

	const groupRow: CellData[] = [header('')];
	const memberRow: CellData[] = [header('Week')];
	for (const c of columns) {
		groupRow.push(header(c.groupName ?? ''));
		memberRow.push(header(c.name));
	}
	groupRow.push(cell(), cell());
	memberRow.push(cell(), cell('Task', { bold: true }));
	const grid: RowData[] = [{ values: groupRow }, { values: memberRow }];

	const bodyRows = Math.max(rows.length, plan.tasks.length);
	for (let ri = 0; ri < bodyRows; ri++) {
		const row = rows[ri];
		const values: CellData[] = [];
		if (row) {
			const dateBg = row.isHoliday ? HOLIDAY_GRAY : row.isWeekend ? WEEKEND_GRAY : undefined;
			values.push(
				cell(row.isWeekStart ? formatMonthDay(row.date) : formatDay(row.date), {
					size: 9,
					bold: row.isWeekStart,
					fg: '#475569',
					align: 'RIGHT',
					bg: dateBg
				})
			);
			for (const col of columns) {
				if (row.isHoliday) {
					values.push(cell('', { bg: HOLIDAY_GRAY }));
					continue;
				}
				if (row.isWeekend) {
					values.push(cell('', { bg: WEEKEND_GRAY }));
					continue;
				}
				const absNote = absenceNotes[col.memberId]?.[row.date];
				if (absNote !== undefined) {
					values.push(cell(absNote, { bg: ABSENCE_GRAY, fg: '#f1f5f9', size: 9 }));
					continue;
				}
				const assignmentId = schedule.dayMap[col.memberId]?.[row.date];
				if (assignmentId) {
					const task = tasksById.get(schedule.placements[assignmentId].taskId);
					const color = task?.color ?? '#cccccc';
					values.push(
						cell(taskLabel(task, tasksById), { bg: color, fg: bestTextOn(color), size: 9 })
					);
				} else {
					values.push(cell());
				}
			}
		} else {
			// The legend outgrew the timeline — pad the board side.
			for (let i = 0; i <= columns.length; i++) values.push(cell());
		}
		values.push(cell(), legend(ri));
		grid.push({ values });
	}
	return grid;
}

// ---- Gantt tab --------------------------------------------------------------------

function ganttGrid(plan: Plan, schedule: Schedule, rows: BoardRow[]): RowData[] {
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

	const headerRow: CellData[] = [header('Task')];
	for (const row of rows) {
		headerRow.push(
			row.isWeekStart
				? cell(formatMonthDay(row.date), { bg: HEADER_GRAY, bold: true, size: 8, align: 'LEFT' })
				: cell('', { bg: HEADER_GRAY })
		);
	}
	const grid: RowData[] = [{ values: headerRow }];

	const addRow = (task: Task, depth: number) => {
		const values: CellData[] = [
			cell(`${'    '.repeat(depth)}${task.name}`, {
				bg: task.color,
				fg: bestTextOn(task.color),
				size: 10
			})
		];
		const active = new Set<ISODate>();
		collectDays(task.id, active);
		for (const row of rows) {
			if (active.has(row.date)) values.push(cell('', { bg: task.color }));
			else if (row.isHoliday) values.push(cell('', { bg: HOLIDAY_GRAY }));
			else if (row.isWeekend) values.push(cell('', { bg: WEEKEND_GRAY }));
			else values.push(cell());
		}
		grid.push({ values });
		for (const c of childrenOf.get(task.id) ?? []) addRow(c, depth + 1);
	};
	for (const t of plan.tasks.filter((t) => !t.parentId)) addRow(t, 0);
	return grid;
}

// ---- Tasks (WBS) tab ----------------------------------------------------------------

function tasksGrid(plan: Plan, schedule: Schedule): RowData[] {
	const tasksById = new Map(plan.tasks.map((t) => [t.id, t]));
	const membersById = new Map(plan.members.map((m) => [m.id, m]));
	const groupsById = new Map(plan.groups.map((g) => [g.id, g]));
	const grid: RowData[] = [
		{
			values: [
				'Task',
				'Parent',
				'Sub-team',
				'Estimate (d)',
				'Assigned (d)',
				'Members',
				'Start',
				'End'
			].map((h) => cell(h, { bold: true }))
		}
	];
	for (const task of plan.tasks) {
		const rollup = schedule.rollups[task.id];
		grid.push({
			values: [
				cell(task.name, { bg: task.color, fg: bestTextOn(task.color) }),
				cell(task.parentId ? (tasksById.get(task.parentId)?.name ?? '') : ''),
				cell(task.groupId ? (groupsById.get(task.groupId)?.name ?? '') : ''),
				cell(task.estimateDays ?? ''),
				cell(rollup?.assignedDays || ''),
				cell((rollup?.memberIds ?? []).map((id) => membersById.get(id)?.name ?? '?').join(', ')),
				cell(rollup?.startDate ?? ''),
				cell(rollup?.endDate ?? '')
			]
		});
	}
	return grid;
}

// ---- batchUpdate assembly -----------------------------------------------------------

function colWidths(sheetId: number, widths: Array<{ from: number; to: number; px: number }>) {
	return widths.map(({ from, to, px }) => ({
		updateDimensionProperties: {
			range: { sheetId, dimension: 'COLUMNS', startIndex: from, endIndex: to },
			properties: { pixelSize: px },
			fields: 'pixelSize'
		}
	}));
}

/**
 * The full rewrite of one tab: retitle + resize the grid (trimming stale
 * cells), unmerge and clear everything, then write the new grid.
 */
function tabRequests(
	sheetId: number,
	title: string,
	grid: RowData[],
	frozen: { rows: number; cols: number }
): object[] {
	const rowCount = Math.max(grid.length, frozen.rows + 1);
	const columnCount = Math.max(...grid.map((r) => r.values.length), frozen.cols + 1);
	return [
		{
			updateSheetProperties: {
				properties: {
					sheetId,
					title,
					gridProperties: {
						rowCount,
						columnCount,
						frozenRowCount: frozen.rows,
						frozenColumnCount: frozen.cols
					}
				},
				fields: 'title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)'
			}
		},
		{ unmergeCells: { range: { sheetId } } },
		{ updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
		{
			updateCells: {
				start: { sheetId, rowIndex: 0, columnIndex: 0 },
				rows: grid,
				fields: 'userEnteredValue,userEnteredFormat'
			}
		}
	];
}

/** Every request needed to make the spreadsheet mirror the plan. */
export function buildSheetRequests(plan: Plan, schedule: Schedule, ids: SheetTabIds): object[] {
	const columns = boardColumns(plan);
	const rows = boardRows(plan);
	const board = boardGrid(plan, schedule, columns, rows);
	const legendCol = columns.length + 2;

	const requests: object[] = [
		...tabRequests(ids.board, 'Board', board, { rows: 2, cols: 1 }),
		...colWidths(ids.board, [
			{ from: 0, to: 1, px: 80 },
			{ from: 1, to: columns.length + 1, px: 190 },
			{ from: columns.length + 1, to: legendCol, px: 24 },
			{ from: legendCol, to: legendCol + 1, px: 340 }
		])
	];
	// Contiguous group spans merge in the group header row, like the Excel export.
	let spanStart = 0;
	for (let i = 1; i <= columns.length; i++) {
		if (i === columns.length || columns[i].groupId !== columns[spanStart].groupId) {
			if (i - spanStart > 1 && columns[spanStart].groupId) {
				requests.push({
					mergeCells: {
						mergeType: 'MERGE_ALL',
						range: {
							sheetId: ids.board,
							startRowIndex: 0,
							endRowIndex: 1,
							startColumnIndex: spanStart + 1,
							endColumnIndex: i + 1
						}
					}
				});
			}
			spanStart = i;
		}
	}

	requests.push(
		...tabRequests(ids.gantt, 'Gantt', ganttGrid(plan, schedule, rows), { rows: 1, cols: 1 }),
		...colWidths(ids.gantt, [
			{ from: 0, to: 1, px: 320 },
			{ from: 1, to: rows.length + 1, px: 24 }
		]),
		...tabRequests(ids.tasks, 'Tasks', tasksGrid(plan, schedule), { rows: 1, cols: 0 }),
		...colWidths(
			ids.tasks,
			[320, 260, 110, 90, 90, 240, 90, 90].map((px, i) => ({ from: i, to: i + 1, px }))
		)
	);
	return requests;
}
