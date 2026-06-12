import { computeSchedule } from '$lib/engine/schedule';
import { buildSheetRequests } from '$lib/export/sheets';
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
 * Write-only push of the active plan to a Google Sheet (one spreadsheet per
 * period, created on first sync). The board is the source of truth — nothing
 * is ever read back. A synced-content hash keeps the buttons honest and the
 * auto-sync quiet when there is nothing new to write.
 */

const LINKS_KEY = 'gantter-sheet-links';
const TABS = ['Board', 'Gantt', 'Tasks'] as const;

interface SheetLink {
	spreadsheetId: string;
	syncedHash?: string;
}

function loadLinks(): Record<string, SheetLink> {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, SheetLink>;
	} catch {
		return {};
	}
}

class SheetSyncStore {
	busy = $state(false);
	/** Outcome of the last push, shown next to the buttons. */
	lastOutcome = $state('');
	/** planId → its spreadsheet and the content hash last written there. */
	links = $state<Record<string, SheetLink>>(loadLinks());
}

export const sheetSync = new SheetSyncStore();

function saveLinks() {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(LINKS_KEY, JSON.stringify($state.snapshot(sheetSync.links)));
}

function planHash(plan: Plan): string {
	return JSON.stringify(plan);
}

/** True when the active plan has changes the sheet hasn't seen (or was never synced). */
export function sheetDirty(): boolean {
	const link = sheetSync.links[store.plan.id];
	if (!link?.syncedHash) return true;
	return planHash($state.snapshot(store.plan) as Plan) !== link.syncedHash;
}

/** The active plan's spreadsheet URL, once one exists. */
export function sheetUrl(): string | null {
	const link = sheetSync.links[store.plan.id];
	return link ? spreadsheetUrl(link.spreadsheetId) : null;
}

/**
 * Pushes the active plan to its spreadsheet, creating the doc (or any missing
 * tab) first. Safe to call when clean — it no-ops. Returns a status line.
 */
export async function syncPlanToSheet(): Promise<string> {
	if (sheetSync.busy) return 'A sync is already running';
	if (!isSignedIn()) {
		sheetSync.lastOutcome = '✗ Sign in with Google first (Settings → Google Calendar)';
		return sheetSync.lastOutcome;
	}
	const plan = $state.snapshot(store.plan) as Plan;
	const hash = planHash(plan);
	if (sheetSync.links[plan.id]?.syncedHash === hash) {
		return (sheetSync.lastOutcome = '✓ Already in sync');
	}
	sheetSync.busy = true;
	try {
		let spreadsheetId: string | undefined = sheetSync.links[plan.id]?.spreadsheetId;
		let ids: Record<string, number> | undefined;
		if (spreadsheetId) {
			try {
				ids = await getSheetIdsByTitle(spreadsheetId);
			} catch (e) {
				if (!(e instanceof SpreadsheetGoneError)) throw e;
				spreadsheetId = undefined; // deleted by the user — recreate below
			}
		}
		if (!spreadsheetId || !ids) {
			spreadsheetId = await createSpreadsheet(`Gantter · ${plan.name}`, [...TABS]);
			ids = { Board: 0, Gantt: 1, Tasks: 2 };
		} else if (TABS.some((t) => !(t in ids!))) {
			await spreadsheetBatchUpdate(
				spreadsheetId,
				TABS.filter((t) => !(t in ids!)).map((title) => ({ addSheet: { properties: { title } } }))
			);
			ids = await getSheetIdsByTitle(spreadsheetId);
		}
		const requests = [
			{
				updateSpreadsheetProperties: {
					properties: { title: `Gantter · ${plan.name}` },
					fields: 'title'
				}
			},
			...buildSheetRequests(plan, computeSchedule(plan), {
				board: ids.Board,
				gantt: ids.Gantt,
				tasks: ids.Tasks
			})
		];
		await spreadsheetBatchUpdate(spreadsheetId, requests);
		sheetSync.links = { ...sheetSync.links, [plan.id]: { spreadsheetId, syncedHash: hash } };
		saveLinks();
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return (sheetSync.lastOutcome = `✓ Synced to Google Sheets at ${time}`);
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
