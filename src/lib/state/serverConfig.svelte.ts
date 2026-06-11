import type { Plan } from '$lib/model/types';
import { store } from './plan.svelte';
import { settings, type GoogleSettings, type JiraSettings } from './settings.svelte';

/**
 * Optional server-provisioned defaults (`gantter.config.json` next to the
 * server, served at /api/config). Unlocked: fills fresh setups. Locked: the
 * provisioned team/board/integration values are enforced and read-only in the
 * UI. Personal UI preferences (theme, zoom, sidebar) are never managed.
 */
export interface ServerConfig {
	locked?: boolean;
	team?: { groups?: Plan['groups']; members?: Plan['members'] };
	board?: { workdays?: number[]; showWeekends?: boolean };
	jira?: Partial<JiraSettings>;
	google?: Partial<GoogleSettings>;
}

export class ServerConfigStore {
	config = $state<ServerConfig | null>(null);
	loaded = $state(false);
	locked = $derived(!!this.config?.locked);

	async load() {
		if (this.loaded) return;
		try {
			const res = await fetch('/api/config');
			if (res.ok) this.config = (await res.json()) as ServerConfig | null;
		} catch {
			this.config = null;
		}
		this.loaded = true;
		const c = this.config;
		if (!c) return;
		settings.applyServerDefaults(c.jira, c.google, !!c.locked);
		if (c.locked || store.bootWasFresh) store.applyServerTeam(c.team, c.board);
	}
}

export const serverConfig = new ServerConfigStore();
