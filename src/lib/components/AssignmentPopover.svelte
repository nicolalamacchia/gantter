<script lang="ts">
	import { formatMonthDay } from '$lib/engine/calendar';
	import { clampToViewport } from './clampToViewport';
	import { jiraIssueUrl } from '$lib/integrations/jira';
	import { store } from '$lib/state/plan.svelte';
	import { maybeOfferRollover } from '$lib/state/rollover';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';

	const info = $derived.by(() => {
		if (ui.popover?.kind !== 'assignment') return null;
		const assignment = store.assignmentById(ui.popover.id);
		if (!assignment) return null;
		const task = store.tasksById.get(assignment.taskId);
		const parent = task?.parentId ? store.tasksById.get(task.parentId) : undefined;
		// All chunks of this task on this member are conceptually one block:
		// days and dates are totals across them.
		const chunks = store.plan.assignments.filter(
			(a) => a.taskId === assignment.taskId && a.memberId === assignment.memberId
		);
		const totalDays = chunks.reduce((sum, a) => sum + a.days, 0);
		const allDays = chunks.flatMap((a) => store.schedule.placements[a.id]?.days ?? []).sort();
		const overflowDays = chunks.reduce(
			(sum, a) => sum + (store.schedule.placements[a.id]?.overflowDays ?? 0),
			0
		);
		return {
			assignment,
			task,
			label: parent ? `${parent.name} · ${task?.name}` : (task?.name ?? '?'),
			member: store.membersById.get(assignment.memberId),
			totalDays,
			othersDays: totalDays - assignment.days,
			parts: chunks.length,
			startDate: allDays[0],
			endDate: allDays[allDays.length - 1],
			overflowDays
		};
	});

	const pos = $derived.by(() => {
		if (!ui.popover) return { x: 0, y: 0 };
		return {
			x: Math.min(ui.popover.x, (window?.innerWidth ?? 1200) - 280),
			y: Math.min(ui.popover.y, (window?.innerHeight ?? 800) - 220)
		};
	});

	function close() {
		ui.popover = null;
	}
</script>

{#if info && ui.popover}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="backdrop" onclick={close}></div>
	<div class="popover" use:clampToViewport style="left: {pos.x}px; top: {pos.y}px">
		<header>
			<span class="swatch" style:background={info.task?.color ?? '#ccc'}></span>
			<strong>{info.label}</strong>
		</header>
		{#if info.task?.jiraKey}
			<div class="meta">
				🔗
				{#if settings.jiraConfigured()}
					<a href={jiraIssueUrl(settings.jira, info.task.jiraKey)} target="_blank" rel="noreferrer">
						{info.task.jiraKey}
					</a>
				{:else}
					{info.task.jiraKey}
				{/if}
			</div>
		{/if}
		<div class="meta">
			{info.member?.name}
			{#if info.startDate}
				· {formatMonthDay(info.startDate)} → {formatMonthDay(info.endDate)}
			{/if}
			{#if info.parts > 1}
				· in {info.parts} parts
			{/if}
			{#if info.overflowDays > 0}
				<span class="warn">⚠ {info.overflowDays}d beyond horizon</span>
			{/if}
		</div>
		<label class="days">
			Days{info.parts > 1 ? ' (all parts)' : ''}
			<input
				type="number"
				min={info.othersDays + 1}
				value={info.totalDays}
				onchange={(e) => {
					const taskId = info.assignment.taskId;
					const prevEnd = store.schedule.rollups[taskId]?.endDate ?? null;
					store.setAssignmentDays(
						info.assignment.id,
						e.currentTarget.valueAsNumber - info.othersDays
					);
					if (maybeOfferRollover(taskId, prevEnd)) close();
				}}
			/>
		</label>
		<footer>
			<button
				onclick={() => {
					const taskId = info.task?.id;
					close();
					if (taskId) ui.openEditTask(taskId);
				}}
			>
				Edit task
			</button>
			<button
				class="danger"
				onclick={() => {
					store.removeAssignment(info.assignment.id);
					close();
				}}
			>
				Remove from plan
			</button>
		</footer>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.popover {
		position: fixed;
		z-index: 31;
		width: 264px;
		background: var(--panel);
		border-radius: 10px;
		box-shadow:
			0 0 0 1px var(--border),
			0 12px 32px rgba(0, 0, 0, 0.18);
		padding: 12px 14px;
		font-size: 12.5px;
	}
	header {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 6px;
	}
	.swatch {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		flex: none;
	}
	.meta {
		color: var(--text-muted);
		margin-bottom: 8px;
	}
	.meta a {
		color: var(--accent);
		font-weight: 600;
		text-decoration: none;
	}
	.meta a:hover {
		text-decoration: underline;
	}
	.warn {
		color: var(--warn);
		font-weight: 600;
	}
	.days {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		margin-bottom: 10px;
	}
	.days input {
		width: 64px;
		padding: 4px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		font: inherit;
	}
	footer {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	button {
		font: inherit;
		font-size: 12px;
		padding: 5px 10px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	button:hover {
		background: var(--hover);
	}
	.danger {
		color: var(--danger);
		border-color: var(--danger-border);
	}
	.danger:hover {
		background: var(--danger-bg);
	}
</style>
