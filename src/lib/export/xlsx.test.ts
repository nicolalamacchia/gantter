import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { createDemoPlan } from '$lib/state/seed';
import { exportXlsx } from './xlsx';

describe('exportXlsx', () => {
	it('produces a board grid with member headers, colored task cells and a legend', async () => {
		const plan = createDemoPlan();
		const blob = await exportXlsx(plan);
		expect(blob.size).toBeGreaterThan(1000);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(await blob.arrayBuffer());

		const board = wb.getWorksheet('Board')!;
		expect(board).toBeDefined();
		// Member headers in row 2, ordered FE group first (Alice, Ben), then BE.
		expect(board.getRow(2).getCell(2).value).toBe('Alice');
		expect(board.getRow(2).getCell(3).value).toBe('Ben');
		expect(board.getRow(2).getCell(4).value).toBe('Carla');
		// Group header row.
		expect(board.getRow(1).getCell(2).value).toBe('Frontend');
		// First scheduled day for Alice: demo's first task, with its fill color
		// and a font color readable on it (saturated red → white text).
		const firstCell = board.getRow(3).getCell(2);
		expect(firstCell.value).toBe('Search Revamp');
		const fill = firstCell.fill as ExcelJS.FillPattern;
		expect(fill.fgColor?.argb).toBe('FFE6194B');
		expect(firstCell.font?.color?.argb).toBe('FFFFFFFF');
		// Legend column holds every task.
		const legendCol = 4 /* members */ + 3;
		expect(board.getRow(2).getCell(legendCol).value).toBe('Task');
		expect(board.getRow(3).getCell(legendCol).value).toBe('Search Revamp');

		// Gantt sheet: tasks down the side, colored day cells across.
		const gantt = wb.getWorksheet('Gantt')!;
		expect(gantt).toBeDefined();
		expect(gantt.getRow(2).getCell(1).value).toBe('Search Revamp');
		expect(gantt.rowCount).toBe(1 + plan.tasks.length);

		// Tasks WBS sheet: header + one row per task.
		const wbs = wb.getWorksheet('Tasks')!;
		expect(wbs.rowCount).toBe(1 + plan.tasks.length);
		expect(wbs.getRow(1).getCell(1).value).toBe('Task');
	});
});
