import { jiraTestConnection, setJiraListener } from '$lib/integrations/jira';
import { setAuthListener } from '$lib/integrations/google';
import { settings } from './settings.svelte';

/**
 * Live connectivity shown in the toolbar: Google sign-in state and the outcome
 * of the latest real Jira call. Initialized after the server config loads, so
 * provisioned credentials count.
 */
export class ConnectionStore {
	google = $state(false);
	/** null = not checked / not configured; true/false = last call outcome. */
	jira = $state<boolean | null>(null);
	#initialized = false;

	async init() {
		if (this.#initialized) return;
		this.#initialized = true;
		// Auth state restores from the cached token (GIS has no gesture-free
		// silent refresh); the listener snapshot reflects it immediately.
		setAuthListener((signedIn) => (this.google = signedIn));
		setJiraListener((ok) => (this.jira = ok));
		if (settings.jiraConfigured()) {
			try {
				await jiraTestConnection(settings.jira);
			} catch {
				// the listener already recorded the failure
			}
		}
	}
}

export const connection = new ConnectionStore();
