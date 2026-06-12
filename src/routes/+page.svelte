<script lang="ts">
	import AbsencePopover from '$lib/components/AbsencePopover.svelte';
	import AssignmentPopover from '$lib/components/AssignmentPopover.svelte';
	import Backlog from '$lib/components/Backlog.svelte';
	import GanttView from '$lib/components/GanttView.svelte';
	import Grid from '$lib/components/Grid.svelte';
	import JiraImportDialog from '$lib/components/JiraImportDialog.svelte';
	import SettingsDialog from '$lib/components/SettingsDialog.svelte';
	import SplitDialog from '$lib/components/SplitDialog.svelte';
	import TaskContextMenu from '$lib/components/TaskContextMenu.svelte';
	import TaskDialog from '$lib/components/TaskDialog.svelte';
	import TeamDialog from '$lib/components/TeamDialog.svelte';
	import Toolbar from '$lib/components/Toolbar.svelte';
	import { store } from '$lib/state/plan.svelte';
	import { ui } from '$lib/state/ui.svelte';

	function onkeydown(e: KeyboardEvent) {
		if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		if (e.shiftKey) store.redo();
		else store.undo();
	}
</script>

<svelte:head>
	<title>{store.plan.name} · Gantter</title>
</svelte:head>
<svelte:window {onkeydown} />

<div class="app">
	<Toolbar />
	<div class="main">
		<Backlog />
		<div class="board">
			{#if ui.viewMode === 'board'}
				<Grid />
			{:else}
				<GanttView />
			{/if}
		</div>
	</div>
</div>

<TaskDialog />
<JiraImportDialog />
<SplitDialog />
<TeamDialog />
<SettingsDialog />
<AssignmentPopover />
<AbsencePopover />
<TaskContextMenu />

<style>
	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.main {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.board {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
</style>
