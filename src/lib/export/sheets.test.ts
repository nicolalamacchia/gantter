import { describe, expect, it } from 'vitest';
import { computeSchedule } from '$lib/engine/schedule';
import type { Plan } from '$lib/model/types';
import { buildPeriodRequests, hexToColor } from './sheets';

/** 2026-01-05 is a Monday; the 6th is a holiday. */
function fixture(): Plan {
	return {
		id: 'p',
		name: 'Test',
		schemaVersion: 1,
		startDate: '2026-01-05',
		numWeeks: 1,
		workdays: [1, 2, 3, 4, 5],
		holidays: ['2026-01-06'],
		groups: [{ id: 'g1', name: 'FE' }],
		members: [
			{ id: 'm1', name: 'Nicola', groupId: 'g1' },
			{ id: 'm2', name: 'Ale', groupId: 'g1' }
		],
		tasks: [{ id: 'T', name: 'Task', color: '#2684ff', estimateDays: 3 }],
		assignments: [{ id: 'a1', taskId: 'T', memberId: 'm1', days: 3, order: 0 }],
		absences: []
	};
}

interface CellShape {
	userEnteredValue?: { stringValue?: string; numberValue?: number };
	userEnteredFormat?: {
		backgroundColor?: { red: number; green: number; blue: number };
		wrapStrategy?: string;
	};
}
interface RequestShape {
	updateSheetProperties?: {
		properties: {
			sheetId: number;
			title: string;
			gridProperties: { frozenRowCount: number; rowCount: number };
		};
	};
	updateCells?: {
		start?: { sheetId: number };
		range?: { sheetId: number };
		rows?: Array<{ values: CellShape[] }>;
	};
	mergeCells?: { range: { startColumnIndex: number; endColumnIndex: number } };
}

function build(plan: Plan = fixture()): RequestShape[] {
	return buildPeriodRequests(
		plan,
		computeSchedule(plan),
		{ board: 4, gantt: 5 },
		{ board: 'Q1 2026', gantt: 'Q1 2026 Gantt' }
	) as RequestShape[];
}

function dataRows(reqs: RequestShape[], sheetId: number): Array<{ values: CellShape[] }> {
	const req = reqs.find((r) => r.updateCells?.rows && r.updateCells.start?.sheetId === sheetId);
	return req!.updateCells!.rows!;
}

describe('Google Sheets export', () => {
	it('converts hex colors to API rgb floats', () => {
		expect(hexToColor('#ff0000')).toEqual({ red: 1, green: 0, blue: 0 });
		expect(hexToColor('#000000')).toEqual({ red: 0, green: 0, blue: 0 });
	});

	it('rewrites the period tabs under their period names: retitle/resize, clear, then write', () => {
		const reqs = build();
		for (const [sheetId, title, frozen] of [
			[4, 'Q1 2026', 2],
			[5, 'Q1 2026 Gantt', 1]
		] as const) {
			const props = reqs.find((r) => r.updateSheetProperties?.properties.sheetId === sheetId)!
				.updateSheetProperties!.properties;
			expect(props.title).toBe(title);
			expect(props.gridProperties.frozenRowCount).toBe(frozen);
			// The clear (range, no rows) must precede the data write (start + rows).
			const clearIdx = reqs.findIndex(
				(r) => r.updateCells?.range?.sheetId === sheetId && !r.updateCells.rows
			);
			const writeIdx = reqs.findIndex(
				(r) => r.updateCells?.start?.sheetId === sheetId && r.updateCells.rows
			);
			expect(clearIdx).toBeGreaterThanOrEqual(0);
			expect(writeIdx).toBeGreaterThan(clearIdx);
		}
	});

	it('mirrors the board: headers, task colors, holiday rows, legend', () => {
		const board = dataRows(build(), 4);
		expect(board[1].values[1].userEnteredValue?.stringValue).toBe('Nicola');
		// Mon Jan 5: m1 works on the task, painted in its color.
		expect(board[2].values[1].userEnteredValue?.stringValue).toBe('Task');
		expect(board[2].values[1].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#2684ff'));
		// Tue Jan 6 is a holiday — gray across members.
		expect(board[3].values[1].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#64748b'));
		// Legend column carries the task name in its color, the estimate beside it.
		expect(board[2].values[4].userEnteredValue?.stringValue).toBe('Task');
		expect(board[2].values[5].userEnteredValue?.numberValue).toBe(3);
		// Texts clip instead of overflowing into the next column.
		expect(board[2].values[1].userEnteredFormat?.wrapStrategy).toBe('CLIP');
	});

	it('board cells wear the topmost parent; the legend keeps the breakdown', () => {
		const plan = fixture();
		plan.tasks = [
			{ id: 'T', name: 'Epic', color: '#2684ff', estimateDays: 5 },
			{ id: 'C', name: 'Child', color: '#57d9a3', parentId: 'T', estimateDays: 2 }
		];
		plan.assignments = [{ id: 'a1', taskId: 'C', memberId: 'm1', days: 2, order: 0 }];
		const board = dataRows(build(plan), 4);
		// Mon Jan 5: work on the CHILD shows the epic's name and color on the board.
		expect(board[2].values[1].userEnteredValue?.stringValue).toBe('Epic');
		expect(board[2].values[1].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#2684ff'));
		// The legend breaks it down: the child sits indented, in its own color, with its estimate.
		expect(board[2].values[4].userEnteredValue?.stringValue).toBe('Epic');
		expect(board[3].values[4].userEnteredValue?.stringValue).toBe('    Child');
		expect(board[3].values[4].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#57d9a3'));
		expect(board[3].values[5].userEnteredValue?.numberValue).toBe(2);
	});

	it('merges contiguous group spans in the header row', () => {
		const merge = build().find((r) => r.mergeCells)!.mergeCells!;
		expect(merge.range.startColumnIndex).toBe(1);
		expect(merge.range.endColumnIndex).toBe(3); // both members sit in FE
	});

	it('paints the Gantt tab: task row colored on its scheduled days', () => {
		const gantt = dataRows(build(), 5);
		expect(gantt[0].values[0].userEnteredValue?.stringValue).toBe('Task');
		expect(gantt[1].values[0].userEnteredValue?.stringValue).toBe('Task');
		// Mon Jan 5 is a working day on the task; Tue Jan 6 is the holiday.
		expect(gantt[1].values[1].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#2684ff'));
		expect(gantt[1].values[2].userEnteredFormat?.backgroundColor).toEqual(hexToColor('#64748b'));
	});
});
