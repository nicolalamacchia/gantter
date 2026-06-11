<script lang="ts">
	import {
		detectEpicColorField,
		ensureStoryPointsFields,
		fetchChildIssues,
		issuesToTasks,
		jiraSearch,
		type JiraIssue
	} from '$lib/integrations/jira';
	import { store } from '$lib/state/plan.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import Modal from './Modal.svelte';

	let jql = $state('');
	let busy = $state(false);
	let status = $state('');
	let inheritColors = $state(true);

	function close() {
		ui.jiraImportOpen = false;
	}

	async function importFromJira() {
		if (!jql.trim()) return;
		busy = true;
		status = '';
		try {
			let spFields: string[] = [];
			let spNote = '';
			if (settings.jira.useStoryPoints) {
				try {
					spFields = await ensureStoryPointsFields(settings.jira, (fieldIds) =>
						settings.updateJira({ storyPointsField: fieldIds })
					);
				} catch (e) {
					spNote = ` · ✗ ${e instanceof Error ? e.message : 'story points unavailable'}`;
				}
			}
			const colorField = await detectEpicColorField(settings.jira);
			const issues = await jiraSearch(settings.jira, jql.trim(), 50, {
				storyPointsFields: spFields,
				epicColorField: colorField
			});
			// Each matching issue brings its child work items along (epic → stories);
			// they become child tasks carrying their own story-point estimates.
			const seen = new Set(issues.map((i) => i.key));
			const children: JiraIssue[] = [];
			for (const issue of issues) {
				try {
					for (const child of await fetchChildIssues(settings.jira, issue.key, {
						storyPointsFields: spFields,
						epicColorField: colorField
					})) {
						if (!seen.has(child.key)) {
							seen.add(child.key);
							children.push(child);
						}
					}
				} catch {
					// children unavailable for this one — the issue itself still imports
				}
			}
			const fetched = [...issues, ...children];
			const tasks = issuesToTasks(fetched, store.plan.tasks, {
				inheritParentColor: inheritColors
			});
			const added = store.addTasks(tasks);
			const childCount = tasks.filter((t) => t.parentId).length;
			const skipped = fetched.length - tasks.length;
			const estimated = tasks.filter((t) => t.estimateDays).length;
			const colored = tasks.filter(
				(t) => !t.parentId && issues.some((i) => i.key === t.jiraKey && i.color)
			).length;
			status =
				`✓ ${added} task${added === 1 ? '' : 's'} imported` +
				(childCount ? ` (${childCount} child work item${childCount === 1 ? '' : 's'})` : '') +
				(spFields.length
					? ` · ${estimated} estimate${estimated === 1 ? '' : 's'} from story points`
					: '') +
				(colored ? ` · ${colored} color${colored === 1 ? '' : 's'} from Jira` : '') +
				(skipped ? ` · ${skipped} already linked` : '') +
				spNote;
		} catch (e) {
			status = `✗ ${e instanceof Error ? e.message : 'Import failed'}`;
		} finally {
			busy = false;
		}
	}
</script>

<Modal open={ui.jiraImportOpen} title="Import tasks from Jira" onclose={close}>
	<div class="body">
		{#if !settings.jiraConfigured()}
			<p class="help warn">Configure the Jira connection in Settings first.</p>
		{/if}
		<p class="help">
			Every matching issue becomes a task linked to its Jira key, and brings its child work items
			along as child tasks. Epic colors become task colors when the site exposes them.
			{#if settings.jira.useStoryPoints}
				Story points fill the estimates — 1 SP = 1 person-day, epics summing their children.
			{:else}
				Tip: enable “Use story points as estimates” in Settings to fill estimates on import.
			{/if}
		</p>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				importFromJira();
			}}
		>
			<label>
				JQL query
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					autofocus
					placeholder="project = VULN AND type = Epic AND statusCategory != Done"
					bind:value={jql}
				/>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={inheritColors} />
				Child work items inherit their parent's color
			</label>
			<div class="row">
				<button type="submit" disabled={busy || !jql.trim() || !settings.jiraConfigured()}>
					{busy ? 'Importing…' : 'Import'}
				</button>
				<span class="status" class:err={status.startsWith('✗')}>{status}</span>
			</div>
		</form>
	</div>
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
		min-width: 420px;
	}
	.help {
		color: var(--text-muted);
		margin: 0 0 6px;
		line-height: 1.45;
	}
	.help.warn {
		color: var(--warn);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
		margin-bottom: 10px;
	}
	input {
		font: inherit;
		font-weight: 400;
		padding: 6px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		width: 100%;
	}
	.check {
		flex-direction: row;
		align-items: center;
		gap: 8px;
		font-weight: 500;
	}
	.check input {
		width: auto;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	button {
		font: inherit;
		font-size: 12px;
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:not(:disabled) {
		background: var(--hover);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.status {
		font-size: 12px;
		color: var(--ok);
	}
	.status.err {
		color: var(--danger);
	}
</style>
