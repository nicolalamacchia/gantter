<script lang="ts">
	import { boardRows } from '$lib/engine/board';
	import { formatMonthDay } from '$lib/engine/calendar';
	import type { ISODate, Task } from '$lib/model/types';
	import { store } from '$lib/state/plan.svelte';
	import { ui } from '$lib/state/ui.svelte';

	const dateCols = $derived(boardRows(store.plan));

	interface GanttRow {
		task: Task;
		depth: number;
		days: Set<ISODate>;
		start: ISODate | null;
		end: ISODate | null;
		members: string;
		hasChildren: boolean;
		/** Displayed order of this row's sibling group (ids), for up/down nudges. */
		siblings: string[];
	}

	/**
	 * Siblings are ordered by start date (unscheduled last); once the user
	 * nudges a group with ▲▼ its explicit ganttRank order wins instead.
	 */
	function sortSiblings(tasks: Task[]): Task[] {
		const ranked = tasks.some((t) => t.ganttRank !== undefined);
		return [...tasks].sort((a, b) => {
			if (ranked) {
				return (a.ganttRank ?? Number.MAX_SAFE_INTEGER) - (b.ganttRank ?? Number.MAX_SAFE_INTEGER);
			}
			const startA = store.schedule.rollups[a.id]?.startDate ?? '9999-12-31';
			const startB = store.schedule.rollups[b.id]?.startDate ?? '9999-12-31';
			return startA < startB ? -1 : startA > startB ? 1 : 0;
		});
	}

	const ganttRows = $derived.by(() => {
		const out: GanttRow[] = [];
		const subtreeDays = (taskId: string, days: Set<ISODate>) => {
			for (const a of store.plan.assignments) {
				if (a.taskId !== taskId) continue;
				for (const d of store.schedule.placements[a.id]?.days ?? []) days.add(d);
			}
			for (const c of store.childrenByParent.get(taskId) ?? []) subtreeDays(c.id, days);
		};
		const add = (task: Task, depth: number, siblings: string[]) => {
			const days = new Set<ISODate>();
			subtreeDays(task.id, days);
			const rollup = store.schedule.rollups[task.id];
			const children = sortSiblings(store.childrenByParent.get(task.id) ?? []);
			out.push({
				task,
				depth,
				days,
				start: rollup?.startDate ?? null,
				end: rollup?.endDate ?? null,
				members: (rollup?.memberIds ?? [])
					.map((id) => store.membersById.get(id)?.name ?? '?')
					.join(', '),
				hasChildren: children.length > 0,
				siblings
			});
			if (ui.ganttCollapsed[task.id]) return; // collapsed: the parent row shows the whole subtree
			const childIds = children.map((c) => c.id);
			for (const c of children) add(c, depth + 1, childIds);
		};
		const roots = sortSiblings(store.rootTasks);
		const rootIds = roots.map((t) => t.id);
		for (const t of roots) add(t, 0, rootIds);
		return out;
	});

	function nudge(gr: GanttRow, direction: -1 | 1) {
		const index = gr.siblings.indexOf(gr.task.id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= gr.siblings.length) return;
		const reordered = [...gr.siblings];
		[reordered[index], reordered[target]] = [reordered[target], reordered[index]];
		store.setGanttOrder(reordered);
	}

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

	function rowTitle(gr: GanttRow): string {
		const span =
			gr.start && gr.end ? ` · ${formatMonthDay(gr.start)} → ${formatMonthDay(gr.end)}` : '';
		return `${store.taskPath(gr.task.id)}${span}${gr.members ? ` · ${gr.members}` : ''} · id ${gr.task.id}`;
	}

	function toggleCollapse(taskId: string) {
		ui.ganttCollapsed[taskId] = !ui.ganttCollapsed[taskId];
	}

	function collapseAll() {
		const collapsed: Record<string, boolean> = {};
		for (const id of store.childrenByParent.keys()) collapsed[id] = true;
		ui.ganttCollapsed = collapsed;
	}

	function expandAll() {
		ui.ganttCollapsed = {};
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && ui.highlight) ui.highlight = null;
	}
</script>

<svelte:window {onkeydown} />

<div class="gantt-wrap">
	<div class="gantt" style="--day-w: {ui.zoom}px; --ndays: {dateCols.length}">
		<div class="corner">
			<span>Task</span>
			<span class="corner-actions">
				<button onclick={expandAll} title="Expand all">⊞</button>
				<button onclick={collapseAll} title="Collapse all">⊟</button>
			</span>
		</div>
		{#each dateCols as col (col.date)}
			<div
				class="head"
				class:week-start={col.isWeekStart}
				class:weekend={col.isWeekend}
				class:holiday={col.isHoliday}
			>
				{#if col.isWeekStart}<span class="week-label">{formatMonthDay(col.date)}</span>{/if}
			</div>
		{/each}

		{#each ganttRows as gr (gr.task.id)}
			<div
				class="task-cell"
				class:child={gr.depth > 0}
				class:spotlit={ui.isHighlighted('task', gr.task.id)}
				style="padding-left: {4 + gr.depth * 16}px"
			>
				{#if gr.hasChildren}
					<button
						class="chev"
						onclick={() => toggleCollapse(gr.task.id)}
						title={ui.ganttCollapsed[gr.task.id] ? 'Expand workstreams' : 'Collapse workstreams'}
					>
						{ui.ganttCollapsed[gr.task.id] ? '▸' : '▾'}
					</button>
				{:else}
					<span class="chev-spacer"></span>
				{/if}
				<button
					class="trow"
					onclick={(e) =>
						ui.selectTask(gr.task.id, {
							toggle: e.metaKey || e.ctrlKey,
							rangeOrder: e.shiftKey ? ganttRows.map((r) => r.task.id) : null
						})}
					oncontextmenu={(e) => {
						e.preventDefault();
						if (!ui.isHighlighted('task', gr.task.id)) ui.selectTask(gr.task.id);
						ui.contextMenu = { x: e.clientX, y: e.clientY };
					}}
					title="{rowTitle(gr)} — click to spotlight (⌘ adds, ⇧ ranges); right-click to move"
				>
					<span class="swatch" style:background={gr.task.color}></span>
					<span class="tname">{gr.task.name}</span>
					{#if gr.task.jiraKey}<span class="jkey">{gr.task.jiraKey}</span>{/if}
					{#if gr.members}<span class="tmembers">{gr.members}</span>{/if}
				</button>
				<span class="nudges">
					<button
						class="nudge"
						disabled={gr.siblings.indexOf(gr.task.id) === 0}
						onclick={() => nudge(gr, -1)}
						title="Move up"
					>
						▲
					</button>
					<button
						class="nudge"
						disabled={gr.siblings.indexOf(gr.task.id) === gr.siblings.length - 1}
						onclick={() => nudge(gr, 1)}
						title="Move down"
					>
						▼
					</button>
				</span>
			</div>
			{#each dateCols as col (col.date)}
				{@const active = gr.days.has(col.date)}
				{@const inSpan =
					!active &&
					gr.start !== null &&
					col.date >= gr.start &&
					col.date <= gr.end! &&
					!col.isWeekend &&
					!col.isHoliday}
				<div
					class="gcell"
					class:week-start={col.isWeekStart}
					class:weekend={col.isWeekend}
					class:holiday={col.isHoliday}
					class:faded={highlightSet !== null && !highlightSet.has(gr.task.id)}
					style:background={active ? gr.task.color : inSpan ? `${gr.task.color}40` : undefined}
					title="{gr.task.name} · {formatMonthDay(col.date)}"
				></div>
			{/each}
		{:else}
			<div class="empty">No tasks yet.</div>
		{/each}
	</div>
</div>

<style>
	.gantt-wrap {
		flex: 1;
		overflow: auto;
		background: var(--panel);
	}
	.gantt {
		display: grid;
		grid-template-columns: 260px repeat(var(--ndays), var(--day-w));
		min-width: max-content;
		user-select: none;
	}
	.corner,
	.head {
		position: sticky;
		top: 0;
		z-index: 3;
		height: 30px;
		background: var(--bg-muted);
		border-bottom: 1px solid var(--border);
		border-right: 1px solid var(--border-faint);
		font-size: 10.5px;
		font-weight: 700;
		color: var(--text-mid);
		overflow: visible;
		white-space: nowrap;
	}
	.corner {
		left: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 8px 0 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border-right: 1px solid var(--border);
	}
	.corner-actions {
		display: flex;
		gap: 2px;
	}
	.corner-actions button {
		border: none;
		background: none;
		font-size: 13px;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 5px;
	}
	.corner-actions button:hover {
		background: var(--hover);
		color: var(--text);
	}
	.week-label {
		position: relative;
		z-index: 1;
		line-height: 30px;
		padding-left: 4px;
	}
	.head.week-start {
		z-index: 4;
	}
	.head.weekend {
		background: var(--weekend);
	}
	.head.holiday {
		background: var(--holiday);
	}
	.week-start {
		border-left: 2px solid var(--border-strong);
	}

	.task-cell {
		position: sticky;
		left: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 2px;
		height: 30px;
		background: var(--bg-muted);
		border-bottom: 1px solid var(--border-soft);
		border-right: 1px solid var(--border);
		font-size: 12px;
		color: var(--text);
		min-width: 0;
	}
	.task-cell:hover {
		background: var(--hover);
	}
	.chev {
		flex: none;
		width: 18px;
		border: none;
		background: none;
		font-size: 10px;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		line-height: 30px;
	}
	.chev:hover {
		color: var(--text);
	}
	.chev-spacer {
		flex: none;
		width: 18px;
	}
	.trow {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 7px;
		border: none;
		background: none;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		cursor: pointer;
		text-align: left;
		padding: 0;
		height: 100%;
	}
	.task-cell.spotlit {
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.task-cell.child .tname {
		font-weight: 400;
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: none;
		border: 1px solid rgba(0, 0, 0, 0.1);
	}
	.tname {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.jkey {
		flex: none;
		font-size: 9px;
		font-weight: 700;
		color: var(--accent);
		background: var(--accent-soft);
		border-radius: 4px;
		padding: 1px 4px;
	}
	.nudges {
		display: none;
		flex: none;
		gap: 0;
	}
	.task-cell:hover .nudges {
		display: inline-flex;
	}
	.nudge {
		border: none;
		background: none;
		font-size: 8px;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px 3px;
		border-radius: 4px;
	}
	.nudge:hover:not(:disabled) {
		background: var(--hover);
		color: var(--text);
	}
	.nudge:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.tmembers {
		font-size: 10px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: none;
		max-width: 90px;
	}

	.gcell {
		height: 30px;
		border-bottom: 1px solid var(--border-faint);
		border-right: 1px solid var(--border-faint);
		transition: opacity 0.15s;
	}
	.gcell.weekend {
		background: var(--weekend);
	}
	.gcell.holiday {
		background: var(--holiday);
	}
	.gcell.faded {
		opacity: 0.18;
	}
	.empty {
		grid-column: 1 / -1;
		padding: 32px;
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
