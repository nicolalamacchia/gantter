import {
	buildJiraSyncUpdates,
	detectEpicColorField,
	ensureEndDateField,
	ensureStartDateField,
	ensureStoryPointsFields,
	fetchChildrenStoryPointSum,
	fetchIssuesByKeys,
	issueDateFields,
	pushIssueDates,
	pushIssueEstimate,
	pushIssueFields
} from '$lib/integrations/jira';
import { store } from './plan.svelte';
import { settings } from './settings.svelte';

export const SYNC_INTERVAL_MIN = 15;

class JiraSyncStore {
	busy = $state(false);
	/** Outcome of the last run, shown next to the setting. */
	lastOutcome = $state('');
}

export const jiraSync = new JiraSyncStore();

/**
 * One sync pass over the active plan's Jira-linked tasks. Conservative by
 * design (see buildJiraSyncUpdates): auto-generated names, the status note
 * and auto-assigned colors refresh; estimates are only filled when empty.
 */
export async function runJiraSync(taskIds?: string[]): Promise<void> {
	if (jiraSync.busy || !settings.jiraConfigured()) return;
	const wanted = taskIds ? new Set(taskIds) : null;
	const linked = store.plan.tasks.filter((t) => t.jiraKey && (!wanted || wanted.has(t.id)));
	if (!linked.length) {
		jiraSync.lastOutcome = 'No Jira-linked tasks in this period';
		return;
	}
	jiraSync.busy = true;
	try {
		let spFields: string[] = [];
		if (settings.jira.useStoryPoints) {
			try {
				spFields = await ensureStoryPointsFields(settings.jira, (ids) =>
					settings.updateJira({ storyPointsField: ids })
				);
			} catch {
				// site without story points — sync the rest
			}
		}
		const colorField = await detectEpicColorField(settings.jira);
		const issues = await fetchIssuesByKeys(
			settings.jira,
			linked.map((t) => t.jiraKey!),
			{ storyPointsFields: spFields, epicColorField: colorField }
		);
		if (spFields.length) {
			// Epics without own points: sum the children's, only to fill EMPTY estimates.
			const byKey = new Map(issues.map((i) => [i.key, i]));
			for (const task of linked) {
				const issue = byKey.get(task.jiraKey!);
				if (!issue || issue.storyPoints || task.estimateDays != null) continue;
				try {
					const sum = await fetchChildrenStoryPointSum(settings.jira, issue.key, spFields);
					if (sum > 0) issue.storyPoints = sum;
				} catch {
					// leave the estimate empty for this one
				}
			}
		}
		const updates = buildJiraSyncUpdates(linked, issues, {
			useStoryPoints: settings.jira.useStoryPoints
		});
		store.applySyncUpdates(updates);
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		jiraSync.lastOutcome =
			`✓ ${time} — ` +
			(updates.length
				? `${updates.length} task${updates.length === 1 ? '' : 's'} updated`
				: 'all in sync') +
			` (${issues.length}/${linked.length} issues checked)`;
	} catch (e) {
		jiraSync.lastOutcome = `✗ ${e instanceof Error ? e.message : 'Sync failed'}`;
	} finally {
		jiraSync.busy = false;
	}
}

/**
 * Pushes the board's data for the given linked tasks (or every linked task in
 * the plan) back to Jira: each task's scheduled start/end dates and — when
 * story points are enabled — its estimate as story points. One way, the board
 * is the source of truth. Returns a summary line.
 */
export async function runJiraPush(taskIds?: string[]): Promise<string> {
	if (jiraSync.busy) return 'A Jira operation is already running';
	if (!settings.jiraConfigured()) return '✗ Configure Jira in Settings first';
	const wanted = taskIds ? new Set(taskIds) : null;
	const linked = store.plan.tasks.filter((t) => t.jiraKey && (!wanted || wanted.has(t.id)));
	if (!linked.length) return '✗ No Jira-linked tasks to push';
	jiraSync.busy = true;
	try {
		const startField = await ensureStartDateField(settings.jira, (fieldId) =>
			settings.updateJira({ startDateField: fieldId })
		).catch(() => null);
		const endField = await ensureEndDateField(settings.jira, (fieldId) =>
			settings.updateJira({ endDateField: fieldId })
		).catch(() => null);
		let spFields: string[] = [];
		if (settings.jira.useStoryPoints) {
			spFields = await ensureStoryPointsFields(settings.jira, (ids) =>
				settings.updateJira({ storyPointsField: ids })
			).catch(() => []);
		}
		let dates = 0;
		let estimates = 0;
		const failures: string[] = [];
		// Dates + estimate go out as ONE PUT with the best story-points candidate;
		// if that write is rejected (wrong field for this project type), it splits
		// into dates alone + per-field estimate retries, so a bad points field can
		// never sink the dates. The field that sticks leads every later write.
		let provenSpField: string | null = spFields[0] ?? null;
		for (const task of linked) {
			const rollup = store.schedule.rollups[task.id];
			const dateRange =
				rollup?.startDate && rollup.endDate
					? {
							startDate: rollup.startDate,
							endDate: rollup.endDate,
							startDateField: startField,
							endDateField: endField
						}
					: null;
			const storyPoints =
				spFields.length && task.estimateDays != null ? Math.round(task.estimateDays) : null;
			try {
				let combined = false;
				if (dateRange && storyPoints != null && provenSpField) {
					try {
						await pushIssueFields(settings.jira, task.jiraKey!, {
							...issueDateFields(dateRange),
							[provenSpField]: storyPoints
						});
						combined = true;
					} catch {
						// split below — and re-prove the points field for this issue type
					}
				}
				if (combined) {
					dates++;
					estimates++;
					continue;
				}
				if (dateRange) {
					await pushIssueDates(settings.jira, task.jiraKey!, dateRange);
					dates++;
				}
				if (storyPoints != null) {
					const ordered = provenSpField
						? [provenSpField, ...spFields.filter((f) => f !== provenSpField)]
						: spFields;
					provenSpField = await pushIssueEstimate(
						settings.jira,
						task.jiraKey!,
						storyPoints,
						ordered
					);
					estimates++;
				}
			} catch (e) {
				failures.push(`${task.jiraKey}: ${e instanceof Error ? e.message : 'failed'}`);
			}
		}
		const parts = [`${dates} date range${dates === 1 ? '' : 's'}`];
		if (spFields.length) parts.push(`${estimates} estimate${estimates === 1 ? '' : 's'}`);
		const summary =
			(failures.length ? '⚠' : '✓') +
			` Pushed ${parts.join(' and ')} to Jira` +
			(startField ? '' : ' (no Target start/Start date field on this site — only end dates set)') +
			(failures.length ? ` · ✗ ${failures.join(' · ')}` : '');
		jiraSync.lastOutcome = summary;
		return summary;
	} catch (e) {
		const message = `✗ ${e instanceof Error ? e.message : 'Push failed'}`;
		jiraSync.lastOutcome = message;
		return message;
	} finally {
		jiraSync.busy = false;
	}
}

/**
 * Runs a sync on load and every SYNC_INTERVAL_MIN minutes — only while the
 * (off-by-default) auto-sync setting is enabled. Returns a stop function.
 */
export function startJiraAutoSync(): () => void {
	const tick = () => {
		if (settings.jira.autoSync) void runJiraSync();
	};
	tick();
	const interval = setInterval(tick, SYNC_INTERVAL_MIN * 60_000);
	return () => clearInterval(interval);
}
