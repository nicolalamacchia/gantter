<script lang="ts">
	import { untrack } from 'svelte';
	import { boardColumns, boardRows, buildAbsenceDayMap, type BoardColumn } from '$lib/engine/board';
	import { formatDay, formatMonthDay } from '$lib/engine/calendar';
	import {
		carveChunk,
		mergeAdjacentChunks,
		moveShare,
		moveWholeTask,
		paintChunk,
		shiftAbsence,
		splitDrop
	} from '$lib/engine/moves';
	import { computeSchedule, type Schedule } from '$lib/engine/schedule';
	import { bestTextOn } from '$lib/model/colors';
	import type { ISODate, Plan } from '$lib/model/types';
	import { store } from '$lib/state/plan.svelte';
	import { maybeOfferRollover } from '$lib/state/rollover';
	import { clampToViewport } from './clampToViewport';
	import { ui } from '$lib/state/ui.svelte';

	type Cell =
		| { kind: 'holiday' }
		| { kind: 'weekend' }
		| { kind: 'absence'; absenceId: string; note?: string; runStart: boolean; isEnd: boolean }
		| {
				kind: 'task';
				assignmentId: string;
				taskId: string;
				color: string;
				runStart: boolean;
				isAssignmentEnd: boolean;
				continuation: boolean;
				continues: boolean;
				label: string;
				parentId?: string;
				parentColor?: string;
				groupId?: string;
				groupEmoji?: string;
				jiraKey?: string;
		  }
		| { kind: 'empty' };

	// macOS: ⌃-click is the system right-click, so combos there use ⌘ instead;
	// Windows/Linux use Ctrl. Both modifiers are accepted everywhere.
	const isMac =
		typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || '');
	const KEY = {
		shift: isMac ? '⇧' : 'Shift+',
		alt: isMac ? '⌥' : 'Alt+',
		mod: isMac ? '⌘' : 'Ctrl+',
		carve: isMac ? '⌥⌘' : 'Ctrl+Alt+'
	};

	let wrapEl = $state<HTMLDivElement>();

	/** Live drag preview: facts + schedule as they would be after the drop. */
	let preview = $state<{ key: string; plan: Plan; schedule: Schedule } | null>(null);

	const rows = $derived(boardRows(store.plan));

	const columns: BoardColumn[] = $derived(
		boardColumns(store.plan).filter((c) => ui.groupFilter === 'all' || c.groupId === ui.groupFilter)
	);

	const headerGroups = $derived.by(() => {
		const out: Array<{ id: string; name: string; span: number }> = [];
		for (const c of columns) {
			const id = c.groupId ?? '';
			const last = out[out.length - 1];
			if (last && last.id === id) last.span++;
			else out.push({ id, name: c.groupName ?? '—', span: 1 });
		}
		return out;
	});

	const viewSchedule = $derived(preview?.schedule ?? store.schedule);
	const viewAbsences = $derived(preview?.plan.absences ?? store.plan.absences);
	const viewAbsenceMap = $derived(
		preview ? buildAbsenceDayMap(preview.plan.absences) : store.absenceDayMap
	);

	/** Spotlight: the selected task (+ descendants) or all of a sub-team's tasks stay vivid. */
	const highlightSet = $derived.by(() => {
		const h = ui.highlight;
		if (!h) return null;
		const set = new Set<string>();
		const walk = (id: string) => {
			set.add(id);
			for (const c of store.childrenByParent.get(id) ?? []) walk(c.id);
		};
		if (h.kind === 'tasks') {
			for (const id of h.ids) walk(id);
		} else {
			for (const t of store.plan.tasks) if (t.groupId === h.id) walk(t.id);
		}
		return set;
	});

	const cells = $derived.by(() => {
		const byMember = new Map<string, Cell[]>();
		for (const col of columns) {
			const dayMap = viewSchedule.dayMap[col.memberId] ?? {};
			const absMap = viewAbsenceMap[col.memberId] ?? {};
			const list: Cell[] = [];
			const lastAbsenceRow = new Map<string, number>();
			const lastTaskRow = new Map<string, number>();
			for (let i = 0; i < rows.length; i++) {
				const { date, isHoliday, isWeekend } = rows[i];
				if (isHoliday) {
					list.push({ kind: 'holiday' });
					continue;
				}
				if (isWeekend) {
					list.push({ kind: 'weekend' });
					continue;
				}
				const absenceId = absMap[date];
				if (absenceId) {
					const prev = list[i - 1];
					list.push({
						kind: 'absence',
						absenceId,
						note: viewAbsences.find((a) => a.id === absenceId)?.note,
						runStart: !(prev?.kind === 'absence' && prev.absenceId === absenceId),
						isEnd: false
					});
					lastAbsenceRow.set(absenceId, i);
					continue;
				}
				const assignmentId = dayMap[date];
				if (!assignmentId) {
					list.push({ kind: 'empty' });
					continue;
				}
				const placement = viewSchedule.placements[assignmentId];
				const task = store.tasksById.get(placement.taskId);
				const parent = task?.parentId ? store.tasksById.get(task.parentId) : undefined;
				const group = task?.groupId ? store.groupsById.get(task.groupId) : undefined;
				const prev = list[i - 1];
				const runStart = !(prev?.kind === 'task' && prev.assignmentId === assignmentId);
				list.push({
					kind: 'task',
					assignmentId,
					taskId: placement.taskId,
					color: task?.color ?? '#cbd5e1',
					runStart,
					isAssignmentEnd: placement.days[placement.days.length - 1] === date,
					continuation: runStart && placement.days[0] !== date,
					continues: false,
					label: taskLabel(placement.taskId),
					parentId: parent?.id,
					parentColor: parent?.color,
					groupId: group?.id,
					groupEmoji: group?.emoji,
					jiraKey: task?.jiraKey
				});
				lastTaskRow.set(assignmentId, i);
			}
			for (const [absenceId, rowIdx] of lastAbsenceRow) {
				const cell = list[rowIdx];
				if (cell?.kind === 'absence' && cell.absenceId === absenceId) cell.isEnd = true;
			}
			// Mark blocks whose work runs past the rendered horizon.
			const boardEnd = rows[rows.length - 1]?.date ?? '';
			for (const [assignmentId, rowIdx] of lastTaskRow) {
				const placement = viewSchedule.placements[assignmentId];
				const lastDay = placement?.days[placement.days.length - 1];
				const cell = list[rowIdx];
				if (
					cell?.kind === 'task' &&
					((lastDay && lastDay > boardEnd) || (placement?.overflowDays ?? 0) > 0)
				) {
					cell.continues = true;
				}
			}
			byMember.set(col.memberId, list);
		}
		return byMember;
	});

	function taskLabel(taskId: string): string {
		const task = store.tasksById.get(taskId);
		if (!task) return '?';
		const parent = task.parentId ? store.tasksById.get(task.parentId) : undefined;
		return parent ? `${parent.name} · ${task.name}` : task.name;
	}

	// Columns have exact widths (the Cols slider), so shrinking actually shrinks.
	// "Fit" — and the first render — sizes them equally to fill the viewport.
	function fitColumns() {
		if (!wrapEl) return;
		const n = columns.length || 1;
		const available = wrapEl.clientWidth - 86 - 2;
		ui.colWidth = Math.max(48, Math.min(400, Math.floor(available / n)));
	}
	$effect(() => {
		void ui.fitColumnsRequest; // re-run on every Fit press (and once on mount)
		untrack(fitColumns);
	});

	// ---- pointer interactions -------------------------------------------------

	type DragTarget = { memberId: string; date: ISODate; clamped?: boolean };

	type DragState =
		| {
				type: 'move';
				assignmentId: string;
				taskId: string;
				shares: number;
				sourceMemberId: string;
				grabDate: ISODate;
				/** ⌥⌃ at pointer-down: carve from grabDate to the end and move that chunk. */
				chunk: boolean;
				label: string;
				color: string;
				started: boolean;
				alt: boolean;
				ctrl: boolean;
				startX: number;
				startY: number;
				x: number;
				y: number;
				target?: DragTarget;
		  }
		| {
				type: 'move-absence';
				absenceId: string;
				sourceMemberId: string;
				grabDate: ISODate;
				label: string;
				started: boolean;
				startX: number;
				startY: number;
				x: number;
				y: number;
				target?: DragTarget;
		  }
		| {
				type: 'resize';
				assignmentId: string;
				memberId: string;
				startRow: number;
				currentRow: number;
				origDays: number;
				x: number;
				y: number;
		  }
		| {
				type: 'resize-absence';
				absenceId: string;
				startDate: ISODate;
				currentDate: ISODate;
				x: number;
				y: number;
		  }
		| {
				type: 'pto';
				memberId: string;
				startDate: ISODate;
				endDate: ISODate;
				startedOnAbsence?: string;
				moved: boolean;
		  }
		| {
				type: 'paint-task';
				taskId: string;
				memberId: string;
				startDate: ISODate;
				endDate: ISODate;
		  };

	let drag = $state<DragState | null>(null);

	function cancelDrag() {
		drag = null;
		preview = null;
	}

	// ---- hover hints ------------------------------------------------------------

	/** After dwelling ~600ms on a block, show its full title and the available actions. */
	let hover = $state<{ x: number; y: number; label: string; lines: string[] } | null>(null);
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let hoverKey = '';

	function clearHover() {
		clearTimeout(hoverTimer);
		hover = null;
		hoverKey = '';
	}

	function trackHover(e: PointerEvent) {
		const el = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null;
		const key = el ? `${el.dataset.member}|${el.dataset.row}` : '';
		if (key === hoverKey) return;
		clearHover();
		hoverKey = key;
		if (!el || ui.ptoMode) return;
		const cell = cells.get(el.dataset.member!)?.[Number(el.dataset.row)];
		if (cell?.kind !== 'task' && cell?.kind !== 'absence') return;
		const x = e.clientX;
		const y = e.clientY;
		hoverTimer = setTimeout(() => {
			if (cell.kind === 'task') {
				const lines = [
					'drag — move within this lane',
					`${KEY.shift}drag — move to another person`,
					`${KEY.alt}drag — move all shares of the task`,
					`${KEY.mod}drag — drop into a block, splitting it`,
					`${KEY.carve}drag — carve from this day on and move the chunk`,
					'bottom edge — resize',
					'click — spotlight (⌘ adds to the selection)',
					'right-click — actions menu'
				];
				if (cell.jiraKey) lines.unshift(`🔗 linked to ${cell.jiraKey}`);
				lines.push(`id ${cell.taskId}`);
				const total =
					(store.assignmentById(cell.assignmentId)?.days ?? 0) + otherChunkDays(cell.assignmentId);
				hover = { x, y, label: `${cell.label} · ${total}d`, lines };
			} else {
				hover = {
					x,
					y,
					label: cell.note ?? 'PTO',
					lines: [
						'drag — move (rolls over weekends)',
						`${KEY.shift}drag — move to another person`,
						'bottom edge — resize',
						'click — rename / delete'
					]
				};
			}
		}, 600);
	}

	function cellFromEvent(e: PointerEvent): HTMLElement | null {
		return (
			(document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest('[data-cell]') as HTMLElement | null) ?? null
		);
	}

	function onpointerdown(e: PointerEvent) {
		if (e.button !== 0) return;
		clearHover();
		if ((e.target as HTMLElement).closest('[data-stopdrag]')) return; // parent bar / emoji clicks
		const el = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null;
		if (!el) return;
		const memberId = el.dataset.member!;
		const date = el.dataset.date!;
		const row = Number(el.dataset.row);
		const resizeEl = (e.target as HTMLElement).closest('[data-resize]') as HTMLElement | null;
		const cell = cells.get(memberId)?.[row];

		if (ui.paintTask) {
			drag = {
				type: 'paint-task',
				taskId: ui.paintTask.taskId,
				memberId,
				startDate: date,
				endDate: date
			};
		} else if (ui.ptoMode) {
			drag = {
				type: 'pto',
				memberId,
				startDate: date,
				endDate: date,
				startedOnAbsence: cell?.kind === 'absence' ? cell.absenceId : undefined,
				moved: false
			};
		} else if (cell?.kind === 'absence') {
			const absence = store.plan.absences.find((a) => a.id === cell.absenceId);
			if (!absence) return;
			if (resizeEl) {
				drag = {
					type: 'resize-absence',
					absenceId: absence.id,
					startDate: absence.startDate,
					currentDate: absence.endDate,
					x: e.clientX,
					y: e.clientY
				};
			} else {
				drag = {
					type: 'move-absence',
					absenceId: absence.id,
					sourceMemberId: absence.memberId,
					grabDate: date,
					label: absence.note ?? 'PTO',
					started: false,
					startX: e.clientX,
					startY: e.clientY,
					x: e.clientX,
					y: e.clientY
				};
			}
		} else if (cell?.kind === 'task') {
			const assignment = store.assignmentById(cell.assignmentId);
			if (!assignment) return;
			if (resizeEl) {
				drag = {
					type: 'resize',
					assignmentId: assignment.id,
					memberId,
					startRow: row,
					currentRow: row,
					origDays: assignment.days,
					x: e.clientX,
					y: e.clientY
				};
			} else {
				drag = {
					type: 'move',
					assignmentId: assignment.id,
					taskId: assignment.taskId,
					shares: store.plan.assignments.filter((a) => a.taskId === assignment.taskId).length,
					sourceMemberId: memberId,
					grabDate: date,
					chunk: e.altKey && (e.ctrlKey || e.metaKey),
					label: taskLabel(assignment.taskId),
					color: store.tasksById.get(assignment.taskId)?.color ?? '#ccc',
					started: false,
					alt: e.altKey,
					ctrl: e.ctrlKey || e.metaKey,
					startX: e.clientX,
					startY: e.clientY,
					x: e.clientX,
					y: e.clientY
				};
			}
		} else {
			if (ui.highlight) ui.highlight = null;
			return;
		}
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onpointermove(e: PointerEvent) {
		if (!drag) {
			trackHover(e);
			return;
		}
		if (drag.type === 'move' || drag.type === 'move-absence') {
			drag.x = e.clientX;
			drag.y = e.clientY;
			if (drag.type === 'move' && !drag.chunk) {
				drag.alt = e.altKey;
				drag.ctrl = e.ctrlKey || e.metaKey;
			}
			if (!drag.started && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5) {
				drag.started = true;
			}
			if (drag.started) {
				const el = cellFromEvent(e);
				if (!el) {
					drag.target = undefined;
				} else {
					// Crossing into another person's lane requires ⇧; otherwise the drag
					// is clamped to the block's own column (whole-task moves ignore the
					// column entirely).
					let memberId = el.dataset.member!;
					let clamped = false;
					const wholeTask = drag.type === 'move' && drag.alt && !drag.ctrl && drag.shares > 1;
					if (!wholeTask && !e.shiftKey && memberId !== drag.sourceMemberId) {
						memberId = drag.sourceMemberId;
						clamped = true;
					}
					drag.target = { memberId, date: el.dataset.date!, clamped };
				}
			}
		} else if (drag.type === 'resize') {
			drag.x = e.clientX;
			drag.y = e.clientY;
			const el = cellFromEvent(e);
			if (el) drag.currentRow = Number(el.dataset.row);
		} else if (drag.type === 'resize-absence') {
			drag.x = e.clientX;
			drag.y = e.clientY;
			const el = cellFromEvent(e);
			if (el) {
				const date = el.dataset.date!;
				drag.currentDate = date < drag.startDate ? drag.startDate : date;
			}
		} else if (drag.type === 'pto') {
			const el = cellFromEvent(e);
			if (el && el.dataset.member === drag.memberId) {
				drag.endDate = el.dataset.date!;
				drag.moved = drag.moved || drag.endDate !== drag.startDate;
			}
		} else {
			const el = cellFromEvent(e);
			if (el && el.dataset.member === drag.memberId) drag.endDate = el.dataset.date!;
		}
		buildPreview();
	}

	/** Recompute the would-be schedule for the current drag state (live preview). */
	function buildPreview() {
		const d = drag;
		if (!d) {
			preview = null;
			return;
		}
		const base = () => $state.snapshot(store.plan) as Plan;
		const ctx = () => ({ plan: store.plan, schedule: store.schedule });
		let key: string;
		let plan: Plan;

		if (d.type === 'move' && d.started && d.target) {
			const t = d.target;
			key = `m|${d.assignmentId}|${t.memberId}|${t.date}|${d.alt}|${d.ctrl}|${d.chunk}`;
			if (preview?.key === key) return;
			const assignments = d.chunk
				? carveChunk(ctx(), d.assignmentId, d.grabDate, t.memberId, t.date, 'preview-chunk')
				: d.ctrl
					? splitDrop(ctx(), d.assignmentId, t.memberId, t.date, 'preview-split-tail')
					: d.alt && d.shares > 1
						? moveWholeTask(ctx(), d.taskId, t.date)
						: moveShare(ctx(), d.assignmentId, t.memberId, t.date);
			plan = { ...base(), assignments: mergeAdjacentChunks(assignments) };
		} else if (d.type === 'move-absence' && d.started && d.target) {
			const t = d.target;
			key = `a|${d.absenceId}|${t.memberId}|${t.date}`;
			if (preview?.key === key) return;
			plan = {
				...base(),
				absences: shiftAbsence(store.plan, d.absenceId, t.memberId, t.date, d.grabDate)
			};
		} else if (d.type === 'resize') {
			const days = resizePreviewDays(d);
			key = `r|${d.assignmentId}|${days}`;
			if (preview?.key === key) return;
			const b = base();
			plan = {
				...b,
				assignments: b.assignments.map((a) => (a.id === d.assignmentId ? { ...a, days } : a))
			};
		} else if (d.type === 'resize-absence') {
			key = `ra|${d.absenceId}|${d.currentDate}`;
			if (preview?.key === key) return;
			const b = base();
			plan = {
				...b,
				absences: b.absences.map((a) =>
					a.id === d.absenceId
						? { ...a, endDate: d.currentDate < a.startDate ? a.startDate : d.currentDate }
						: a
				)
			};
		} else if (d.type === 'paint-task') {
			const [lo, hi] =
				d.startDate <= d.endDate ? [d.startDate, d.endDate] : [d.endDate, d.startDate];
			key = `paint|${d.taskId}|${d.memberId}|${lo}|${hi}`;
			if (preview?.key === key) return;
			plan = {
				...base(),
				assignments: mergeAdjacentChunks(
					paintChunk(ctx(), d.taskId, d.memberId, lo, hi, 'preview-paint')
				)
			};
		} else if (d.type === 'pto' && d.moved) {
			const [lo, hi] =
				d.startDate <= d.endDate ? [d.startDate, d.endDate] : [d.endDate, d.startDate];
			key = `p|${d.memberId}|${lo}|${hi}`;
			if (preview?.key === key) return;
			const b = base();
			plan = {
				...b,
				absences: [
					...b.absences,
					{ id: 'preview-pto', memberId: d.memberId, startDate: lo, endDate: hi, note: 'PTO' }
				]
			};
		} else {
			preview = null;
			return;
		}
		preview = { key, plan, schedule: computeSchedule(plan) };
	}

	function onpointerup(e: PointerEvent) {
		if (!drag) return;
		const d = drag;
		cancelDrag();
		if (d.type === 'move') {
			if (!d.started) {
				// Click = spotlight the task (⌘/Ctrl adds to the selection);
				// editing lives in the right-click menu now.
				ui.selectTask(d.taskId, { toggle: e.metaKey || e.ctrlKey });
			} else if (d.target) {
				const prevEnd = store.schedule.rollups[d.taskId]?.endDate ?? null;
				if (d.chunk) {
					store.carveShareAt(d.assignmentId, d.grabDate, d.target.memberId, d.target.date);
				} else if (d.ctrl) {
					store.splitShareAt(d.assignmentId, d.target.memberId, d.target.date);
				} else if (d.alt && d.shares > 1) {
					// ⌥: all members' shares of the task move together.
					store.moveTaskTo(d.taskId, d.target.date);
				} else {
					store.moveShareTo(d.assignmentId, d.target.memberId, d.target.date);
				}
				maybeOfferRollover(d.taskId, prevEnd);
			}
		} else if (d.type === 'move-absence') {
			if (!d.started) {
				ui.popover = { kind: 'absence', id: d.absenceId, x: e.clientX, y: e.clientY };
			} else if (d.target) {
				store.moveAbsence(d.absenceId, d.target.memberId, d.target.date, d.grabDate);
			}
		} else if (d.type === 'resize') {
			const taskId = store.assignmentById(d.assignmentId)?.taskId;
			const prevEnd = taskId ? (store.schedule.rollups[taskId]?.endDate ?? null) : null;
			store.setAssignmentDays(d.assignmentId, resizePreviewDays(d));
			if (taskId) maybeOfferRollover(taskId, prevEnd);
		} else if (d.type === 'resize-absence') {
			store.resizeAbsence(d.absenceId, d.currentDate);
		} else if (d.type === 'paint-task') {
			const [lo, hi] =
				d.startDate <= d.endDate ? [d.startDate, d.endDate] : [d.endDate, d.startDate];
			store.paintTaskChunk(d.taskId, d.memberId, lo, hi);
		} else if (d.type === 'pto') {
			if (!d.moved && d.startedOnAbsence) {
				store.removeAbsence(d.startedOnAbsence);
			} else {
				const [lo, hi] =
					d.startDate <= d.endDate ? [d.startDate, d.endDate] : [d.endDate, d.startDate];
				store.addAbsence(d.memberId, lo, hi);
			}
		}
	}

	/** Resize delta in working rows, computed from committed state so the preview can't feed back. */
	function resizePreviewDays(d: Extract<DragState, { type: 'resize' }>): number {
		const forward = d.currentRow >= d.startRow;
		const [lo, hi] = forward ? [d.startRow + 1, d.currentRow] : [d.currentRow + 1, d.startRow];
		let delta = 0;
		for (let i = lo; i <= hi; i++) {
			const row = rows[i];
			if (!row || row.isHoliday || row.isWeekend) continue;
			if (store.absenceDayMap[d.memberId]?.[row.date]) continue;
			delta++;
		}
		return Math.max(1, d.origDays + (forward ? delta : -delta));
	}

	/** Days of the other chunks of the same task on the same member. */
	function otherChunkDays(assignmentId: string): number {
		const assignment = store.assignmentById(assignmentId);
		if (!assignment) return 0;
		return store.plan.assignments
			.filter(
				(a) =>
					a.taskId === assignment.taskId &&
					a.memberId === assignment.memberId &&
					a.id !== assignment.id
			)
			.reduce((sum, a) => sum + a.days, 0);
	}

	function moveHint(d: Extract<DragState, { type: 'move' }>): string {
		if (!d.target) return '';
		const suffix = d.target.clamped ? ` (${KEY.shift} to change person)` : '';
		if (d.chunk) return `move chunk${suffix}`;
		if (d.ctrl) return `split block${suffix}`;
		if (d.alt && d.shares > 1) return 'move all shares';
		const reassigned = d.target.memberId !== d.sourceMemberId;
		return reassigned
			? `→ ${store.membersById.get(d.target.memberId)?.name ?? '?'}`
			: `reorder${suffix}`;
	}

	function isPtoPreview(memberId: string, date: ISODate): boolean {
		if (drag?.type !== 'pto' && drag?.type !== 'paint-task') return false;
		if (drag.memberId !== memberId) return false;
		const [lo, hi] =
			drag.startDate <= drag.endDate
				? [drag.startDate, drag.endDate]
				: [drag.endDate, drag.startDate];
		return date >= lo && date <= hi;
	}

	function isDropTarget(memberId: string, date: ISODate): boolean {
		// ⌥-drag from the task list shares the same highlight as internal drags.
		if (ui.backlogDropCell) {
			return ui.backlogDropCell.memberId === memberId && ui.backlogDropCell.date === date;
		}
		return (
			(drag?.type === 'move' || drag?.type === 'move-absence') &&
			drag.started &&
			drag.target?.memberId === memberId &&
			drag.target?.date === date
		);
	}

	function isDraggingSelf(cell: Cell): boolean {
		if (!drag) return false;
		if (drag.type === 'move' && drag.started && cell.kind === 'task') {
			if (drag.chunk) return cell.assignmentId === 'preview-chunk';
			return drag.alt && !drag.ctrl && drag.shares > 1
				? cell.taskId === drag.taskId
				: cell.assignmentId === drag.assignmentId;
		}
		if (drag.type === 'move-absence' && drag.started && cell.kind === 'absence') {
			return cell.absenceId === drag.absenceId;
		}
		return false;
	}

	function onGridContextMenu(e: MouseEvent) {
		e.preventDefault();
		// macOS synthesizes contextmenu from ⌃-click, which is our split-drag.
		if (e.ctrlKey) return;
		if (drag && (drag.type !== 'move' || drag.started)) return;
		cancelDrag();
		const el = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null;
		if (!el) return;
		const cell = cells.get(el.dataset.member ?? '')?.[Number(el.dataset.row)];
		if (cell?.kind !== 'task') return;
		if (!ui.isHighlighted('task', cell.taskId)) ui.selectTask(cell.taskId);
		ui.contextMenu = { x: e.clientX, y: e.clientY, assignmentId: cell.assignmentId };
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (drag) cancelDrag();
		else if (ui.paintTask) ui.paintTask = null;
		else if (ui.highlight) ui.highlight = null;
	}
</script>

<svelte:window {onkeydown} />

<div
	class="grid-wrap"
	bind:this={wrapEl}
	style="--row-h: {ui.zoom}px; --col-w: {ui.colWidth}px; --ncols: {columns.length}"
>
	{#if columns.length === 0}
		<div class="placeholder">
			No team members{ui.groupFilter !== 'all' ? ' in this group' : ''} yet — open
			<strong>Team</strong> in the toolbar to add them.
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="grid"
			class:pto-mode={ui.ptoMode || !!ui.paintTask}
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={cancelDrag}
			onpointerleave={clearHover}
			oncontextmenu={onGridContextMenu}
		>
			<div class="corner row1"></div>
			{#each headerGroups as g (g.id)}
				<div class="group-h row1" style="grid-column: span {g.span}">{g.name}</div>
			{/each}

			<div class="corner row2">Week</div>
			{#each columns as c (c.memberId)}
				<div class="member-h row2" title={c.name}>{c.name}</div>
			{/each}

			{#each rows as row, i (row.date)}
				<button
					class="date-cell"
					class:week-start={row.isWeekStart}
					class:holiday={row.isHoliday}
					class:weekend={row.isWeekend}
					disabled={row.isWeekend}
					onclick={() => store.toggleHoliday(row.date)}
					title={row.isWeekend
						? formatMonthDay(row.date)
						: `${formatMonthDay(row.date)} — click to toggle company holiday`}
				>
					{#if row.isWeekStart}
						<strong>{formatMonthDay(row.date)}</strong>
					{:else}
						<span>{formatDay(row.date)}</span>
					{/if}
				</button>
				{#each columns as c (c.memberId)}
					{@const cell = cells.get(c.memberId)?.[i] ?? { kind: 'empty' }}
					<div
						class="cell {cell.kind}"
						class:week-start={row.isWeekStart}
						class:run-start={cell.kind === 'task' && cell.runStart}
						class:pto-preview={isPtoPreview(c.memberId, row.date)}
						class:drop-target={isDropTarget(c.memberId, row.date)}
						class:dragging-self={isDraggingSelf(cell)}
						class:faded={highlightSet !== null &&
							cell.kind === 'task' &&
							!highlightSet.has(cell.taskId)}
						style:background={cell.kind === 'task' ? cell.color : undefined}
						style:color={cell.kind === 'task' ? bestTextOn(cell.color) : undefined}
						data-cell
						data-member={c.memberId}
						data-date={row.date}
						data-row={i}
					>
						{#if cell.kind === 'task' && cell.parentId}
							{@const pid = cell.parentId}
							<button
								class="parent-bar"
								data-stopdrag
								style:background={cell.parentColor}
								title="Part of {store.tasksById.get(pid)?.name ??
									'?'} — click to spotlight all parts"
								aria-label="Spotlight parent task"
								onclick={() => ui.toggleHighlight('task', pid)}
							></button>
						{/if}
						{#if cell.kind === 'task' && cell.runStart}
							<span
								class="label"
								class:indent={!!cell.parentId}
								class:has-emoji={!!cell.groupEmoji}
							>
								{#if cell.continuation}<span class="cont">⋯</span>{/if}
								{#if cell.jiraKey}<span class="jmark" aria-label="Linked to Jira">🔗</span>{/if}
								{cell.label}
							</span>
						{/if}
						{#if cell.kind === 'task' && cell.runStart && cell.groupEmoji}
							{@const gid = cell.groupId}
							<button
								class="group-emoji"
								data-stopdrag
								title="{store.groupsById.get(gid ?? '')?.name ??
									''} — click to spotlight the team's tasks"
								aria-label="Spotlight team tasks"
								onclick={() => gid && ui.toggleHighlight('group', gid)}
							>
								{cell.groupEmoji}
							</button>
						{/if}
						{#if cell.kind === 'absence' && cell.runStart}
							<span class="abs-label">{cell.note ?? 'PTO'}</span>
						{/if}
						{#if cell.kind === 'task' && cell.isAssignmentEnd && !ui.ptoMode}
							<div class="resize" data-resize title="Drag to resize"></div>
						{/if}
						{#if cell.kind === 'task' && cell.continues}
							<span class="continues-mark" title="Continues in the next period">⤵</span>
						{/if}
						{#if cell.kind === 'absence' && cell.isEnd && !ui.ptoMode}
							<div class="resize" data-resize title="Drag to resize"></div>
						{/if}
					</div>
				{/each}
			{/each}
		</div>
	{/if}

	{#if drag?.type === 'move' && drag.started}
		<div class="ghost" style="left: {drag.x + 14}px; top: {drag.y + 10}px">
			<span class="swatch" style:background={drag.color}></span>
			{drag.label}
			{#if drag.target}
				<span class="hint">{moveHint(drag)}</span>
			{/if}
		</div>
	{/if}
	{#if drag?.type === 'move-absence' && drag.started}
		<div class="ghost" style="left: {drag.x + 14}px; top: {drag.y + 10}px">
			🏖 {drag.label}
			{#if drag.target}
				<span class="hint">{formatMonthDay(drag.target.date)}</span>
			{/if}
		</div>
	{/if}
	{#if drag?.type === 'resize'}
		<div class="ghost" style="left: {drag.x + 14}px; top: {drag.y + 10}px">
			{resizePreviewDays(drag) + otherChunkDays(drag.assignmentId)} days
		</div>
	{/if}
	{#if drag?.type === 'resize-absence'}
		<div class="ghost" style="left: {drag.x + 14}px; top: {drag.y + 10}px">
			until {formatMonthDay(drag.currentDate)}
		</div>
	{/if}
	{#if ui.paintTask}
		{@const paintName = store.tasksById.get(ui.paintTask.taskId)?.name ?? '?'}
		<div class="paint-banner">
			🖌 Painting <strong>{paintName}</strong> — drag on a member's column to add days
			<button onclick={() => (ui.paintTask = null)}>Done (Esc)</button>
		</div>
	{/if}
	{#if hover && !drag}
		{#key hover}
			<div
				class="hovercard"
				use:clampToViewport
				style="left: {hover.x + 14}px; top: {hover.y + 12}px"
			>
				<div class="hover-title">{hover.label}</div>
				{#each hover.lines as line (line)}
					<div class="hover-line">{line}</div>
				{/each}
			</div>
		{/key}
	{/if}
</div>

<style>
	.grid-wrap {
		flex: 1;
		overflow: auto;
		position: relative;
		background: var(--panel);
	}
	.placeholder {
		padding: 48px;
		color: var(--text-muted);
		font-size: 14px;
	}
	.grid {
		display: grid;
		grid-template-columns: 86px repeat(var(--ncols), var(--col-w));
		min-width: max-content;
		user-select: none;
		touch-action: none;
	}
	.grid.pto-mode {
		cursor: crosshair;
	}

	.row1,
	.row2 {
		position: sticky;
		z-index: 4;
		background: var(--bg-muted);
		font-size: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-bottom: 1px solid var(--border);
		border-right: 1px solid var(--border-soft);
		overflow: hidden;
	}
	.row1 {
		top: 0;
		height: 26px;
		font-weight: 700;
		color: var(--text-mid);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 10.5px;
	}
	.row2 {
		top: 26px;
		height: 28px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.corner {
		left: 0;
		z-index: 6;
	}

	.date-cell {
		position: sticky;
		left: 0;
		z-index: 3;
		background: var(--bg-muted);
		border: none;
		border-right: 1px solid var(--border);
		border-bottom: 1px solid var(--border-soft);
		height: var(--row-h);
		font-size: 10px;
		color: var(--text-faint);
		text-align: right;
		padding: 0 6px;
		cursor: pointer;
		font-family: inherit;
	}
	.date-cell strong {
		color: var(--text-mid);
		font-size: 11px;
	}
	.date-cell:hover {
		background: var(--hover);
	}
	.date-cell.holiday {
		background: var(--holiday);
		color: var(--holiday-text);
	}
	.date-cell.holiday strong {
		color: var(--holiday-text);
	}
	.date-cell.weekend {
		background: var(--weekend);
		cursor: default;
	}
	.date-cell.weekend:hover {
		background: var(--weekend);
	}

	.cell {
		height: var(--row-h);
		border-right: 1px solid var(--border-soft);
		border-bottom: 1px solid var(--border-faint);
		position: relative;
		overflow: visible;
		font-size: 11px;
		transition: opacity 0.15s;
	}
	.week-start {
		border-top: 2px solid var(--border-strong);
	}
	.cell.holiday {
		background: var(--holiday);
	}
	.cell.weekend {
		background: var(--weekend);
	}
	.cell.absence {
		background: repeating-linear-gradient(
			-45deg,
			var(--absence-a),
			var(--absence-a) 6px,
			var(--absence-b) 6px,
			var(--absence-b) 12px
		);
		cursor: grab;
	}
	.abs-label {
		color: var(--absence-text);
		font-size: 9.5px;
		font-weight: 600;
		padding: 0 4px;
		line-height: var(--row-h);
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		pointer-events: none;
	}
	.cell.task {
		cursor: grab;
	}
	.cell.task.run-start {
		border-top: 1px solid rgba(0, 0, 0, 0.18);
	}
	.cell.dragging-self {
		opacity: 0.45;
	}
	.cell.faded {
		opacity: 0.22;
	}
	.label {
		display: block;
		padding: 1px 5px 0;
		font-weight: 600;
		/* The cell sets a black-or-white color computed from its background. */
		color: inherit;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: calc(var(--row-h) - 2px);
		pointer-events: none;
	}
	.label.indent {
		padding-left: 10px;
	}
	.label.has-emoji {
		padding-right: 22px;
	}
	.group-emoji {
		position: absolute;
		right: 0;
		top: 0;
		border: none;
		background: none;
		padding: 0 4px;
		line-height: var(--row-h);
		font-size: 12px;
		cursor: pointer;
		z-index: 2;
	}
	.group-emoji:hover {
		transform: scale(1.25);
	}
	.cont {
		opacity: 0.6;
	}
	.jmark {
		font-size: 8.5px;
		margin-right: 2px;
		opacity: 0.85;
	}
	.continues-mark {
		position: absolute;
		right: 3px;
		bottom: 0;
		font-size: 10px;
		line-height: 1;
		color: inherit;
		opacity: 0.8;
		pointer-events: none;
	}
	.cell.drop-target {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		z-index: 2;
	}
	.cell.pto-preview {
		outline: 2px dashed var(--text-muted);
		outline-offset: -2px;
	}
	.parent-bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 5px;
		border: none;
		border-right: 1px solid rgba(0, 0, 0, 0.3);
		padding: 0;
		cursor: pointer;
		z-index: 2;
	}
	.parent-bar:hover {
		width: 8px;
	}
	.resize {
		position: absolute;
		left: 0;
		right: 0;
		bottom: -2px;
		height: 6px;
		cursor: ns-resize;
		z-index: 2;
	}
	.resize:hover {
		background: var(--accent);
		opacity: 0.5;
	}

	.ghost {
		position: fixed;
		z-index: 50;
		pointer-events: none;
		background: var(--tooltip-bg);
		color: var(--tooltip-text);
		font-size: 11.5px;
		padding: 5px 9px;
		border-radius: 6px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 320px;
		white-space: nowrap;
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: none;
	}
	.hint {
		color: var(--tooltip-hint);
		font-weight: 600;
	}

	.paint-banner {
		position: fixed;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 45;
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--tooltip-bg);
		color: var(--tooltip-text);
		font-size: 12px;
		padding: 8px 12px;
		border-radius: 9px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
		white-space: nowrap;
	}
	.paint-banner button {
		font: inherit;
		font-size: 11.5px;
		padding: 3px 9px;
		border-radius: 6px;
		border: 1px solid var(--tooltip-hint);
		background: none;
		color: var(--tooltip-hint);
		cursor: pointer;
	}

	.hovercard {
		position: fixed;
		z-index: 49;
		pointer-events: none;
		background: var(--tooltip-bg);
		color: var(--tooltip-text);
		font-size: 11px;
		padding: 7px 10px;
		border-radius: 7px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
		max-width: 340px;
	}
	.hover-title {
		font-weight: 700;
		font-size: 11.5px;
		margin-bottom: 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hover-line {
		color: var(--tooltip-hint);
		line-height: 1.5;
		white-space: nowrap;
	}
</style>
