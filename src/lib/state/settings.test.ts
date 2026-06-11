import { describe, expect, it } from 'vitest';
import { SettingsStore } from './settings.svelte';

describe('SettingsStore.applyServerDefaults', () => {
	it('fills empty fields without clobbering user values', () => {
		const s = new SettingsStore();
		s.updateJira({ baseUrl: 'https://mine.atlassian.net' });
		s.applyServerDefaults(
			{ baseUrl: 'https://org.atlassian.net', email: 'cfg@org.com' },
			{ clientId: 'cfg-client-id' },
			false
		);
		expect(s.jira.baseUrl).toBe('https://mine.atlassian.net'); // user value kept
		expect(s.jira.email).toBe('cfg@org.com'); // empty → filled
		expect(s.google.clientId).toBe('cfg-client-id');
	});

	it('locked config overrides whatever is set', () => {
		const s = new SettingsStore();
		s.updateJira({ baseUrl: 'https://mine.atlassian.net', token: 'mine' });
		s.applyServerDefaults({ baseUrl: 'https://org.atlassian.net' }, undefined, true);
		expect(s.jira.baseUrl).toBe('https://org.atlassian.net');
		expect(s.jira.token).toBe('mine'); // not in the config → untouched
	});
});
