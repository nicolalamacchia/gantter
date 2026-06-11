<script lang="ts">
	import { formatMonthDay } from '$lib/engine/calendar';
	import { store } from '$lib/state/plan.svelte';
	import { ui } from '$lib/state/ui.svelte';

	/**
	 * The "sync" view: every top-level task with work on the board, with its
	 * overall span aggregated across all sub-team workstreams — visible even
	 * when the grid is filtered to a single group.
	 */
	const items = $derived.by(() =>
		store.rootTasks
			.map((task) => ({
				task,
				rollup: store.schedule.rollups[task.id],
				children: (store.childrenByParent.get(task.id) ?? [])
					.map((c) => ({ task: c, rollup: store.schedule.rollups[c.id] }))
					.filter((c) => c.rollup?.endDate)
			}))
			.filter((i) => i.rollup?.startDate)
	);
</script>

{#if items.length}
	<div class="strip">
		{#each items as item (item.task.id)}
			<button
				class="chip"
				class:spotlit={ui.isHighlighted('task', item.task.id)}
				onclick={() => ui.toggleHighlight('task', item.task.id)}
				title="{item.task.name} — click to spotlight on the board"
			>
				<span class="swatch" style:background={item.task.color}></span>
				<span class="name">{item.task.name}</span>
				<span class="dates">
					{formatMonthDay(item.rollup.startDate!)} → {formatMonthDay(item.rollup.endDate!)}
					· {item.rollup.assignedDays}d
				</span>
				{#if item.children.length}
					<span class="children">
						{#each item.children as c (c.task.id)}
							<span class="child" title="{c.task.name} ends {formatMonthDay(c.rollup.endDate!)}">
								{c.task.name}: {formatMonthDay(c.rollup.endDate!)}
							</span>
						{/each}
					</span>
				{/if}
			</button>
		{/each}
	</div>
{/if}

<style>
	.strip {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		overflow-x: auto;
		border-bottom: 1px solid var(--border);
		background: var(--panel-alt);
		flex: none;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 7px;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 5px 10px;
		font-size: 11.5px;
		white-space: nowrap;
		background: var(--panel);
		font: inherit;
		cursor: pointer;
	}
	.chip:hover {
		background: var(--hover);
	}
	.chip.spotlit {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: none;
	}
	.name {
		font-weight: 600;
		color: var(--text);
	}
	.dates {
		color: var(--text-muted);
	}
	.children {
		display: flex;
		gap: 6px;
		color: var(--text-muted);
		border-left: 1px solid var(--border);
		padding-left: 8px;
	}
</style>
