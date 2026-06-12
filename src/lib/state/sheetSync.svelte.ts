import { quarterOf } from '$lib/engine/calendar';
import { computeSchedule } from '$lib/engine/schedule';
import { buildPeriodRequests } from '$lib/export/sheets';
import {
	createSpreadsheet,
	getSheetIdsByTitle,
	isSignedIn,
	spreadsheetBatchUpdate,
	spreadsheetUrl,
	SpreadsheetGoneError
} from '$lib/integrations/google';
import type { Plan } from '$lib/model/types';
import { store } from './plan.svelte';
import { settings } from './settings.svelte';

/**
 * Write-only push of the SELECTED periods (Settings → Google Sheets) into one
 * spreadsheet — per period a colored board tab named after it plus a
 * "<period> Gantt" tab. The board is the source of truth, nothing is read
 * back, and tabs the app doesn't own are left alone. A per-period content
 * hash keeps the buttons honest and the auto-sync quiet.
 */

const HASHES_KEY = 'gantter-sheet-hashes';

class SheetSyncStore {
	busy = $state(false);
	/** Outcome of the last push, shown next to the buttons. */
	lastOutcome = $state('');
	/** periodKey → content hash last written to the spreadsheet. */
	hashes = $state<Record<string, string>>(loadHashes());
}

export const sheetSync = new SheetSyncStore();

function loadHashes(): Record<string, string> {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(HASHES_KEY) ?? '{}') as Record<string, string>;
	} catch {
		return {};
	}
}

function saveHashes() {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(HASHES_KEY, JSON.stringify($state.snapshot(sheetSync.hashes)));
}

/** Forget what was synced — used when the target spreadsheet changes. */
export function resetSheetHashes() {
	sheetSync.hashes = {};
	saveHashes();
}

/** Stable per-period identity, independent of plan ids (imports replace those). */
export function periodKey(p: { startDate: string; numWeeks: number }): string {
	return `${p.startDate}:${p.numWeeks}`;
}

/** Tab base name: the quarter label for quarter-shaped periods, else the plan name. */
export function periodLabel(p: { startDate: string; numWeeks: number; name: string }): string {
	const q = quarterOf(p.startDate);
	return q.start === p.startDate && q.weeks === p.numWeeks ? q.label : p.name;
}

/** Accepts a bare id or a full URL ("…/spreadsheets/d/<id>/edit…"). */
export function parseSpreadsheetId(input: string): string {
	const match = input.match(/\/d\/([A-Za-z0-9_-]{10,})/);
	return match?.[1] ?? input.trim();
}

/** The selected periods that actually exist in the registry, oldest first. */
function selectedPlans(): Plan[] {
	const plans: Plan[] = [];
	for (const key of settings.google.sheetPeriods ?? []) {
		const [startDate, weeks] = key.split(':');
		const plan = store.planForPeriod(startDate, Number(weeks));
		if (plan) plans.push($state.snapshot(plan) as Plan);
	}
	return plans.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function planHash(plan: Plan): string {
	return JSON.stringify(plan);
}

/** True when at least one period is selected for syncing. */
export function sheetConfigured(): boolean {
	return (settings.google.sheetPeriods ?? []).length > 0;
}

/** True when some selected period has changes the spreadsheet hasn't seen. */
export function sheetDirty(): boolean {
	void store.registryVersion;
	return selectedPlans().some((p) => sheetSync.hashes[periodKey(p)] !== planHash(p));
}

/** The target spreadsheet's URL, once one is set or created. */
export function sheetUrl(): string | null {
	const id = parseSpreadsheetId(settings.google.spreadsheetId ?? '');
	return id ? spreadsheetUrl(id) : null;
}

function tabTitles(p: Plan): { board: string; gantt: string } {
	const label = periodLabel(p);
	return { board: label, gantt: `${label} Gantt` };
}

/**
 * Pushes every out-of-date selected period into the spreadsheet, creating the
 * doc (or any missing tab) first. Returns a status line.
 */
export async function syncPlanToSheet(): Promise<string> {
	if (sheetSync.busy) return 'A sync is already running';
	if (!isSignedIn()) {
		return (sheetSync.lastOutcome = '✗ Sign in with Google first (Settings → Google Calendar)');
	}
	const plans = selectedPlans();
	if (!plans.length) {
		return (sheetSync.lastOutcome = '✗ Pick the periods to sync in Settings → Google Sheets');
	}
	const dirty = plans.filter((p) => sheetSync.hashes[periodKey(p)] !== planHash(p));
	if (!dirty.length) return (sheetSync.lastOutcome = '✓ Already in sync');
	sheetSync.busy = true;
	try {
		let spreadsheetId = parseSpreadsheetId(settings.google.spreadsheetId ?? '');
		let created = false;
		let ids: Record<string, number> | undefined;
		if (spreadsheetId) {
			try {
				ids = await getSheetIdsByTitle(spreadsheetId);
			} catch (e) {
				if (!(e instanceof SpreadsheetGoneError)) throw e;
				spreadsheetId = ''; // deleted (or a bad id) — create a fresh doc below
			}
		}
		let toWrite = dirty;
		if (!spreadsheetId || !ids) {
			const titles = plans.flatMap((p) => [tabTitles(p).board, tabTitles(p).gantt]);
			spreadsheetId = await createSpreadsheet('Gantter', titles);
			ids = Object.fromEntries(titles.map((t, i) => [t, i]));
			settings.updateGoogle({ spreadsheetId });
			created = true;
			toWrite = plans; // a brand-new doc starts empty — write everything selected
		} else {
			const missing = plans
				.flatMap((p) => [tabTitles(p).board, tabTitles(p).gantt])
				.filter((t) => !(t in ids!));
			if (missing.length) {
				await spreadsheetBatchUpdate(
					spreadsheetId,
					missing.map((title) => ({ addSheet: { properties: { title } } }))
				);
				ids = await getSheetIdsByTitle(spreadsheetId);
			}
		}
		const requests = toWrite.flatMap((p) => {
			const titles = tabTitles(p);
			return buildPeriodRequests(
				p,
				computeSchedule(p),
				{ board: ids![titles.board], gantt: ids![titles.gantt] },
				titles
			);
		});
		await spreadsheetBatchUpdate(spreadsheetId, requests);
		const next = { ...sheetSync.hashes };
		for (const p of toWrite) next[periodKey(p)] = planHash(p);
		sheetSync.hashes = next;
		saveHashes();
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return (sheetSync.lastOutcome =
			`✓ Synced ${toWrite.map(periodLabel).join(', ')} at ${time}` +
			(created ? ' — new spreadsheet created' : ''));
	} catch (e) {
		return (sheetSync.lastOutcome = `✗ ${e instanceof Error ? e.message : 'Sheet sync failed'}`);
	} finally {
		sheetSync.busy = false;
	}
}

let autoTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced auto push — the layout calls this on every committed change while
 * the setting is on, so a drag burst becomes one write a moment after it ends.
 */
export function scheduleSheetAutoSync(delayMs = 2500) {
	clearTimeout(autoTimer);
	autoTimer = setTimeout(() => {
		if (!settings.google.sheetAutoSync || !isSignedIn()) return;
		if (sheetSync.busy) {
			scheduleSheetAutoSync(delayMs); // a manual sync is running — retry after it
			return;
		}
		if (sheetDirty()) void syncPlanToSheet();
	}, delayMs);
}
