<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { connection } from '$lib/state/connection.svelte';
	import { startJiraAutoSync } from '$lib/state/jiraSync.svelte';
	import { serverConfig } from '$lib/state/serverConfig.svelte';
	import { ui } from '$lib/state/ui.svelte';

	let { children } = $props();

	let systemDark = $state(false);

	$effect(() => {
		// Auto-sync starts only after server-provisioned credentials are applied.
		let stopSync: (() => void) | undefined;
		let torn = false;
		void serverConfig
			.load()
			.then(() => connection.init())
			.then(() => {
				if (!torn) stopSync = startJiraAutoSync();
			});
		return () => {
			torn = true;
			stopSync?.();
		};
	});

	$effect(() => {
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		systemDark = mq.matches;
		const onChange = (e: MediaQueryListEvent) => (systemDark = e.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	const dark = $derived(ui.theme === 'dark' || (ui.theme === 'system' && systemDark));

	$effect(() => {
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		--bg: #f8fafc;
		--bg-muted: #f8fafc;
		--panel: #ffffff;
		--panel-alt: #fcfcfd;
		--hover: #f1f5f9;
		--border: #e2e8f0;
		--border-soft: #eef2f7;
		--border-faint: #f6f8fb;
		--border-strong: #cbd5e1;
		--text: #0f172a;
		--text-mid: #334155;
		--text-muted: #64748b;
		--text-faint: #94a3b8;
		--accent: #2563eb;
		--accent-hover: #1d4ed8;
		--accent-soft: #eff6ff;
		--holiday: #64748b;
		--holiday-text: #e2e8f0;
		--weekend: #e9eef4;
		--absence-a: #94a3b8;
		--absence-b: #a8b6c8;
		--absence-text: #f1f5f9;
		--tooltip-bg: #0f172a;
		--tooltip-text: #ffffff;
		--tooltip-hint: #93c5fd;
		--danger: #b91c1c;
		--danger-border: #fca5a5;
		--danger-bg: #fef2f2;
		--warn: #b45309;
		--ok: #15803d;
		--tag-text: #6366f1;
		--tag-bg: #eef2ff;
		--chip-active-bg: #0f172a;
		--chip-active-text: #ffffff;
		--pto-active-bg: #fef3c7;
		--pto-active-border: #f59e0b;
		color-scheme: light;
	}
	:global(:root[data-theme='dark']) {
		--bg: #0b1220;
		--bg-muted: #131c30;
		--panel: #101828;
		--panel-alt: #0e1626;
		--hover: #1c2840;
		--border: #243049;
		--border-soft: #1c2740;
		--border-faint: #182236;
		--border-strong: #36456a;
		--text: #e2e8f0;
		--text-mid: #cbd5e1;
		--text-muted: #94a3b8;
		--text-faint: #64748b;
		--accent: #3b82f6;
		--accent-hover: #2563eb;
		--accent-soft: #1c2840;
		--holiday: #334155;
		--holiday-text: #94a3b8;
		--weekend: #0d1526;
		--absence-a: #475569;
		--absence-b: #526079;
		--absence-text: #cbd5e1;
		--tooltip-bg: #1e293b;
		--tooltip-text: #f1f5f9;
		--tooltip-hint: #93c5fd;
		--danger: #f87171;
		--danger-border: #7f1d1d;
		--danger-bg: #2a1518;
		--warn: #fbbf24;
		--ok: #4ade80;
		--tag-text: #a5b4fc;
		--tag-bg: #272452;
		--chip-active-bg: #e2e8f0;
		--chip-active-text: #0f172a;
		--pto-active-bg: #3a2e10;
		--pto-active-border: #b45309;
		color-scheme: dark;
	}
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
		color: var(--text);
		background: var(--bg);
		font-size: 13px;
		-webkit-font-smoothing: antialiased;
	}
	:global(input),
	:global(select),
	:global(textarea) {
		background: var(--panel);
		color: var(--text);
	}
	:global(dialog) {
		background: var(--panel);
		color: var(--text);
	}
</style>
