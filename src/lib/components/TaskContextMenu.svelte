<script lang="ts">
	import { addDays, periodEndOf, quarterOf, quartersAround, toISO } from '$lib/engine/calendar';
	import { jiraIssueUrl } from '$lib/integrations/jira';
	import { clampToViewport } from './clampToViewport';
	import { store } from '$lib/state/plan.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';

	const quarters = quartersAround(toISO(new Date()), 2, 5);

	const selection = $derived(ui.selectedTaskIds());
	/** The selected task's Jira link — only for a single selection with a key and a site URL. */
	const jiraTask = $derived.by(() => {
		if (selection.length !== 1) return null;
		const task = store.tasksById.get(selection[0]);
		return task?.jiraKey && settings.jira.baseUrl ? task : null;
	});

	let parentOpen = $state(false);
	$effect(() => {
		// Collapse the parent picker whenever the menu (re)opens.
		if (ui.contextMenu) parentOpen = false;
	});

	/** Selected tasks whose parent is not itself selected — each moves with its whole subtree. */
	const selectionRoots = $derived.by(() => {
		const sel = new Set(selection);
		return selection.filter((id) => {
			for (let p = store.tasksById.get(id)?.parentId; p; p = store.tasksById.get(p)?.parentId) {
				if (sel.has(p)) return false;
			}
			return true;
		});
	});

	/** Valid new parents: anything outside the moved subtrees (no cycles). */
	const parentChoices = $derived.by(() => {
		const excluded = new Set<string>();
		const walk = (id: string) => {
			if (excluded.has(id)) return;
			excluded.add(id);
			for (const c of store.childrenByParent.get(id) ?? []) walk(c.id);
		};
		for (const id of selectionRoots) walk(id);
		return store.plan.tasks.filter((t) => !excluded.has(t.id));
	});

	function setParent(parentId: string | undefined) {
		store.setTasksParent(selection, parentId);
		close();
	}
	// Null-safe: these re-evaluate harmlessly while the menu is closing.
	const blockAssignmentId = $derived(ui.contextMenu?.assignmentId);
	const menuX = $derived(ui.contextMenu?.x ?? 0);
	const menuY = $derived(ui.contextMenu?.y ?? 0);
	const targets = $derived(
		quarters.filter((q) => !(q.start === store.plan.startDate && q.weeks === store.plan.numWeeks))
	);
	const nextQuarter = $derived(
		quarterOf(addDays(periodEndOf(store.plan.startDate, store.plan.numWeeks), 1))
	);

	const pos = $derived.by(() => {
		if (!ui.contextMenu) return { x: 0, y: 0 };
		return {
			x: Math.min(ui.contextMenu.x, (window?.innerWidth ?? 1200) - 230),
			y: Math.min(ui.contextMenu.y, (window?.innerHeight ?? 800) - targets.length * 30 - 90)
		};
	});

	function close() {
		ui.contextMenu = null;
	}

	function moveTo(start: string, weeks: number, label: string) {
		const n = selection.length;
		if (
			!confirm(
				`Move ${n} task${n === 1 ? '' : 's'} (with workstreams and assignments) to ${label}? ` +
					`Their position relative to the period start is kept. This cannot be undone.`
			)
		) {
			close();
			return;
		}
		store.moveTasksToPeriod(selection, start, weeks, label);
		// Selection survives: same task ids now live in the target plan,
		// so the moved tasks arrive spotlighted — overflow warnings included.
		close();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && ui.contextMenu) close();
	}
</script>

<svelte:window {onkeydown} />

{#if ui.contextMenu && selection.length}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="backdrop"
		onclick={close}
		oncontextmenu={(e) => {
			e.preventDefault();
			close();
		}}
	></div>
	<div class="menu" use:clampToViewport style="left: {pos.x}px; top: {pos.y}px">
		<div class="title">
			{selection.length} task{selection.length === 1 ? '' : 's'} selected
		</div>
		{#each targets as q (q.start)}
			<button onclick={() => moveTo(q.start, q.weeks, q.label)}>
				Move to {q.label}{store.hasDataForPeriod(q.start, q.weeks) ? ' ●' : ''}
			</button>
		{/each}
		<button
			title="Create the same task (same identity, no assignments) in the next period — this period keeps its part"
			onclick={() => {
				store.continueTasksInPeriod(
					selection,
					nextQuarter.start,
					nextQuarter.weeks,
					nextQuarter.label
				);
				close();
			}}
		>
			↪ Continue in {nextQuarter.label}
		</button>
		<hr />
		<button
			title="Move the selected tasks (each with its workstreams) under a parent task, or to top level"
			onclick={() => (parentOpen = !parentOpen)}
		>
			{parentOpen ? '▾' : '▸'} Set parent task…
		</button>
		{#if parentOpen}
			<div class="sub">
				<button onclick={() => setParent(undefined)}>— none (top-level) —</button>
				{#each parentChoices as p (p.id)}
					<button onclick={() => setParent(p.id)}>
						<span class="dot" style:background={p.color}></span>
						<span class="plabel">{store.taskPath(p.id)}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if blockAssignmentId}
			<hr />
			<button
				onclick={() => {
					const id = blockAssignmentId;
					const x = menuX;
					const y = menuY;
					close();
					if (id) ui.popover = { kind: 'assignment', id, x, y };
				}}
			>
				Edit block (days, task)…
			</button>
			<button
				onclick={() => {
					if (blockAssignmentId) store.removeAssignment(blockAssignmentId);
					close();
				}}
			>
				Remove this block
			</button>
		{/if}
		<hr />
		{#if jiraTask}
			<button
				onclick={() => {
					const url = jiraIssueUrl(settings.jira, jiraTask.jiraKey!);
					close();
					window.open(url, '_blank', 'noopener,noreferrer');
				}}
			>
				🔗 Open {jiraTask.jiraKey} in Jira
			</button>
		{/if}
		{#if selection.length === 1}
			<button
				onclick={() => {
					ui.paintTask = { taskId: selection[0] };
					ui.ptoMode = false;
					ui.viewMode = 'board';
					close();
				}}
			>
				🖌 Paint chunks on the board
			</button>
		{/if}
		<button
			onclick={() => {
				ui.highlight = null;
				close();
			}}
		>
			Clear selection
		</button>
		<button
			class="danger"
			onclick={() => {
				const ids = [...selection];
				const label =
					ids.length === 1
						? `"${store.tasksById.get(ids[0])?.name ?? '?'}"`
						: `${ids.length} tasks`;
				close();
				if (confirm(`Delete ${label}, with workstreams and all their assignments?`)) {
					store.removeTasks(ids);
					ui.highlight = null;
				}
			}}
		>
			🗑 Delete {selection.length === 1 ? 'task' : `${selection.length} tasks`}…
		</button>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
	}
	.menu {
		position: fixed;
		z-index: 61;
		min-width: 210px;
		max-height: calc(100vh - 16px);
		overflow-y: auto;
		background: var(--panel);
		border-radius: 9px;
		box-shadow:
			0 0 0 1px var(--border),
			0 12px 32px rgba(0, 0, 0, 0.22);
		padding: 5px;
		display: flex;
		flex-direction: column;
	}
	.title {
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		padding: 5px 9px 4px;
	}
	button {
		font: inherit;
		font-size: 12.5px;
		text-align: left;
		padding: 6px 9px;
		border: none;
		background: none;
		border-radius: 6px;
		cursor: pointer;
		color: var(--text);
	}
	button:hover {
		background: var(--hover);
	}
	button.danger {
		color: var(--danger);
	}
	button.danger:hover {
		background: var(--danger-bg);
	}
	hr {
		border: none;
		border-top: 1px solid var(--border);
		margin: 4px 0;
	}
	.sub {
		display: flex;
		flex-direction: column;
		max-height: 180px;
		overflow-y: auto;
		margin: 0 0 2px 10px;
		padding-left: 4px;
		border-left: 1px solid var(--border);
	}
	.sub button {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		padding: 4px 8px;
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 3px;
		flex: none;
		border: 1px solid rgba(0, 0, 0, 0.1);
	}
	.plabel {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
