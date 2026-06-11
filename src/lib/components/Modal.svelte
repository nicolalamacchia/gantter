<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open,
		title,
		onclose,
		children
	}: { open: boolean; title: string; onclose: () => void; children: Snippet } = $props();

	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	{onclose}
	onclick={(e) => {
		if (e.target === dialog) onclose();
	}}
>
	<div class="body">
		<header>
			<h2>{title}</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>
		{#if open}
			{@render children()}
		{/if}
	</div>
</dialog>

<style>
	dialog {
		border: none;
		border-radius: 10px;
		padding: 0;
		min-width: 380px;
		max-width: 560px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
	}
	dialog::backdrop {
		background: rgba(15, 23, 42, 0.45);
	}
	.body {
		padding: 16px 18px 18px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	h2 {
		font-size: 15px;
		margin: 0;
	}
	.close {
		border: none;
		background: none;
		font-size: 20px;
		cursor: pointer;
		color: var(--text-muted);
		line-height: 1;
	}
</style>
