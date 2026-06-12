import { env } from '$env/dynamic/public';

/**
 * Integration settings — kept OUT of the plan document on purpose: tokens are
 * personal/secret and must not travel with exported/shared plan files.
 * Persisted in localStorage only.
 */
export interface JiraSettings {
	/** e.g. https://yourorg.atlassian.net */
	baseUrl: string;
	/** Atlassian account email the API token belongs to. */
	email: string;
	/** API token from id.atlassian.com/manage-profile/security/api-tokens. */
	token: string;
	/** Treat Jira story points as estimates, 1 SP = 1 person-day (epics sum their children). */
	useStoryPoints?: boolean;
	/** Auto-refresh linked tasks from Jira on load and periodically. Off by default. */
	autoSync?: boolean;
	/** Auto-detected story-points field ids, comma-separated (sites often have two). */
	storyPointsField?: string;
	/** Auto-detected custom field id holding the issue start date. */
	startDateField?: string;
}

export interface GoogleSettings {
	/** OAuth 2.0 Client ID (Web application) from console.cloud.google.com. */
	clientId: string;
	/** Calendar id whose events become company holidays (e.g. a shared holidays calendar). */
	holidayCalendarId?: string;
	/** Push the plan to its Google Sheet after every change (write-only). Off by default. */
	sheetAutoSync?: boolean;
}

interface Settings {
	jira: JiraSettings;
	google: GoogleSettings;
}

const STORAGE_KEY = 'gantt-settings';

/** Build/deploy-time defaults so a fresh browser needs zero setup. */
const ENV_GOOGLE_CLIENT_ID = env.PUBLIC_GOOGLE_CLIENT_ID ?? '';
const ENV_JIRA = {
	baseUrl: env.PUBLIC_JIRA_BASE_URL ?? '',
	email: env.PUBLIC_JIRA_EMAIL ?? '',
	token: env.PUBLIC_JIRA_TOKEN ?? ''
};

function load(): Settings {
	const fallback: Settings = {
		jira: { ...ENV_JIRA },
		google: { clientId: ENV_GOOGLE_CLIENT_ID }
	};
	if (typeof localStorage === 'undefined') return fallback;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<Settings>;
		const merged = {
			jira: { ...fallback.jira, ...parsed.jira },
			google: { ...fallback.google, ...parsed.google }
		};
		if (!merged.google.clientId) merged.google.clientId = ENV_GOOGLE_CLIENT_ID;
		if (!merged.jira.baseUrl) merged.jira.baseUrl = ENV_JIRA.baseUrl;
		if (!merged.jira.email) merged.jira.email = ENV_JIRA.email;
		if (!merged.jira.token) merged.jira.token = ENV_JIRA.token;
		return merged;
	} catch {
		return fallback;
	}
}

export class SettingsStore {
	jira = $state<JiraSettings>(load().jira);
	google = $state<GoogleSettings>(load().google);

	dialogOpen = $state(false);

	updateJira(patch: Partial<JiraSettings>) {
		this.jira = { ...this.jira, ...patch };
		this.#save();
	}

	updateGoogle(patch: Partial<GoogleSettings>) {
		this.google = { ...this.google, ...patch };
		this.#save();
	}

	/** Server-config provisioning: fill empty fields; with force, override everything given. */
	applyServerDefaults(
		jira: Partial<JiraSettings> | undefined,
		google: Partial<GoogleSettings> | undefined,
		force: boolean
	) {
		if (jira) {
			const next = { ...this.jira };
			for (const key of Object.keys(jira) as Array<keyof JiraSettings>) {
				const value = jira[key];
				if (value === undefined) continue;
				if (force || !next[key]) {
					(next as Record<string, unknown>)[key] = value;
				}
			}
			this.jira = next;
		}
		if (google) {
			const next = { ...this.google };
			for (const key of Object.keys(google) as Array<keyof GoogleSettings>) {
				const value = google[key];
				if (value === undefined) continue;
				if (force || !next[key]) {
					(next as Record<string, unknown>)[key] = value;
				}
			}
			this.google = next;
		}
		this.#save();
	}

	jiraConfigured(): boolean {
		return !!(this.jira.baseUrl && this.jira.email && this.jira.token);
	}

	#save() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				jira: $state.snapshot(this.jira),
				google: $state.snapshot(this.google)
			})
		);
	}
}

export const settings = new SettingsStore();
