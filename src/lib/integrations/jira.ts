import { newId, type Task } from '$lib/model/types';
import type { JiraSettings } from '$lib/state/settings.svelte';
import { nextColor, PALETTE } from '$lib/model/colors';

export interface JiraIssue {
	key: string;
	summary: string;
	status?: string;
	parentKey?: string;
	storyPoints?: number;
	/** Hex color mapped from the issue's epic color, when the site exposes one. */
	color?: string;
}

let jiraListener: ((ok: boolean) => void) | null = null;

/** The UI mirrors connectivity from real call outcomes through this. */
export function setJiraListener(listener: (ok: boolean) => void) {
	jiraListener = listener;
}

function headers(cfg: JiraSettings): Record<string, string> {
	return {
		'x-jira-base-url': cfg.baseUrl,
		'x-jira-email': cfg.email,
		'x-jira-token': cfg.token
	};
}

async function jiraGet(cfg: JiraSettings, path: string, params: Record<string, string>) {
	const search = new URLSearchParams(params);
	const res = await fetch(`/api/jira/${path}?${search}`, { headers: headers(cfg) });
	const body = await res.json().catch(() => ({}));
	jiraListener?.(res.ok);
	if (!res.ok) {
		const message =
			body?.error ?? body?.errorMessages?.join('; ') ?? `Jira responded with ${res.status}`;
		throw new Error(message);
	}
	return body;
}

async function jiraPut(cfg: JiraSettings, path: string, body: unknown): Promise<void> {
	const res = await fetch(`/api/jira/${path}`, {
		method: 'PUT',
		headers: { ...headers(cfg), 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	jiraListener?.(res.ok);
	if (!res.ok) {
		const parsed = await res.json().catch(() => ({}));
		throw new Error(
			parsed?.error ?? parsed?.errorMessages?.join('; ') ?? `Jira responded with ${res.status}`
		);
	}
}

/** Verifies credentials; returns the display name of the authenticated user. */
export async function jiraTestConnection(cfg: JiraSettings): Promise<string> {
	const me = await jiraGet(cfg, 'api/3/myself', {});
	return me.displayName ?? me.emailAddress ?? 'OK';
}

interface RawIssue {
	key: string;
	fields?: {
		summary?: string;
		status?: { name?: string };
		parent?: { key?: string };
		[customField: string]: unknown;
	};
}

function rawStoryPoints(issue: RawIssue, fieldIds?: string[]): number | undefined {
	for (const fieldId of fieldIds ?? []) {
		const value = issue.fields?.[fieldId];
		if (typeof value === 'number' && value > 0) return value;
	}
	return undefined;
}

/** Runs a JQL search and returns lightweight issues. */
export async function jiraSearch(
	cfg: JiraSettings,
	jql: string,
	maxResults = 50,
	opts: { storyPointsFields?: string[]; epicColorField?: string | null } = {}
): Promise<JiraIssue[]> {
	const extra = [...(opts.storyPointsFields ?? [])];
	if (opts.epicColorField) extra.push(opts.epicColorField);
	const body = await jiraGet(cfg, 'api/3/search/jql', {
		jql,
		fields: ['summary', 'status', 'parent', ...extra].join(','),
		maxResults: String(maxResults)
	});
	return ((body.issues ?? []) as RawIssue[]).map((issue) => toIssue(issue, opts));
}

function toIssue(
	issue: RawIssue,
	opts: { storyPointsFields?: string[]; epicColorField?: string | null }
): JiraIssue {
	return {
		key: issue.key,
		summary: issue.fields?.summary ?? '',
		status: issue.fields?.status?.name,
		parentKey: issue.fields?.parent?.key,
		storyPoints: rawStoryPoints(issue, opts.storyPointsFields),
		color: opts.epicColorField ? jiraColorToHex(issue.fields?.[opts.epicColorField]) : undefined
	};
}

/** Fetches a single issue by key. */
export async function jiraIssue(
	cfg: JiraSettings,
	key: string,
	opts: { storyPointsFields?: string[]; epicColorField?: string | null } = {}
): Promise<JiraIssue> {
	const extra = [...(opts.storyPointsFields ?? [])];
	if (opts.epicColorField) extra.push(opts.epicColorField);
	const issue = (await jiraGet(cfg, `api/3/issue/${encodeURIComponent(key.trim())}`, {
		fields: ['summary', 'status', 'parent', ...extra].join(',')
	})) as RawIssue;
	return toIssue(issue, opts);
}

/** Fetches many issues by key, chunked; unknown/deleted keys are skipped quietly. */
export async function fetchIssuesByKeys(
	cfg: JiraSettings,
	keys: string[],
	opts: { storyPointsFields?: string[]; epicColorField?: string | null } = {}
): Promise<JiraIssue[]> {
	const out: JiraIssue[] = [];
	for (let i = 0; i < keys.length; i += 50) {
		const chunk = keys.slice(i, i + 50);
		try {
			const jql = `key in (${chunk.map((k) => `"${k}"`).join(', ')})`;
			out.push(...(await jiraSearch(cfg, jql, chunk.length, opts)));
		} catch {
			// One deleted key fails the whole JQL — fall back to issue-by-issue.
			for (const key of chunk) {
				try {
					out.push(await jiraIssue(cfg, key, opts));
				} catch {
					// gone or inaccessible — skip
				}
			}
		}
	}
	return out;
}

interface PickerSection {
	issues?: Array<{ key?: string; summaryText?: string; summary?: string }>;
}

/** Fast autocomplete via Jira's purpose-built issue picker. */
export async function jiraPickIssues(
	cfg: JiraSettings,
	query: string,
	max = 10
): Promise<JiraIssue[]> {
	const body = await jiraGet(cfg, 'api/3/issue/picker', { query });
	const seen = new Set<string>();
	const out: JiraIssue[] = [];
	for (const section of (body.sections ?? []) as PickerSection[]) {
		for (const issue of section.issues ?? []) {
			if (!issue.key || seen.has(issue.key)) continue;
			seen.add(issue.key);
			out.push({
				key: issue.key,
				// summaryText contains <b> highlight markup — strip it.
				summary: (issue.summaryText ?? issue.summary ?? '').replace(/<[^>]+>/g, '')
			});
			if (out.length >= max) return out;
		}
	}
	return out;
}

export function jiraIssueUrl(cfg: JiraSettings, key: string): string {
	return `${cfg.baseUrl.replace(/\/+$/, '')}/browse/${key}`;
}

// ---- field detection ------------------------------------------------------------

interface JiraField {
	id?: string;
	name?: string;
	schema?: { custom?: string };
}

let fieldCache: { baseUrl: string; fields: JiraField[] } | null = null;

/** The site's field list, fetched once per session (several detectors need it). */
async function listFields(cfg: JiraSettings): Promise<JiraField[]> {
	if (fieldCache?.baseUrl === cfg.baseUrl) return fieldCache.fields;
	const fields = (await jiraGet(cfg, 'api/3/field', {})) as JiraField[];
	fieldCache = { baseUrl: cfg.baseUrl, fields };
	return fields;
}

// ---- story points -------------------------------------------------------------

/**
 * All plausible story-points fields, most likely first. Jira sites routinely
 * have TWO ("Story Points" for company-managed projects, "Story point
 * estimate" for team-managed ones) and either may hold the value, so every
 * candidate is checked when reading an issue — picking just one silently
 * misses the points of half the projects.
 */
export function pickStoryPointsFields(fields: JiraField[]): string[] {
	const rank = (f: JiraField) =>
		/^story points$/i.test(f.name ?? '') ? 0 : /^story point estimate$/i.test(f.name ?? '') ? 1 : 2;
	return fields
		.filter((f) => f.id && /story\s*points?/i.test(f.name ?? ''))
		.sort((a, b) => rank(a) - rank(b))
		.map((f) => f.id!);
}

/**
 * Candidate story-points field ids, re-detected from the live field list each
 * session and mirrored into settings as a comma-separated fallback for when
 * the field list cannot be fetched.
 */
export async function ensureStoryPointsFields(
	cfg: JiraSettings,
	save: (fieldIds: string) => void
): Promise<string[]> {
	try {
		const ids = pickStoryPointsFields(await listFields(cfg));
		if (ids.length) {
			save(ids.join(','));
			return ids;
		}
	} catch {
		const cached = (cfg.storyPointsField ?? '').split(',').filter(Boolean);
		if (cached.length) return cached;
	}
	throw new Error('No "Story Points" field found on this Jira site');
}

// ---- epic colors ----------------------------------------------------------------

/** Jira epic color values → hex: classic ghx-labels, agile color_N keys, names. */
const JIRA_EPIC_COLORS: Record<string, string> = {
	'ghx-label-1': '#815b3a',
	'ghx-label-2': '#f79232',
	'ghx-label-3': '#d39c3f',
	'ghx-label-4': '#3b7fc4',
	'ghx-label-5': '#4a6785',
	'ghx-label-6': '#8eb021',
	'ghx-label-7': '#ac707a',
	'ghx-label-8': '#654982',
	'ghx-label-9': '#f15c75',
	'ghx-label-10': '#205081',
	'ghx-label-11': '#59afe1',
	'ghx-label-12': '#60646d',
	'ghx-label-13': '#14892c',
	'ghx-label-14': '#d04437',
	color_1: '#8777d9',
	color_2: '#2684ff',
	color_3: '#57d9a3',
	color_4: '#00c7e6',
	color_5: '#ffc400',
	color_6: '#ff7452',
	color_7: '#6b778c',
	color_8: '#5243aa',
	color_9: '#0747a6',
	color_10: '#00875a',
	color_11: '#00a3bf',
	color_12: '#ff991f',
	color_13: '#de350b',
	color_14: '#253858',
	purple: '#8777d9',
	blue: '#2684ff',
	green: '#57d9a3',
	teal: '#00c7e6',
	yellow: '#ffc400',
	orange: '#ff7452',
	grey: '#6b778c',
	gray: '#6b778c',
	dark_purple: '#5243aa',
	dark_blue: '#0747a6',
	dark_green: '#00875a',
	dark_teal: '#00a3bf',
	dark_yellow: '#ff991f',
	dark_orange: '#de350b',
	dark_grey: '#253858',
	dark_gray: '#253858'
};

/** Best-effort mapping of a Jira epic-color value to a hex color. */
export function jiraColorToHex(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const raw = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
	return JIRA_EPIC_COLORS[raw.replace(/\s+/g, '_')];
}

/** The field holding the epic color (id differs per site; team-managed sites may lack it). */
export function pickEpicColorField(fields: JiraField[]): string | null {
	return (
		fields.find((f) => f.id && f.schema?.custom?.endsWith(':gh-epic-color'))?.id ??
		fields.find((f) => f.id && /^epic colou?r$/i.test(f.name ?? ''))?.id ??
		null
	);
}

/** The site's epic-color field id, or null when unavailable (palette colors are used then). */
export async function detectEpicColorField(cfg: JiraSettings): Promise<string | null> {
	try {
		return pickEpicColorField(await listFields(cfg));
	} catch {
		return null;
	}
}

/** A single issue's epic color as hex, when the site exposes one. */
export async function fetchIssueColor(cfg: JiraSettings, key: string): Promise<string | undefined> {
	const fieldId = await detectEpicColorField(cfg);
	if (!fieldId) return undefined;
	const issue = (await jiraGet(cfg, `api/3/issue/${encodeURIComponent(key.trim())}`, {
		fields: fieldId
	})) as RawIssue;
	return jiraColorToHex(issue.fields?.[fieldId]);
}

/** 1 SP = 1 person-day. */
export function storyPointsToDays(storyPoints: number): number {
	return Math.max(1, Math.round(storyPoints));
}

export function pickStartDateField(fields: JiraField[]): string | null {
	return fields.find((f) => f.id && /^start\s*date$/i.test(f.name ?? ''))?.id ?? null;
}

/** Cached "Start date" field id; null when the site has none (then only due dates are pushed). */
export async function ensureStartDateField(
	cfg: JiraSettings,
	save: (fieldId: string) => void
): Promise<string | null> {
	if (cfg.startDateField) return cfg.startDateField;
	const fieldId = pickStartDateField(await listFields(cfg));
	if (fieldId) save(fieldId);
	return fieldId;
}

/** Writes the schedule's dates onto the issue: due date + start date (board → Jira, one way). */
export async function pushIssueDates(
	cfg: JiraSettings,
	key: string,
	dates: { startDate: string; endDate: string; startDateField?: string | null }
): Promise<void> {
	const fields: Record<string, unknown> = { duedate: dates.endDate };
	if (dates.startDateField) fields[dates.startDateField] = dates.startDate;
	await jiraPut(cfg, `api/3/issue/${encodeURIComponent(key.trim())}`, { fields });
}

/** Sum of the children's story points (epic → its issues). */
export async function fetchChildrenStoryPointSum(
	cfg: JiraSettings,
	key: string,
	fieldIds: string[]
): Promise<number> {
	const body = await jiraGet(cfg, 'api/3/search/jql', {
		jql: `parent = "${key}"`,
		fields: fieldIds.join(','),
		maxResults: '200'
	});
	let sum = 0;
	for (const issue of (body.issues ?? []) as RawIssue[]) {
		sum += rawStoryPoints(issue, fieldIds) ?? 0;
	}
	return sum;
}

/** An issue's own story points, falling back to the sum of its children (epics). */
export async function fetchStoryPoints(
	cfg: JiraSettings,
	key: string,
	fieldIds: string[]
): Promise<number | null> {
	const issue = (await jiraGet(cfg, `api/3/issue/${encodeURIComponent(key.trim())}`, {
		fields: fieldIds.join(',')
	})) as RawIssue;
	const own = rawStoryPoints(issue, fieldIds);
	if (own) return own;
	const childSum = await fetchChildrenStoryPointSum(cfg, key, fieldIds);
	return childSum > 0 ? childSum : null;
}

/** An issue's child work items (epic → stories, story → subtasks), one level deep. */
export async function fetchChildIssues(
	cfg: JiraSettings,
	parentKey: string,
	opts: { storyPointsFields?: string[]; epicColorField?: string | null } = {}
): Promise<JiraIssue[]> {
	return jiraSearch(cfg, `parent = "${parentKey}"`, 100, opts);
}

/**
 * Maps Jira issues (parents and their child work items) to new tasks with
 * pre-generated ids, skipping keys already linked in the plan. A child
 * attaches to its parent task — newly created or already existing — and
 * inherits its color unless inheritParentColor is off.
 */
export function issuesToTasks(
	issues: JiraIssue[],
	existing: Task[],
	opts: { inheritParentColor?: boolean } = {}
): Task[] {
	const inherit = opts.inheritParentColor ?? true;
	const existingByKey = new Map(
		existing.filter((t) => t.jiraKey).map((t) => [t.jiraKey!, t] as const)
	);
	const usedColors = existing.map((t) => t.color);
	const fresh = issues.filter((i) => !existingByKey.has(i.key));
	const byKey = new Map<string, Task>();
	const tasks = fresh.map((issue) => {
		// Jira's own epic color wins; otherwise pick a fresh palette color.
		const color = issue.color ?? nextColor(usedColors);
		usedColors.push(color);
		const task: Task = {
			id: newId(),
			name: issue.summary ? `${issue.key} · ${issue.summary}` : issue.key,
			color,
			jiraKey: issue.key,
			estimateDays: issue.storyPoints ? storyPointsToDays(issue.storyPoints) : undefined,
			notes: issue.status ? `Jira status: ${issue.status}` : undefined
		};
		byKey.set(issue.key, task);
		return task;
	});
	for (const issue of fresh) {
		if (!issue.parentKey) continue;
		const parent = byKey.get(issue.parentKey) ?? existingByKey.get(issue.parentKey);
		if (!parent) continue;
		const child = byKey.get(issue.key)!;
		child.parentId = parent.id;
		if (inherit) child.color = parent.color;
	}
	return tasks;
}

// ---- auto-sync ------------------------------------------------------------------

export interface JiraSyncUpdate {
	taskId: string;
	fields: Partial<Pick<Task, 'name' | 'notes' | 'color' | 'estimateDays'>>;
}

const JIRA_COLOR_HEXES = new Set(Object.values(JIRA_EPIC_COLORS));

/** True while the task still wears an auto-assigned color (palette or Jira). */
function followsJiraColor(color: string): boolean {
	return PALETTE.includes(color) || JIRA_COLOR_HEXES.has(color);
}

/**
 * Diffs linked tasks against their Jira issues, conservatively:
 * - names refresh only while still auto-generated ("KEY · …" or bare "KEY");
 * - only the "Jira status: …" notes line is rewritten, never other notes;
 * - colors follow Jira only while the task wears a palette or Jira color
 *   (custom picks are kept);
 * - estimates are filled only when EMPTY — existing sizes never change
 *   automatically ("Check estimates from Jira" reviews those).
 */
export function buildJiraSyncUpdates(
	tasks: Task[],
	issues: JiraIssue[],
	opts: { useStoryPoints?: boolean } = {}
): JiraSyncUpdate[] {
	const byKey = new Map(issues.map((i) => [i.key, i]));
	const updates: JiraSyncUpdate[] = [];
	for (const task of tasks) {
		const issue = task.jiraKey ? byKey.get(task.jiraKey) : undefined;
		if (!issue) continue;
		const fields: JiraSyncUpdate['fields'] = {};
		const generated = issue.summary ? `${issue.key} · ${issue.summary}` : issue.key;
		if (
			(task.name === issue.key || task.name.startsWith(`${issue.key} · `)) &&
			task.name !== generated
		) {
			fields.name = generated;
		}
		if (issue.status) {
			const notes = task.notes ?? '';
			const line = `Jira status: ${issue.status}`;
			const next = /^Jira status: .*$/m.test(notes)
				? notes.replace(/^Jira status: .*$/m, line)
				: notes || line;
			if (next !== notes) fields.notes = next;
		}
		if (issue.color && issue.color !== task.color && followsJiraColor(task.color)) {
			fields.color = issue.color;
		}
		if (opts.useStoryPoints && task.estimateDays == null && issue.storyPoints) {
			fields.estimateDays = storyPointsToDays(issue.storyPoints);
		}
		if (Object.keys(fields).length) updates.push({ taskId: task.id, fields });
	}
	return updates;
}
