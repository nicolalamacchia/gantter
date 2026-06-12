<script lang="ts">
	import logo from '$lib/assets/favicon.svg';
	import { quartersAround, toISO } from '$lib/engine/calendar';
	import { downloadBlob } from '$lib/export/download';
	import type { Plan } from '$lib/model/types';
	import { planFromJSON, planToJSON } from '$lib/state/persistence';
	import { store } from '$lib/state/plan.svelte';
	import { trySilentSignIn } from '$lib/integrations/google';
	import { connection } from '$lib/state/connection.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import {
		sheetConfigured,
		sheetDirty,
		sheetSync,
		syncPlanToSheet
	} from '$lib/state/sheetSync.svelte';
	import { ui, type Theme } from '$lib/state/ui.svelte';

	let fileInput = $state<HTMLInputElement>();
	let exporting = $state(false);
	let menu = $state<HTMLDetailsElement>();
	let customRange = $state(false);

	const quarters = quartersAround(toISO(new Date()), 2, 5);
	const period = $derived.by(() => {
		if (customRange) return 'custom';
		const match = quarters.find(
			(q) => q.start === store.plan.startDate && q.weeks === store.plan.numWeeks
		);
		return match?.start ?? 'custom';
	});

	function selectPeriod(value: string) {
		if (value === 'custom') {
			customRange = true;
			return;
		}
		customRange = false;
		const q = quarters.find((q) => q.start === value);
		if (q) store.switchToPeriod(q.start, q.weeks, q.label);
	}

	/** Quarters that already have a plan with content get a marker in the picker. */
	const periodsWithData = $derived.by(() => {
		void store.registryVersion;
		return new Set(
			quarters.filter((q) => store.hasDataForPeriod(q.start, q.weeks)).map((q) => q.start)
		);
	});

	function snapshot(): Plan {
		return $state.snapshot(store.plan) as Plan;
	}

	async function exportExcel() {
		exporting = true;
		menu?.removeAttribute('open');
		try {
			const { exportXlsx } = await import('$lib/export/xlsx');
			downloadBlob(`${store.plan.name || 'plan'}.xlsx`, await exportXlsx(snapshot()));
		} finally {
			exporting = false;
		}
	}

	function exportJson() {
		menu?.removeAttribute('open');
		downloadBlob(
			`${store.plan.name || 'plan'}.plan.json`,
			new Blob([planToJSON(snapshot())], { type: 'application/json' })
		);
	}

	const sheetIsDirty = $derived(sheetDirty());
	const sheetIsConfigured = $derived(sheetConfigured());

	async function syncSheet() {
		menu?.removeAttribute('open');
		const outcome = await syncPlanToSheet();
		if (outcome.startsWith('✗')) alert(outcome);
	}

	async function importJson() {
		menu?.removeAttribute('open');
		const file = fileInput?.files?.[0];
		if (!file) return;
		try {
			const incoming = planFromJSON(await file.text());
			const existing = store.planForPeriod(incoming.startDate, incoming.numWeeks);
			if (
				existing &&
				existing.id !== incoming.id &&
				(existing.tasks.length > 0 || existing.absences.length > 0)
			) {
				if (
					!confirm(
						`A plan for that period already exists ("${existing.name}"). Replace it with the imported one?`
					)
				) {
					if (fileInput) fileInput.value = '';
					return;
				}
			}
			store.importPlan(incoming);
		} catch {
			alert('Not a valid plan file.');
		}
		if (fileInput) fileInput.value = '';
	}

	function resetDemo() {
		menu?.removeAttribute('open');
		if (confirm('Replace the current plan with the demo data? (Undo is available.)')) {
			store.resetToDemo();
		}
	}
</script>

<div class="toolbar">
	<img class="logo" src={logo} alt="Gantter" title="Gantter" />
	<span class="brand">Gantter</span>
	<input
		class="title"
		type="text"
		value={store.plan.name}
		onchange={(e) => store.updatePlanMeta({ name: e.currentTarget.value })}
		title="Plan name"
	/>
	<div class="chips" role="group" aria-label="View">
		<button class:active={ui.viewMode === 'board'} onclick={() => (ui.viewMode = 'board')}>
			Board
		</button>
		<button class:active={ui.viewMode === 'gantt'} onclick={() => (ui.viewMode = 'gantt')}>
			Gantt
		</button>
	</div>
	<label class="ctl">
		<span class="lbl">Period</span>
		<select value={period} onchange={(e) => selectPeriod(e.currentTarget.value)}>
			{#each quarters as q (q.start)}
				<option value={q.start}>{q.label}{periodsWithData.has(q.start) ? ' ●' : ''}</option>
			{/each}
			<option value="custom">Custom…</option>
		</select>
	</label>
	{#if period === 'custom'}
		<label class="ctl">
			Start
			<input
				type="date"
				value={store.plan.startDate}
				onchange={(e) => {
					if (e.currentTarget.value) store.updatePlanMeta({ startDate: e.currentTarget.value });
				}}
			/>
		</label>
		<label class="ctl">
			Weeks
			<input
				class="weeks"
				type="number"
				min="2"
				max="60"
				value={store.plan.numWeeks}
				onchange={(e) =>
					store.updatePlanMeta({
						numWeeks: Math.max(2, Math.min(60, e.currentTarget.valueAsNumber || 13))
					})}
			/>
		</label>
	{/if}

	<span class="sep"></span>

	<div class="chips" role="group" aria-label="Sub-team filter">
		<button class:active={ui.groupFilter === 'all'} onclick={() => (ui.groupFilter = 'all')}>
			All
		</button>
		{#each store.plan.groups as g (g.id)}
			<button class:active={ui.groupFilter === g.id} onclick={() => (ui.groupFilter = g.id)}>
				{g.name}
			</button>
		{/each}
	</div>

	<span class="sep"></span>

	{#if ui.viewMode === 'board'}
		<button
			class="btn"
			class:active={ui.ptoMode}
			onclick={() => (ui.ptoMode = !ui.ptoMode)}
			title="Paint PTO/absence on the grid; click a painted cell to remove it"
		>
			🏖 PTO {ui.ptoMode ? 'on' : ''}
		</button>
	{/if}
	<label class="ctl">
		<span class="lbl">Zoom</span>
		<select value={String(ui.zoom)} onchange={(e) => (ui.zoom = Number(e.currentTarget.value))}>
			<option value="18">S</option>
			<option value="24">M</option>
			<option value="32">L</option>
		</select>
	</label>
	{#if ui.viewMode === 'board'}
		<label class="ctl" title="Column width">
			<span class="lbl">Cols</span>
			<input
				class="colw"
				type="range"
				min="48"
				max="280"
				step="4"
				value={ui.colWidth}
				oninput={(e) => (ui.colWidth = Number(e.currentTarget.value))}
			/>
		</label>
		<button
			class="btn"
			onclick={() => ui.fitColumnsRequest++}
			title="Shrink columns equally so the whole team fits in view"
		>
			⇤⇥ Fit
		</button>
	{/if}
	<button class="btn" disabled={!store.canUndo} onclick={() => store.undo()} title="Undo (⌘Z)">
		↩
	</button>
	<button class="btn" disabled={!store.canRedo} onclick={() => store.redo()} title="Redo (⇧⌘Z)">
		↪
	</button>

	<span class="spacer"></span>

	<button
		class="conn"
		class:ok={settings.jiraConfigured() && connection.jira === true}
		class:bad={settings.jiraConfigured() && connection.jira === false}
		title={!settings.jiraConfigured()
			? 'Jira: not configured — open Settings'
			: connection.jira === true
				? 'Jira: connected'
				: connection.jira === false
					? 'Jira: last call failed — check Settings'
					: 'Jira: configured, not verified yet'}
		onclick={() => (settings.dialogOpen = true)}
	>
		Jira
	</button>
	<button
		class="conn"
		class:ok={connection.google}
		title={connection.google ? 'Google: signed in' : 'Google: not signed in — click to reconnect'}
		onclick={async () => {
			if (!connection.google && settings.google.clientId) {
				// User gesture: a silent re-auth is allowed to pop briefly if needed.
				if (await trySilentSignIn(settings.google.clientId)) return;
			}
			settings.dialogOpen = true;
		}}
	>
		Google
	</button>
	<label class="ctl">
		<span class="lbl">Theme</span>
		<select
			value={ui.theme}
			onchange={(e) => ui.setTheme(e.currentTarget.value as Theme)}
			title="Color theme"
		>
			<option value="light">Light</option>
			<option value="dark">Dark</option>
			<option value="system">System</option>
		</select>
	</label>
	<button class="btn" onclick={() => (ui.teamDialogOpen = true)}>👥 Team</button>
	<button
		class="btn"
		onclick={() => (settings.dialogOpen = true)}
		title="Integrations (Jira, Google Calendar)"
	>
		⚙ Settings
	</button>
	<details class="menu" bind:this={menu}>
		<summary class="btn">{exporting ? 'Exporting…' : '⤓ Data'}</summary>
		<div class="dropdown">
			<button onclick={exportExcel} disabled={exporting}>Export Excel (.xlsx)</button>
			<button onclick={exportJson}>Export plan file (.json)</button>
			<button onclick={() => fileInput?.click()}>Import plan file…</button>
			{#if connection.google}
				<hr />
				<button
					onclick={syncSheet}
					disabled={sheetSync.busy || (sheetIsConfigured && !sheetIsDirty)}
					title="Push the periods selected in Settings → Google Sheets (write-only; the doc is created on first sync)"
				>
					{sheetSync.busy
						? 'Syncing to Google Sheet…'
						: !sheetIsConfigured
							? 'Sync to Google Sheet…'
							: sheetIsDirty
								? 'Sync to Google Sheet'
								: '✓ Synced to Google Sheet'}
				</button>
			{/if}
			<hr />
			<button onclick={resetDemo}>Reset to demo data</button>
		</div>
	</details>
	<input
		type="file"
		accept="application/json,.json"
		bind:this={fileInput}
		onchange={importJson}
		hidden
	/>
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-bottom: 1px solid var(--border);
		background: var(--panel);
		flex: none;
		/* Wrapping is the last resort: items shrink and labels hide first. */
		flex-wrap: wrap;
		container-type: inline-size;
	}
	.logo {
		width: 24px;
		height: 24px;
		flex: none;
	}
	.brand {
		font-size: 14px;
		font-weight: 800;
		letter-spacing: 0.01em;
		color: var(--text);
		flex: none;
	}
	.title {
		font: inherit;
		font-size: 14px;
		font-weight: 700;
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 4px 8px;
		flex: 0 1 170px;
		min-width: 80px;
		color: var(--text);
	}
	@container (max-width: 1500px) {
		.lbl,
		.brand {
			display: none;
		}
		.title {
			flex-basis: 120px;
		}
	}
	@container (max-width: 1200px) {
		.colw {
			width: 56px;
		}
		.toolbar,
		.chips {
			gap: 4px;
		}
	}
	.title:hover,
	.title:focus {
		border-color: var(--border-strong);
		outline: none;
	}
	.ctl {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.ctl input,
	.ctl select {
		font: inherit;
		font-size: 12px;
		padding: 3px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		color: var(--text);
	}
	.weeks {
		width: 52px;
	}
	.colw {
		width: 72px;
		padding: 0;
		border: none;
		background: none;
	}
	.conn {
		font: inherit;
		font-size: 10.5px;
		font-weight: 600;
		padding: 3px 9px 3px 7px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text-muted);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.conn::before {
		content: '●';
		font-size: 8px;
		color: var(--text-faint);
	}
	.conn.ok::before {
		color: var(--ok);
	}
	.conn.bad::before {
		color: var(--danger);
	}
	.sep {
		width: 1px;
		height: 22px;
		background: var(--border);
	}
	.spacer {
		flex: 1;
	}
	.chips {
		display: flex;
		gap: 4px;
	}
	.chips button {
		font: inherit;
		font-size: 12px;
		padding: 4px 8px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
		color: var(--text-mid);
	}
	.chips button.active {
		background: var(--chip-active-bg);
		border-color: var(--chip-active-bg);
		color: var(--chip-active-text);
		font-weight: 600;
	}
	.btn {
		font: inherit;
		font-size: 12px;
		padding: 5px 8px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
		color: var(--text-mid);
		list-style: none;
	}
	.btn:hover:not(:disabled) {
		background: var(--hover);
	}
	.btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.btn.active {
		background: var(--pto-active-bg);
		border-color: var(--pto-active-border);
		font-weight: 600;
	}
	.menu {
		position: relative;
	}
	.menu summary {
		display: inline-block;
	}
	.menu summary::-webkit-details-marker {
		display: none;
	}
	.dropdown {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		background: var(--panel);
		border-radius: 8px;
		box-shadow:
			0 0 0 1px var(--border),
			0 10px 28px rgba(0, 0, 0, 0.15);
		padding: 6px;
		display: flex;
		flex-direction: column;
		min-width: 200px;
		z-index: 20;
	}
	.dropdown button {
		font: inherit;
		font-size: 12.5px;
		text-align: left;
		padding: 7px 10px;
		border: none;
		background: none;
		border-radius: 6px;
		cursor: pointer;
		color: var(--text);
	}
	.dropdown button:hover {
		background: var(--hover);
	}
	.dropdown hr {
		border: none;
		border-top: 1px solid var(--border);
		margin: 4px 0;
	}
</style>
