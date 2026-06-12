<script lang="ts">
	import { formatMonthDay, periodEndOf } from '$lib/engine/calendar';
	import { jiraIssueUrl } from '$lib/integrations/jira';
	import type { Task } from '$lib/model/types';
	import { jiraSync, runJiraPush, runJiraSync } from '$lib/state/jiraSync.svelte';
	import { store } from '$lib/state/plan.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';

	let asideEl = $state<HTMLElement>();

	function startResize(e: PointerEvent) {
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const left = asideEl?.getBoundingClientRect().left ?? 0;
		const onMove = (ev: PointerEvent) => {
			ui.sidebarWidth = Math.max(180, Math.min(520, Math.round(ev.clientX - left)));
		};
		const onUp = () => {
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}

	/** Flat visible rows, depth-first: a task shows when it or any descendant matches the filter. */
	const rows = $derived.by(() => {
		const matches = (t: Task): boolean =>
			ui.groupFilter === 'all' || !t.groupId || t.groupId === ui.groupFilter;
		const subtreeMatches = (t: Task): boolean =>
			matches(t) || (store.childrenByParent.get(t.id) ?? []).some(subtreeMatches);
		const out: Array<{ task: Task; depth: number }> = [];
		const walk = (t: Task, depth: number) => {
			if (!subtreeMatches(t)) return;
			out.push({ task: t, depth });
			for (const c of store.childrenByParent.get(t.id) ?? []) walk(c, depth + 1);
		};
		for (const t of store.rootTasks) walk(t, 0);
		return out;
	});

	/** Visible list order, for ⇧ range selection. */
	const visibleIds = $derived(rows.map((r) => r.task.id));

	function onTaskClick(e: MouseEvent, taskId: string) {
		if (suppressClick) return;
		ui.selectTask(taskId, {
			toggle: e.metaKey || e.ctrlKey,
			rangeOrder: e.shiftKey ? visibleIds : null
		});
	}

	// ---- drag-select: sweep across rows to spotlight the range -------------------

	let suppressClick = false;
	let dragSel: {
		startId: string;
		x: number;
		y: number;
		base: string[];
		union: boolean;
		started: boolean;
	} | null = null;

	function onRowPointerDown(e: PointerEvent, taskId: string) {
		if (e.button !== 0) return;
		// Hover actions and the Jira link keep their own clicks.
		if ((e.target as HTMLElement).closest('.actions, a')) return;
		if (e.altKey) {
			startBoardDrag(e, taskId);
			return;
		}
		dragSel = {
			startId: taskId,
			x: e.clientX,
			y: e.clientY,
			base: ui.selectedTaskIds(),
			union: e.metaKey || e.ctrlKey,
			started: false
		};
		window.addEventListener('pointermove', onDragMove);
		window.addEventListener('pointerup', onDragEnd, { once: true });
	}

	function onDragMove(e: PointerEvent) {
		if (!dragSel) return;
		if (!dragSel.started) {
			// A few px of slack so ordinary clicks never turn into drags.
			if (Math.abs(e.clientX - dragSel.x) < 5 && Math.abs(e.clientY - dragSel.y) < 5) return;
			dragSel.started = true;
		}
		const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-task-id]');
		const overId = row instanceof HTMLElement ? row.dataset.taskId : undefined;
		if (!overId) return;
		const a = visibleIds.indexOf(dragSel.startId);
		const b = visibleIds.indexOf(overId);
		if (a < 0 || b < 0) return;
		const range = visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
		ui.setSelection(
			dragSel.union ? [...new Set([...dragSel.base, ...range])] : range,
			dragSel.startId
		);
	}

	function onDragEnd() {
		window.removeEventListener('pointermove', onDragMove);
		if (dragSel?.started) {
			// Swallow the click that follows pointerup so it can't reset the selection.
			suppressClick = true;
			setTimeout(() => (suppressClick = false), 0);
		}
		dragSel = null;
	}

	// ---- ⌥-drag to board: schedule estimated tasks at the drop cell --------------

	let boardDrag = $state<{
		/** Schedulable tasks only (estimate set, remaining days > 0), in visible order. */
		taskIds: string[];
		days: number;
		skipped: number;
		x: number;
		y: number;
		started: boolean;
	} | null>(null);

	function startBoardDrag(e: PointerEvent, taskId: string) {
		const selection = ui.selectedTaskIds();
		const dragged = selection.includes(taskId)
			? visibleIds.filter((id) => selection.includes(id))
			: [taskId];
		const schedulable = dragged.filter((id) => store.remainingEstimate(id) > 0);
		boardDrag = {
			taskIds: schedulable,
			days: schedulable.reduce((sum, id) => sum + store.remainingEstimate(id), 0),
			skipped: dragged.length - schedulable.length,
			x: e.clientX,
			y: e.clientY,
			started: false
		};
		window.addEventListener('pointermove', onBoardDragMove);
		window.addEventListener('pointerup', onBoardDragEnd);
		window.addEventListener('keydown', onBoardDragKey);
	}

	function cellUnder(e: PointerEvent): { memberId: string; date: string } | null {
		const el = document
			.elementFromPoint(e.clientX, e.clientY)
			?.closest('[data-cell]') as HTMLElement | null;
		const memberId = el?.dataset.member;
		const date = el?.dataset.date;
		return memberId && date ? { memberId, date } : null;
	}

	function onBoardDragMove(e: PointerEvent) {
		if (!boardDrag) return;
		if (!boardDrag.started) {
			// The same few px of slack as drag-select, so ⌥-clicks stay clicks.
			if (Math.abs(e.clientX - boardDrag.x) < 5 && Math.abs(e.clientY - boardDrag.y) < 5) return;
			boardDrag.started = true;
		}
		boardDrag.x = e.clientX;
		boardDrag.y = e.clientY;
		ui.backlogDropCell = boardDrag.taskIds.length ? cellUnder(e) : null;
	}

	function onBoardDragEnd(e: PointerEvent) {
		const drop = boardDrag?.started ? cellUnder(e) : null;
		if (boardDrag?.started) {
			suppressClick = true;
			setTimeout(() => (suppressClick = false), 0);
		}
		if (drop && boardDrag?.taskIds.length) {
			store.scheduleTasksAt(boardDrag.taskIds, drop.memberId, drop.date);
		}
		endBoardDrag();
	}

	function onBoardDragKey(e: KeyboardEvent) {
		if (e.key === 'Escape') endBoardDrag();
	}

	function endBoardDrag() {
		window.removeEventListener('pointermove', onBoardDragMove);
		window.removeEventListener('pointerup', onBoardDragEnd);
		window.removeEventListener('keydown', onBoardDragKey);
		boardDrag = null;
		ui.backlogDropCell = null;
	}

	// ---- Jira pull / push for the whole period -----------------------------------

	const hasLinked = $derived(store.plan.tasks.some((t) => t.jiraKey));
	let syncMsg = $state('');

	async function pullFromJira() {
		syncMsg = '';
		await runJiraSync();
		syncMsg = jiraSync.lastOutcome;
	}

	async function pushToJira() {
		const n = store.plan.tasks.filter((t) => t.jiraKey).length;
		if (
			!confirm(
				`Push the board's data to Jira for ${n} linked task${n === 1 ? '' : 's'}? ` +
					`Scheduled start/end dates overwrite the issues' date fields` +
					(settings.jira.useStoryPoints ? ', and estimates overwrite their story points' : '') +
					`. The board is the source of truth.`
			)
		) {
			return;
		}
		syncMsg = '';
		syncMsg = await runJiraPush();
	}

	function onTaskContextMenu(e: MouseEvent, taskId: string) {
		e.preventDefault();
		if (!ui.isHighlighted('task', taskId)) ui.selectTask(taskId);
		ui.contextMenu = { x: e.clientX, y: e.clientY };
	}

	function removeTask(task: Task) {
		if (confirm(`Delete "${task.name}", its workstreams and all their assignments?`)) {
			store.removeTask(task.id);
		}
	}

	function statusText(task: Task): string {
		const rollup = store.schedule.rollups[task.id];
		const assigned = rollup?.assignedDays ?? 0;
		const est = task.estimateDays;
		if (!assigned) return est ? `${est}d · unscheduled` : 'unscheduled';
		const span = rollup.startDate
			? ` · ${formatMonthDay(rollup.startDate)} → ${formatMonthDay(rollup.endDate!)}`
			: '';
		return `${assigned}${est ? `/${est}` : ''}d${span}`;
	}

	function underAssigned(task: Task): boolean {
		const rollup = store.schedule.rollups[task.id];
		return !!task.estimateDays && !!rollup?.assignedDays && rollup.assignedDays < task.estimateDays;
	}

	const periodEnd = $derived(periodEndOf(store.plan.startDate, store.plan.numWeeks));

	function overflows(task: Task): boolean {
		const end = store.schedule.rollups[task.id]?.endDate;
		return !!end && end > periodEnd;
	}

	function hasWarning(task: Task): boolean {
		return underAssigned(task) || overflows(task);
	}

	function warnDetail(task: Task): string {
		const lines: string[] = [];
		if (underAssigned(task)) {
			const assigned = store.schedule.rollups[task.id]?.assignedDays ?? 0;
			const estimate = task.estimateDays ?? 0;
			lines.push(
				`Under-assigned: ${assigned} of ${estimate} estimated person-days are scheduled — ` +
					`${estimate - assigned}d still missing. Use ▸ to split the rest between members.`
			);
		}
		if (overflows(task)) {
			const end = store.schedule.rollups[task.id]!.endDate!;
			lines.push(
				`Runs past this period: ends ${formatMonthDay(end)}, but the period ends ` +
					`${formatMonthDay(periodEnd)}. Shrink or split it, or move some work elsewhere.`
			);
		}
		return lines.join('\n');
	}
</script>

{#if ui.sidebarCollapsed}
	<div class="rail">
		<button onclick={() => (ui.sidebarCollapsed = false)} title="Show task list">▸</button>
		<span class="rail-label">Tasks</span>
	</div>
{:else}
	<aside bind:this={asideEl} style="width: {ui.sidebarWidth}px">
		<header>
			<h2>Tasks</h2>
			<span class="hdr-actions">
				<button class="primary" onclick={() => ui.openNewTask()}>＋ New task</button>
				<button
					class="import"
					onclick={() => (ui.jiraImportOpen = true)}
					title="Import tasks from Jira (JQL query)"
				>
					⤓ Jira
				</button>
				{#if hasLinked && settings.jiraConfigured()}
					<button
						class="import"
						disabled={jiraSync.busy}
						onclick={pullFromJira}
						title="Pull updated data from Jira for every linked task (names, status, colors; estimates fill only when empty)"
					>
						⇣ Pull
					</button>
					<button
						class="import"
						disabled={jiraSync.busy}
						onclick={pushToJira}
						title="Push scheduled start/end dates (and estimates as story points) to Jira for every linked task"
					>
						⇡ Push
					</button>
				{/if}
				<button
					class="collapse"
					onclick={() => (ui.sidebarCollapsed = true)}
					title="Hide task list"
				>
					◂
				</button>
			</span>
		</header>
		{#if syncMsg}
			<div class="syncmsg" class:err={syncMsg.startsWith('✗') || syncMsg.startsWith('⚠')}>
				{syncMsg}
			</div>
		{/if}
		<ul>
			{#each rows as { task, depth } (task.id)}
				<li style:padding-left="{depth * 18}px">
					{@render taskRow(task, depth > 0)}
				</li>
			{:else}
				<li class="empty">No tasks yet.</li>
			{/each}
		</ul>
		<div
			class="resizer"
			role="separator"
			aria-orientation="vertical"
			onpointerdown={startResize}
		></div>
	</aside>
{/if}

{#if boardDrag?.started}
	<div class="drag-ghost" style:left="{boardDrag.x + 12}px" style:top="{boardDrag.y + 14}px">
		{#if boardDrag.taskIds.length}
			<span>
				{boardDrag.taskIds.length} task{boardDrag.taskIds.length === 1 ? '' : 's'} · {boardDrag.days}d
				— drop on a member's column
			</span>
			{#if boardDrag.skipped}
				<span class="skip">
					{boardDrag.skipped} skipped — no estimate (or fully scheduled)
				</span>
			{/if}
		{:else}
			<span class="skip">Nothing to schedule — set an estimate first</span>
		{/if}
	</div>
{/if}

{#snippet taskRow(task: Task, isChild: boolean)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="row"
		class:child={isChild}
		class:spotlit={ui.isHighlighted('task', task.id)}
		data-task-id={task.id}
		onpointerdown={(e) => onRowPointerDown(e, task.id)}
	>
		<span class="swatch" style:background={task.color}></span>
		<button
			class="text"
			onclick={(e) => onTaskClick(e, task.id)}
			oncontextmenu={(e) => onTaskContextMenu(e, task.id)}
			title="{store.taskPath(
				task.id
			)} · id {task.id} — click to spotlight (⌘ adds, ⇧ ranges); right-click for actions; ⌥-drag onto the board to schedule (needs an estimate)"
		>
			<span class="name">
				{task.name}
				{#if task.groupId}
					<span class="tag">{store.groupsById.get(task.groupId)?.name ?? '?'}</span>
				{/if}
			</span>
			<span class="status" class:warn={hasWarning(task)} title={statusText(task)}>
				{statusText(task)}{#if hasWarning(task)}<span class="warnmark" title={warnDetail(task)}
						>&nbsp;⚠</span
					>{/if}
			</span>
			{#if task.dependsOn?.length}
				<span class="deps">
					⇠ after {task.dependsOn.map((d) => store.tasksById.get(d)?.name ?? '?').join(', ')}
				</span>
			{/if}
		</button>
		{#if task.jiraKey}
			{#if settings.jiraConfigured()}
				<a
					class="jira"
					href={jiraIssueUrl(settings.jira, task.jiraKey)}
					target="_blank"
					rel="noreferrer"
					title="Open {task.jiraKey} in Jira"
				>
					{task.jiraKey}
				</a>
			{:else}
				<span class="jira" title="Linked Jira issue">{task.jiraKey}</span>
			{/if}
		{/if}
		<div class="actions">
			<button title="Schedule / split between members" onclick={() => ui.openSplit(task.id)}>
				▸
			</button>
			<button title="Edit task" onclick={() => ui.openEditTask(task.id)}>✎</button>
			<button title="Add sub-team workstream" onclick={() => ui.openNewTask(task.id)}>＋</button>
			<button class="del" title="Delete task…" onclick={() => removeTask(task)}>✕</button>
		</div>
	</div>
{/snippet}

<style>
	aside {
		position: relative;
		flex: none;
		overflow-x: hidden;
		border-right: 1px solid var(--border);
		background: var(--panel-alt);
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		background: var(--panel-alt);
		z-index: 1;
	}
	h2 {
		font-size: 13px;
		margin: 0;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.primary {
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: 6px;
		border: none;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}
	.primary:hover {
		background: var(--accent-hover);
	}
	.import {
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		padding: 4px 8px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text-mid);
		cursor: pointer;
		white-space: nowrap;
	}
	.import:hover:not(:disabled) {
		background: var(--hover);
	}
	.import:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.syncmsg {
		font-size: 11px;
		color: var(--ok);
		padding: 6px 12px;
		border-bottom: 1px solid var(--border);
		line-height: 1.4;
	}
	.syncmsg.err {
		color: var(--danger);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 6px 8px;
	}
	.empty {
		color: var(--text-faint);
		font-size: 12.5px;
		padding: 8px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 6px;
		border-radius: 7px;
		/* Drag-select sweeps across rows — text selection would fight it. */
		user-select: none;
		-webkit-user-select: none;
	}
	.row:hover {
		background: var(--hover);
	}
	.swatch {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		flex: none;
		border: 1px solid rgba(0, 0, 0, 0.1);
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		text-align: left;
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}
	.row.spotlit {
		background: var(--accent-soft);
		outline: 1px solid var(--accent);
	}
	.name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tag {
		font-size: 9.5px;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--tag-text);
		background: var(--tag-bg);
		border-radius: 4px;
		padding: 1px 4px;
		margin-left: 4px;
	}
	.status {
		font-size: 10.5px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.status.warn {
		color: var(--warn);
	}
	.deps {
		font-size: 10px;
		color: var(--tag-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.jira {
		font-size: 9.5px;
		font-weight: 700;
		color: var(--accent);
		background: var(--accent-soft);
		border-radius: 4px;
		padding: 1px 4px;
		text-decoration: none;
		flex: none;
		max-width: 92px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The hover actions need the space — the key stays discoverable at rest. */
	.row:hover .jira {
		display: none;
	}
	a.jira:hover {
		text-decoration: underline;
	}
	.actions {
		display: none;
		gap: 2px;
	}
	.row:hover .actions {
		display: flex;
	}
	.actions button {
		border: none;
		background: none;
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
		padding: 3px 5px;
		border-radius: 5px;
	}
	.actions button:hover {
		background: var(--border);
	}
	.actions .del:hover {
		color: var(--danger);
		background: var(--danger-bg);
	}
	.hdr-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.collapse {
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 13px;
		padding: 2px 5px;
		border-radius: 5px;
	}
	.collapse:hover {
		background: var(--hover);
		color: var(--text);
	}
	.resizer {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 2;
		touch-action: none;
	}
	.resizer:hover {
		background: var(--accent);
		opacity: 0.35;
	}
	.rail {
		flex: none;
		width: 30px;
		border-right: 1px solid var(--border);
		background: var(--panel-alt);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding-top: 8px;
	}
	.rail button {
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 13px;
		padding: 2px 5px;
		border-radius: 5px;
	}
	.rail button:hover {
		background: var(--hover);
		color: var(--text);
	}
	.drag-ghost {
		position: fixed;
		z-index: 100;
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-width: 280px;
		padding: 5px 9px;
		border-radius: 7px;
		background: var(--panel);
		box-shadow:
			0 0 0 1px var(--border-strong),
			0 8px 20px rgba(0, 0, 0, 0.22);
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text);
	}
	.drag-ghost .skip {
		font-weight: 500;
		color: var(--warn);
	}
	.rail-label {
		writing-mode: vertical-rl;
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-faint);
	}
</style>
