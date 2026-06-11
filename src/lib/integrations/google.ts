import { addDays } from '$lib/engine/calendar';
import type { Absence, ISODate } from '$lib/model/types';

/**
 * Google Calendar via Google Identity Services: pure client-side OAuth (only a
 * Client ID is needed — no secret, no backend). The access token lives in
 * memory for the session and is never persisted.
 */

export interface OooEvent {
	id: string;
	summary?: string;
	/** Inclusive working range, already normalized to ISO dates. */
	startDate: ISODate;
	endDate: ISODate;
}

interface TokenClient {
	requestAccessToken(options?: { prompt?: string }): void;
}

declare global {
	interface Window {
		google?: {
			accounts: {
				oauth2: {
					initTokenClient(config: {
						client_id: string;
						scope: string;
						callback: (response: {
							access_token?: string;
							expires_in?: number | string;
							error?: string;
						}) => void;
						error_callback?: (error: unknown) => void;
					}): TokenClient;
				};
			};
		};
	}
}

let accessToken: string | null = null;
let expiresAt = 0;
let gisLoading: Promise<void> | null = null;
let authListener: ((signedIn: boolean) => void) | null = null;

const AUTH_FLAG = 'gantter-google-auth';
const TOKEN_KEY = 'gantter-google-token';
const SCOPES =
	'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/directory.readonly';

/** The UI mirrors auth state through this (module state isn't reactive). */
export function setAuthListener(listener: (signedIn: boolean) => void) {
	authListener = listener;
	listener(isSignedIn());
}

function setToken(token: string, expiresInSeconds?: number) {
	accessToken = token;
	expiresAt = Date.now() + Math.max(60, (expiresInSeconds ?? 3600) - 60) * 1000;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(AUTH_FLAG, '1');
		// Cached so reloads within the token's lifetime stay signed in (GIS
		// cannot refresh silently without a user gesture — popup-based only).
		localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
	}
	authListener?.(true);
}

function clearToken() {
	accessToken = null;
	expiresAt = 0;
	if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
	authListener?.(false);
}

(function restoreToken() {
	if (typeof localStorage === 'undefined') return;
	try {
		const raw = localStorage.getItem(TOKEN_KEY);
		if (!raw) return;
		const saved = JSON.parse(raw) as { token?: string; expiresAt?: number };
		if (saved.token && saved.expiresAt && Date.now() < saved.expiresAt - 30_000) {
			accessToken = saved.token;
			expiresAt = saved.expiresAt;
		} else {
			localStorage.removeItem(TOKEN_KEY);
		}
	} catch {
		localStorage.removeItem(TOKEN_KEY);
	}
})();

export function wasSignedInBefore(): boolean {
	return typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_FLAG) === '1';
}

/** Google error bodies say exactly what's wrong (disabled API, missing scope…) — surface that. */
async function googleApiError(res: Response, what: string): Promise<Error> {
	let detail = '';
	try {
		const body = await res.json();
		detail = body?.error?.message ?? '';
	} catch {
		// no parseable body
	}
	const hint =
		res.status === 403 && !detail.toLowerCase().includes('scope')
			? ' — usually the API is not enabled on the GCP project (APIs & Services → Library)'
			: res.status === 403
				? ' — sign out and back in to re-consent'
				: '';
	return new Error(`${what} failed${detail ? `: ${detail}` : ` (${res.status})`}${hint}`);
}

function loadGis(): Promise<void> {
	if (window.google?.accounts) return Promise.resolve();
	gisLoading ??= new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = 'https://accounts.google.com/gsi/client';
		script.async = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Could not load Google sign-in script'));
		document.head.appendChild(script);
	});
	return gisLoading;
}

export function isSignedIn(): boolean {
	return accessToken !== null && Date.now() < expiresAt;
}

export function signOut(): void {
	clearToken();
	if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_FLAG);
}

/** Opens the Google consent flow and resolves once an access token is granted. */
export async function signIn(clientId: string): Promise<void> {
	if (!clientId) throw new Error('Set a Google OAuth Client ID in Settings first');
	await loadGis();
	if (!window.google) throw new Error('Google sign-in unavailable');
	await new Promise<void>((resolve, reject) => {
		const client = window.google!.accounts.oauth2.initTokenClient({
			client_id: clientId,
			scope: SCOPES,
			callback: (response) => {
				if (response.access_token) {
					setToken(response.access_token, Number(response.expires_in) || undefined);
					resolve();
				} else {
					reject(new Error(response.error ?? 'Google sign-in was cancelled'));
				}
			}
		});
		client.requestAccessToken();
	});
}

/**
 * Re-acquires a token without UI when the user signed in before and still has
 * an active Google session — so reloads don't look like being logged out.
 */
export async function trySilentSignIn(clientId: string): Promise<boolean> {
	if (!clientId || !wasSignedInBefore()) return false;
	try {
		await loadGis();
		if (!window.google) return false;
		return await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 5000);
			const client = window.google!.accounts.oauth2.initTokenClient({
				client_id: clientId,
				scope: SCOPES,
				callback: (response) => {
					clearTimeout(timer);
					if (response.access_token) {
						setToken(response.access_token, Number(response.expires_in) || undefined);
						resolve(true);
					} else {
						resolve(false);
					}
				},
				error_callback: () => {
					clearTimeout(timer);
					resolve(false);
				}
			});
			client.requestAccessToken({ prompt: 'none' });
		});
	} catch {
		return false;
	}
}

interface RawEvent {
	id?: string;
	summary?: string;
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
}

export interface DirectoryPerson {
	name: string;
	email: string;
}

/** Searches the Workspace directory for colleagues (People API, directory scope). */
export async function searchDirectory(query: string, max = 8): Promise<DirectoryPerson[]> {
	if (!accessToken) throw new Error('Sign in with Google first');
	const params = new URLSearchParams({
		query,
		readMask: 'names,emailAddresses',
		sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE',
		pageSize: String(max)
	});
	const res = await fetch(
		`https://people.googleapis.com/v1/people:searchDirectoryPeople?${params}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (res.status === 401) {
		clearToken();
		throw new Error('Google session expired — sign in again');
	}
	if (!res.ok) throw await googleApiError(res, 'Directory search');
	const body = await res.json();
	return (
		(body.people ?? []) as Array<{
			names?: Array<{ displayName?: string }>;
			emailAddresses?: Array<{ value?: string }>;
		}>
	)
		.map((p) => ({
			name: p.names?.[0]?.displayName ?? '',
			email: p.emailAddresses?.[0]?.value ?? ''
		}))
		.filter((p) => p.email !== '');
}

export interface GoogleCalendarInfo {
	id: string;
	summary: string;
}

/** The signed-in user's visible calendars (to pick a company-holidays calendar from). */
export async function listCalendars(): Promise<GoogleCalendarInfo[]> {
	if (!accessToken) throw new Error('Sign in with Google first');
	const params = new URLSearchParams({
		minAccessRole: 'reader',
		maxResults: '250',
		fields: 'items(id,summary)'
	});
	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (res.status === 401) {
		clearToken();
		throw new Error('Google session expired — sign in again');
	}
	if (!res.ok) throw await googleApiError(res, 'Calendar list');
	const body = await res.json();
	return ((body.items ?? []) as Array<{ id?: string; summary?: string }>)
		.filter((c) => c.id)
		.map((c) => ({ id: c.id!, summary: c.summary ?? c.id! }));
}

/** Expands one event into the ISO dates it covers (all-day end dates are exclusive). */
export function expandEventDates(event: RawEvent): ISODate[] {
	const dates: ISODate[] = [];
	if (event.start?.date) {
		const end = event.end?.date ?? addDays(event.start.date, 1);
		for (let d = event.start.date, i = 0; d < end && i < 62; d = addDays(d, 1), i++) {
			dates.push(d);
		}
	} else if (event.start?.dateTime) {
		dates.push(event.start.dateTime.slice(0, 10));
	}
	return dates;
}

/** All dates covered by a calendar's events in a range (e.g. a holidays calendar). */
export async function fetchCalendarDates(
	calendarId: string,
	timeMin: ISODate,
	timeMax: ISODate
): Promise<ISODate[]> {
	if (!accessToken) throw new Error('Sign in with Google first');
	const params = new URLSearchParams({
		singleEvents: 'true',
		maxResults: '250',
		timeMin: `${timeMin}T00:00:00Z`,
		timeMax: `${timeMax}T23:59:59Z`
	});
	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (res.status === 401) {
		clearToken();
		throw new Error('Google session expired — sign in again');
	}
	if (res.status === 404)
		throw new Error(`Calendar "${calendarId}" is not visible to your account`);
	if (!res.ok) throw await googleApiError(res, 'Holiday fetch');
	const body = await res.json();
	const dates = new Set<ISODate>();
	for (const item of (body.items ?? []) as RawEvent[]) {
		for (const d of expandEventDates(item)) {
			if (d >= timeMin && d <= timeMax) dates.add(d);
		}
	}
	return [...dates].sort();
}

/**
 * Normalizes a Calendar event to inclusive ISO dates. Only whole-day events
 * qualify as PTO — hour-scoped out-of-office blocks (start.dateTime) don't
 * take a working day off the plan.
 */
export function eventToOoo(event: RawEvent): OooEvent | null {
	if (!event.id) return null;
	const start = event.start?.date;
	if (!start) return null;
	const endRaw = event.end?.date ? addDays(event.end.date, -1) : start; // all-day end is exclusive
	const end = endRaw >= start ? endRaw : start;
	return { id: event.id, summary: event.summary, startDate: start, endDate: end };
}

/** Fetches out-of-office events from a colleague's calendar over a date range. */
export async function fetchOutOfOffice(
	calendarId: string,
	timeMin: ISODate,
	timeMax: ISODate
): Promise<OooEvent[]> {
	if (!accessToken) throw new Error('Sign in with Google first');
	const params = new URLSearchParams({
		eventTypes: 'outOfOffice',
		singleEvents: 'true',
		maxResults: '250',
		timeMin: `${timeMin}T00:00:00Z`,
		timeMax: `${timeMax}T23:59:59Z`
	});
	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (res.status === 401) {
		clearToken();
		throw new Error('Google session expired — sign in again');
	}
	if (res.status === 404) {
		throw new Error(`Calendar of ${calendarId} is not visible to your account`);
	}
	if (!res.ok) throw await googleApiError(res, 'Calendar read');
	const body = await res.json();
	return ((body.items ?? []) as RawEvent[])
		.map(eventToOoo)
		.filter((e): e is OooEvent => e !== null);
}

/** Maps fetched OOO events to absence facts for one member. */
export function oooToAbsences(
	memberId: string,
	events: OooEvent[]
): Array<Omit<Absence, 'id'> & { externalId: string }> {
	return events.map((event) => ({
		memberId,
		startDate: event.startDate,
		endDate: event.endDate,
		note: event.summary || 'OOO',
		source: 'google' as const,
		externalId: event.id
	}));
}
