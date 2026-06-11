<script lang="ts">
	import {
		ensureStoryPointsFields,
		fetchIssueColor,
		fetchStoryPoints,
		jiraPickIssues,
		storyPointsToDays,
		type JiraIssue
	} from '$lib/integrations/jira';
	import { PALETTE, nextColor } from '$lib/model/colors';
	import type { Task } from '$lib/model/types';
	import { store } from '$lib/state/plan.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import Modal from './Modal.svelte';

	let name = $state('');
	let color = $state(PALETTE[0]);
	let parentId = $state('');
	let groupId = $state('');
	let estimate = $state<number | null>(null);
	let notes = $state('');
	let dependsOn = $state<string[]>([]);
	let jiraKey = $state('');
	let jiraLookup = $state('');
	let continueId = $state('');

	/** Tasks from other periods this one could continue (same identity). */
	const continueChoices = $derived(
		ui.taskDialog.open && !ui.taskDialog.taskId ? store.registryTaskChoices() : []
	);

	function prefillContinuation() {
		const choice = continueChoices.find((c) => c.task.id === continueId);
		if (!choice) return;
		const t = choice.task;
		name = t.name;
		color = t.color;
		groupId = t.groupId ?? '';
		estimate = t.estimateDays ?? null;
		jiraKey = t.jiraKey ?? '';
	}

	const editing = $derived(
		ui.taskDialog.taskId ? store.tasksById.get(ui.taskDialog.taskId) : undefined
	);

	$effect(() => {
		if (!ui.taskDialog.open) return;
		const t = editing;
		name = t?.name ?? '';
		color = t?.color ?? nextColor(store.plan.tasks.map((t) => t.color));
		parentId = t?.parentId ?? ui.taskDialog.parentId ?? '';
		groupId = t?.groupId ?? '';
		estimate = t?.estimateDays ?? null;
		notes = t?.notes ?? '';
		dependsOn = t?.dependsOn ? [...t.dependsOn] : [];
		jiraKey = t?.jiraKey ?? '';
		jiraLookup = '';
		continueId = '';
	});

	let jiraSuggestions = $state<JiraIssue[]>([]);
	let jiraOpen = $state(false);
	let jiraTimer: ReturnType<typeof setTimeout> | undefined;
	let jiraReq = 0;

	function onJiraInput() {
		jiraLookup = '';
		clearTimeout(jiraTimer);
		const query = jiraKey.trim();
		if (query.length < 2 || !settings.jiraConfigured()) {
			jiraSuggestions = [];
			jiraOpen = false;
			return;
		}
		const req = ++jiraReq;
		jiraTimer = setTimeout(async () => {
			try {
				const issues = await jiraPickIssues(settings.jira, query);
				if (req !== jiraReq) return;
				jiraSuggestions = issues;
				jiraOpen = issues.length > 0;
				if (!issues.length) jiraLookup = 'No matching issues';
			} catch (e) {
				if (req !== jiraReq) return;
				jiraLookup = `✗ ${e instanceof Error ? e.message : 'Search failed'}`;
			}
		}, 300);
	}

	function pickJira(issue: JiraIssue) {
		jiraKey = issue.key;
		if (!name.trim()) name = `${issue.key} · ${issue.summary}`;
		jiraLookup = `✓ ${issue.key}: ${issue.summary}`;
		jiraOpen = false;
		jiraSuggestions = [];
		void fillEstimateFromStoryPoints(issue.key);
		void fillColorFromJira(issue.key);
	}

	/** Epics carry a color in Jira — adopt it so the board matches the Jira board. */
	async function fillColorFromJira(key: string) {
		if (!settings.jiraConfigured()) return;
		try {
			const hex = await fetchIssueColor(settings.jira, key);
			if (hex && jiraKey === key) {
				color = hex;
				jiraLookup += ' · color from Jira';
			}
		} catch {
			// keep the palette color
		}
	}

	/** When enabled in Settings: 1 SP = 1 person-day, epics summing their children. */
	async function fillEstimateFromStoryPoints(key: string) {
		if (!settings.jira.useStoryPoints || !settings.jiraConfigured()) return;
		try {
			const fieldIds = await ensureStoryPointsFields(settings.jira, (ids) =>
				settings.updateJira({ storyPointsField: ids })
			);
			const sp = await fetchStoryPoints(settings.jira, key, fieldIds);
			if (sp && jiraKey === key) {
				const proposed = storyPointsToDays(sp);
				if (estimate == null) {
					estimate = proposed;
					jiraLookup += ` · ${sp} SP → ${proposed}d`;
				} else if (estimate !== proposed) {
					// Never overwrite an existing size silently — just surface the difference.
					jiraLookup += ` · ${sp} SP (${proposed}d ≠ current ${estimate}d)`;
				}
			}
		} catch {
			// no story points — leave the estimate as-is
		}
	}

	/** Tasks that may serve as parent: anything except the edited task and its subtree. */
	const parentOptions = $derived.by(() => {
		const excluded = new Set<string>();
		if (editing) {
			excluded.add(editing.id);
			const walk = (id: string) => {
				for (const c of store.childrenByParent.get(id) ?? []) {
					excluded.add(c.id);
					walk(c.id);
				}
			};
			walk(editing.id);
		}
		return store.plan.tasks.filter((t) => !excluded.has(t.id));
	});

	/**
	 * Valid dependency targets: everything except the edited task itself, its
	 * subtree, its ancestors, and tasks that already (transitively) depend on
	 * it — so the dialog can never create a cycle.
	 */
	const depOptions = $derived.by(() => {
		const excluded = new Set<string>();
		if (editing) {
			excluded.add(editing.id);
			const walkDown = (id: string) => {
				for (const c of store.childrenByParent.get(id) ?? []) {
					excluded.add(c.id);
					walkDown(c.id);
				}
			};
			walkDown(editing.id);
			for (let p = editing.parentId; p; p = store.tasksById.get(p)?.parentId) excluded.add(p);
			const dependsOnTarget = (t: Task, seen = new Set<string>()): boolean => {
				if (seen.has(t.id)) return false;
				seen.add(t.id);
				return (t.dependsOn ?? []).some((d) => {
					if (d === editing.id) return true;
					const dep = store.tasksById.get(d);
					return dep ? dependsOnTarget(dep, seen) : false;
				});
			};
			for (const t of store.plan.tasks) if (dependsOnTarget(t)) excluded.add(t.id);
		}
		return store.plan.tasks.filter((t) => !excluded.has(t.id));
	});

	function depLabel(t: Task): string {
		return store.taskPath(t.id);
	}

	function toggleDep(id: string) {
		dependsOn = dependsOn.includes(id) ? dependsOn.filter((d) => d !== id) : [...dependsOn, id];
	}

	function close() {
		ui.taskDialog = { open: false };
	}

	function save() {
		if (!name.trim()) return;
		const fields = {
			name: name.trim(),
			color,
			parentId: parentId || undefined,
			groupId: groupId || undefined,
			estimateDays: estimate ?? undefined,
			notes: notes.trim() || undefined,
			dependsOn: dependsOn.length ? [...dependsOn] : undefined,
			jiraKey: jiraKey.trim() || undefined
		};
		if (editing) store.updateTask(editing.id, fields);
		else store.addTask(fields, continueId || undefined);
		close();
	}

	function remove() {
		if (!editing) return;
		if (confirm(`Delete "${editing.name}", its workstreams and all their assignments?`)) {
			store.removeTask(editing.id);
			close();
		}
	}
</script>

<Modal open={ui.taskDialog.open} title={editing ? 'Edit task' : 'New task'} onclose={close}>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		{#if !editing && continueChoices.length}
			<label>
				Continue a task from another period
				<select bind:value={continueId} onchange={prefillContinuation}>
					<option value="">— no, this is a brand-new task —</option>
					{#each continueChoices as c (c.task.id)}
						<option value={c.task.id}>{c.planName} · {c.task.name}</option>
					{/each}
				</select>
			</label>
		{/if}
		<label>
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				bind:value={name}
				required
				autofocus
				placeholder="e.g. Checkout Redesign"
			/>
		</label>
		<div class="field">
			<span>Color</span>
			<div class="palette">
				{#each PALETTE as c (c)}
					<button
						type="button"
						class="swatch"
						class:selected={c === color}
						style:background={c}
						onclick={() => (color = c)}
						aria-label="color {c}"
					></button>
				{/each}
				<input
					type="color"
					class="swatch custom"
					class:selected={!PALETTE.includes(color)}
					bind:value={color}
					title="Custom color…"
					aria-label="Custom color"
				/>
			</div>
		</div>
		<div class="grid2">
			<label>
				Parent task
				<select bind:value={parentId}>
					<option value="">— none (top-level) —</option>
					{#each parentOptions as t (t.id)}
						<option value={t.id}>{store.taskPath(t.id)}</option>
					{/each}
				</select>
			</label>
			<label>
				Sub-team
				<select bind:value={groupId}>
					<option value="">— any —</option>
					{#each store.plan.groups as g (g.id)}
						<option value={g.id}>{g.name}</option>
					{/each}
				</select>
			</label>
		</div>
		<label>
			Estimate (person-days)
			<input type="number" min="1" bind:value={estimate} placeholder="optional" />
		</label>
		<div class="field">
			<span>Jira issue</span>
			<div class="jira-box">
				<input
					type="text"
					placeholder={settings.jiraConfigured()
						? 'Type to search Jira, or paste a key'
						: 'e.g. VULN-123 (configure Jira in Settings for search)'}
					bind:value={jiraKey}
					oninput={onJiraInput}
					onfocusout={() => setTimeout(() => (jiraOpen = false), 150)}
				/>
				{#if jiraOpen}
					<ul class="jira-suggest">
						{#each jiraSuggestions as issue (issue.key)}
							<li>
								<button
									type="button"
									onmousedown={(e) => {
										e.preventDefault();
										pickJira(issue);
									}}
								>
									<strong>{issue.key}</strong>
									{issue.summary}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if jiraLookup}
				<span class="lookup" class:err={jiraLookup.startsWith('✗')}>{jiraLookup}</span>
			{/if}
		</div>
		{#if depOptions.length}
			<div class="field">
				<span>Depends on (must finish first)</span>
				<div class="deps">
					{#each depOptions as t (t.id)}
						<label class="dep">
							<input
								type="checkbox"
								checked={dependsOn.includes(t.id)}
								onchange={() => toggleDep(t.id)}
							/>
							<span class="dep-swatch" style:background={t.color}></span>
							{depLabel(t)}
						</label>
					{/each}
				</div>
			</div>
		{/if}
		<label>
			Notes
			<textarea rows="2" bind:value={notes}></textarea>
		</label>
		<footer>
			{#if editing}
				<button type="button" class="danger" onclick={remove}>Delete</button>
			{/if}
			<span class="spacer"></span>
			<button type="button" onclick={close}>Cancel</button>
			<button type="submit" class="primary">{editing ? 'Save' : 'Create'}</button>
		</footer>
	</form>
</Modal>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-size: 12.5px;
	}
	label,
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
	}
	input,
	select,
	textarea {
		font: inherit;
		font-weight: 400;
		padding: 6px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.palette {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.deps {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 132px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 8px;
	}
	.dep {
		flex-direction: row;
		align-items: center;
		gap: 7px;
		font-weight: 400;
		color: var(--text);
	}
	.dep-swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex: none;
		border: 1px solid rgba(0, 0, 0, 0.1);
	}
	.jira-box {
		position: relative;
	}
	.jira-suggest {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 10;
		background: var(--panel);
		border-radius: 8px;
		box-shadow:
			0 0 0 1px var(--border),
			0 10px 24px rgba(0, 0, 0, 0.18);
		list-style: none;
		margin: 4px 0 0;
		padding: 4px;
		max-height: 200px;
		overflow-y: auto;
	}
	.jira-suggest button {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 6px 8px;
		border-radius: 6px;
		font: inherit;
		font-weight: 400;
		color: var(--text);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.jira-suggest button:hover {
		background: var(--hover);
	}
	.jira-suggest strong {
		color: var(--accent);
	}
	.lookup {
		font-weight: 400;
		font-size: 11.5px;
		color: var(--ok);
	}
	.lookup.err {
		color: var(--danger);
	}
	.swatch {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		border: 1px solid rgba(0, 0, 0, 0.12);
		cursor: pointer;
	}
	.swatch.selected {
		outline: 2px solid var(--text);
		outline-offset: 1px;
	}
	/* Custom color: a conic-gradient ring frames the currently picked value. */
	.swatch.custom {
		padding: 0;
		background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
	}
	.swatch.custom::-webkit-color-swatch-wrapper {
		padding: 3px;
	}
	.swatch.custom::-webkit-color-swatch {
		border: none;
		border-radius: 3px;
	}
	footer {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 4px;
	}
	.spacer {
		flex: 1;
	}
	footer button {
		font: inherit;
		font-size: 12.5px;
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	.primary:hover {
		background: var(--accent-hover);
	}
	.danger {
		color: var(--danger);
		border-color: var(--danger-border);
	}
</style>
