<script lang="ts">
	import {
		detectEpicColorField,
		ensureStoryPointsFields,
		fetchChildIssuesRecursive,
		fetchIssueColor,
		fetchStoryPoints,
		issuesToTasks,
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
		if (jiraKey) void loadChildren(jiraKey);
		else resetChildren();
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
		inheritChildColors = true;
		resetChildren();
	});

	let jiraSuggestions = $state<JiraIssue[]>([]);
	let jiraOpen = $state(false);
	let jiraTimer: ReturnType<typeof setTimeout> | undefined;
	let jiraReq = 0;

	function onJiraInput() {
		jiraLookup = '';
		resetChildren();
		clearTimeout(jiraTimer);
		const query = jiraKey.trim();
		if (query.length < 2 || !settings.jiraConfigured()) {
			jiraSuggestions = [];
			jiraOpen = false;
			return;
		}
		const req = ++jiraReq;
		jiraTimer = setTimeout(async () => {
			// A pasted/typed-out key never goes through pickJira — fetch its children here.
			if (JIRA_KEY_RE.test(query)) void loadChildren(query);
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
		// A pending debounced lookup must not fire after the pick — it would
		// cancel this issue's children fetch in favor of the half-typed key.
		clearTimeout(jiraTimer);
		jiraReq++;
		jiraKey = issue.key;
		if (!name.trim()) name = issue.summary || issue.key;
		jiraLookup = `✓ ${issue.key}: ${issue.summary}`;
		jiraOpen = false;
		jiraSuggestions = [];
		void fillEstimateFromStoryPoints(issue.key);
		void fillColorFromJira(issue.key);
		void loadChildren(issue.key);
	}

	// ---- child work items: fetched when a Jira issue is set, reviewed before import ----

	const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
	/** The issue's whole descendant tree, in depth-first order. */
	let childIssues = $state<JiraIssue[]>([]);
	/** key → nesting depth under the typed issue (0 = direct child). */
	let childDepths = $state<Record<string, number>>({});
	/** key → import it; "Create" imports only the checked ones. */
	let childSel = $state<Record<string, boolean>>({});
	let childrenBusy = $state(false);
	let inheritChildColors = $state(true);
	/** Pin the estimate to Jira's full total instead of following the selection. */
	let keepOriginalEstimate = $state(false);
	/** The issue's own total from Jira (own SP, epics summing all children), in days. */
	let jiraTotalDays = $state<number | null>(null);
	let childReq = 0;

	/** Keys already linked in this plan — shown in the list but not importable again. */
	const linkedKeys = $derived(
		new Set(store.plan.tasks.filter((t) => t.jiraKey).map((t) => t.jiraKey!))
	);
	const childSelectedCount = $derived(childIssues.filter((c) => childSel[c.key]).length);

	const childByKey = $derived(new Map(childIssues.map((c) => [c.key, c])));
	/** Parent key → direct children, within the fetched set. */
	const childByParent = $derived.by(() => {
		const map = new Map<string, JiraIssue[]>();
		for (const c of childIssues) {
			if (!c.parentKey || !childByKey.has(c.parentKey)) continue;
			const list = map.get(c.parentKey) ?? [];
			list.push(c);
			map.set(c.parentKey, list);
		}
		return map;
	});

	/** True when an ancestor inside the set carries points (and is checked, if asked). */
	function spInAncestors(issue: JiraIssue, selectedOnly: boolean): boolean {
		let p = issue.parentKey ? childByKey.get(issue.parentKey) : undefined;
		while (p) {
			if (p.storyPoints && (!selectedOnly || childSel[p.key])) return true;
			p = p.parentKey ? childByKey.get(p.parentKey) : undefined;
		}
		return false;
	}

	/**
	 * Sum story points without double counting across levels: an issue counts
	 * only when no (checked) ancestor carries points of its own — a story's
	 * estimate already includes its subtasks'.
	 */
	function sumDays(include: (c: JiraIssue) => boolean, selectedOnly: boolean): number | null {
		let sum = 0;
		for (const c of childIssues) {
			if (!c.storyPoints || !include(c) || spInAncestors(c, selectedOnly)) continue;
			sum += c.storyPoints;
		}
		return sum > 0 ? storyPointsToDays(sum) : null;
	}

	/** The original total in days: Jira's own number, else the sum over ALL children. */
	const jiraFullTotal = $derived(jiraTotalDays ?? sumDays(() => true, false));
	/** Sum of the checked children's story points, in days. */
	const childSelectedDays = $derived(sumDays((c) => !!childSel[c.key], true));

	const childrenHaveSP = $derived(childIssues.some((c) => c.storyPoints));

	/** The estimate follows the selection — unless pinned to Jira's original total. */
	function applyEstimateFromChildren() {
		if (!childrenHaveSP) return; // children carry no points — nothing to derive
		estimate = keepOriginalEstimate ? jiraFullTotal : childSelectedDays;
	}

	function toggleChild(key: string) {
		const on = !childSel[key];
		childSel[key] = on;
		if (on) {
			// A checked child needs its ancestors to attach to — check them too,
			// stopping at ones already in the plan (the child attaches to those).
			for (let p = childByKey.get(key)?.parentKey; p && childByKey.has(p); ) {
				if (linkedKeys.has(p)) break;
				childSel[p] = true;
				p = childByKey.get(p)?.parentKey;
			}
		} else {
			// Unchecking a parent drops its whole subtree.
			const walk = (k: string) => {
				for (const c of childByParent.get(k) ?? []) {
					childSel[c.key] = false;
					walk(c.key);
				}
			};
			walk(key);
		}
		applyEstimateFromChildren();
	}

	function resetChildren() {
		childReq++;
		childIssues = [];
		childDepths = {};
		childSel = {};
		childrenBusy = false;
		keepOriginalEstimate = false;
		jiraTotalDays = null;
	}

	/** Orders fetched issues depth-first under the typed key (orphans fold to the top). */
	function treeOrder(children: JiraIssue[]): {
		ordered: JiraIssue[];
		depths: Record<string, number>;
	} {
		const keys = new Set(children.map((c) => c.key));
		const byParent = new Map<string, JiraIssue[]>();
		for (const c of children) {
			const p = c.parentKey && keys.has(c.parentKey) ? c.parentKey : '';
			const list = byParent.get(p) ?? [];
			list.push(c);
			byParent.set(p, list);
		}
		const ordered: JiraIssue[] = [];
		const depths: Record<string, number> = {};
		const walk = (parent: string, depth: number) => {
			for (const c of byParent.get(parent) ?? []) {
				ordered.push(c);
				depths[c.key] = depth;
				walk(c.key, depth + 1);
			}
		};
		walk('', 0);
		return { ordered, depths };
	}

	/** Fetches the issue's child work items, pre-selecting the ones not in the plan yet. */
	async function loadChildren(key: string) {
		resetChildren();
		if (editing || !key || !settings.jiraConfigured()) return;
		const req = ++childReq;
		childrenBusy = true;
		try {
			let spFields: string[] = [];
			if (settings.jira.useStoryPoints) {
				spFields = await ensureStoryPointsFields(settings.jira, (ids) =>
					settings.updateJira({ storyPointsField: ids })
				).catch(() => []);
			}
			const colorField = await detectEpicColorField(settings.jira);
			const children = await fetchChildIssuesRecursive(settings.jira, key, {
				storyPointsFields: spFields,
				epicColorField: colorField
			});
			if (req !== childReq || jiraKey.trim() !== key) return;
			const { ordered, depths } = treeOrder(children);
			childIssues = ordered;
			childDepths = depths;
			childSel = Object.fromEntries(
				ordered.filter((c) => !linkedKeys.has(c.key)).map((c) => [c.key, true])
			);
			applyEstimateFromChildren();
		} catch {
			// no children or Jira unreachable — nothing to review
		} finally {
			if (req === childReq) childrenBusy = false;
		}
	}

	function setAllChildren(value: boolean) {
		childSel = Object.fromEntries(
			childIssues.filter((c) => !linkedKeys.has(c.key)).map((c) => [c.key, value])
		);
		applyEstimateFromChildren();
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
				jiraTotalDays = proposed;
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

	/**
	 * Sum of the edited task's children's estimate rollups — what its own
	 * estimate should be after the children's sizes changed. Null when there is
	 * nothing to derive (new task, no children, or all children unestimated).
	 */
	const childEstimateSum = $derived.by(() => {
		if (!editing) return null;
		const children = store.childrenByParent.get(editing.id) ?? [];
		const sum = children.reduce((s, c) => s + store.subtreeEstimate(c.id), 0);
		return sum > 0 ? sum : null;
	});

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
		if (editing) {
			store.updateTask(editing.id, fields);
		} else {
			store.addTask(fields, continueId || undefined);
			if (fields.jiraKey) {
				if (childrenBusy) {
					// The child fetch hasn't landed yet — keep the default and import them all.
					void importChildWorkItems(fields.jiraKey);
				} else if (childSelectedCount) {
					// The parent task is in the plan by now — children attach to it by key.
					store.addTasks(
						issuesToTasks(
							childIssues.filter((c) => childSel[c.key]),
							store.plan.tasks,
							{ inheritParentColor: inheritChildColors }
						)
					);
				}
			}
		}
		close();
	}

	/** Fallback when "Create" lands before the children list finished loading. */
	async function importChildWorkItems(key: string) {
		if (!settings.jiraConfigured()) return;
		try {
			let spFields: string[] = [];
			if (settings.jira.useStoryPoints) {
				spFields = await ensureStoryPointsFields(settings.jira, (ids) =>
					settings.updateJira({ storyPointsField: ids })
				).catch(() => []);
			}
			const colorField = await detectEpicColorField(settings.jira);
			const children = await fetchChildIssuesRecursive(settings.jira, key, {
				storyPointsFields: spFields,
				epicColorField: colorField
			});
			// The parent task is in the plan by now — children attach to it by key
			// and inherit its color; already-linked keys are skipped.
			store.addTasks(issuesToTasks(treeOrder(children).ordered, store.plan.tasks));
		} catch {
			// Jira unreachable or no children — the task itself is already created
		}
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
						<option value={c.task.id}>{c.planName} · {c.path}</option>
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
		<div class="field">
			<span>Estimate (person-days)</span>
			<div class="est-row">
				<input type="number" min="1" bind:value={estimate} placeholder="optional" />
				{#if childEstimateSum != null}
					<button
						type="button"
						class="est-sum"
						class:stale={estimate !== childEstimateSum}
						title="Set the estimate to the sum of the children's estimates"
						onclick={() => (estimate = childEstimateSum)}
					>
						Σ children = {childEstimateSum}d
					</button>
				{/if}
			</div>
		</div>
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
		{#if !editing && (childrenBusy || childIssues.length)}
			<div class="field">
				<span class="children-head">
					Child work items
					{#if childrenBusy}
						<em>fetching…</em>
					{:else}
						<em>{childSelectedCount} of {childIssues.length} selected</em>
						<button type="button" class="mini" onclick={() => setAllChildren(true)}>All</button>
						<button type="button" class="mini" onclick={() => setAllChildren(false)}>None</button>
					{/if}
				</span>
				{#if childIssues.length}
					<div class="deps">
						{#each childIssues as c (c.key)}
							<label class="dep" style:padding-left="{(childDepths[c.key] ?? 0) * 18}px">
								<input
									type="checkbox"
									checked={!!childSel[c.key]}
									disabled={linkedKeys.has(c.key)}
									onchange={() => toggleChild(c.key)}
								/>
								<strong>{c.key}</strong>
								<span class="child-summary">{c.summary}</span>
								{#if linkedKeys.has(c.key)}
									<em>already in plan</em>
								{:else if c.storyPoints}
									<em>{c.storyPoints} SP</em>
								{/if}
							</label>
						{/each}
					</div>
					<label class="check">
						<input type="checkbox" bind:checked={inheritChildColors} />
						Children inherit this task's color
					</label>
					{#if childrenHaveSP}
						<label class="check">
							<input
								type="checkbox"
								bind:checked={keepOriginalEstimate}
								onchange={applyEstimateFromChildren}
							/>
							Keep the original total ({jiraFullTotal}d) as this task's estimate
						</label>
					{/if}
				{/if}
			</div>
		{/if}
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
		/* Long option texts (Jira paths) must not stretch the dialog — the
		   closed select truncates; its native dropdown list stays full-width. */
		width: 460px;
		max-width: 100%;
	}
	label,
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
		min-width: 0;
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
	select {
		width: 100%;
		min-width: 0;
		text-overflow: ellipsis;
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
	.est-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.est-row input {
		flex: 1;
		min-width: 0;
	}
	.est-sum {
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		padding: 5px 9px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text-mid);
		cursor: pointer;
		white-space: nowrap;
	}
	.est-sum:hover {
		background: var(--hover);
	}
	/* The children's sizes drifted from the stored estimate — nudge to refresh. */
	.est-sum.stale {
		color: var(--warn);
		border-color: var(--warn);
	}
	.children-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.children-head em,
	.dep em {
		font-weight: 400;
		font-style: normal;
		font-size: 11.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.mini {
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		padding: 0 4px;
		border: none;
		background: none;
		color: var(--accent);
		cursor: pointer;
	}
	.mini:hover {
		text-decoration: underline;
	}
	.dep strong {
		color: var(--accent);
		flex: none;
	}
	.child-summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dep:has(input:disabled) {
		opacity: 0.55;
	}
	.check {
		flex-direction: row;
		align-items: center;
		gap: 7px;
		font-weight: 500;
	}
	.check input {
		width: auto;
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
