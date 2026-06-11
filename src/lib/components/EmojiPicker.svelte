<script lang="ts">
	let { value, onselect }: { value?: string; onselect: (emoji?: string) => void } = $props();

	let open = $state(false);

	const EMOJIS = [
		'🎨',
		'🖥️',
		'📱',
		'🛠️',
		'⚙️',
		'🔧',
		'🧰',
		'🏗️',
		'🚀',
		'⚡',
		'🔥',
		'🧪',
		'🔬',
		'🤖',
		'🧠',
		'💡',
		'🔒',
		'🛡️',
		'🌐',
		'☁️',
		'🗄️',
		'💾',
		'📦',
		'📊',
		'📈',
		'🎯',
		'🧭',
		'🐛',
		'🔍',
		'🧹',
		'📣',
		'🦄'
	];

	function pick(emoji?: string) {
		onselect(emoji);
		open = false;
	}
</script>

<div class="picker">
	<button
		type="button"
		class="trigger"
		class:empty={!value}
		onclick={() => (open = !open)}
		title="Team emoji — shown on the team's blocks"
		aria-label="Pick team emoji"
	>
		{value ?? '＋'}
	</button>
	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div class="backdrop" onclick={() => (open = false)}></div>
		<div class="pop">
			<div class="grid">
				{#each EMOJIS as emoji (emoji)}
					<button type="button" class="opt" class:sel={emoji === value} onclick={() => pick(emoji)}>
						{emoji}
					</button>
				{/each}
			</div>
			<button type="button" class="clear" disabled={!value} onclick={() => pick(undefined)}>
				✕ No emoji
			</button>
		</div>
	{/if}
</div>

<style>
	.picker {
		position: relative;
		flex: none;
	}
	.trigger {
		width: 34px;
		height: 28px;
		font: inherit;
		font-size: 14px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--panel);
		cursor: pointer;
		line-height: 1;
	}
	.trigger.empty {
		color: var(--text-faint);
		font-size: 12px;
	}
	.trigger:hover {
		background: var(--hover);
	}
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
	}
	.pop {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 41;
		background: var(--panel);
		border-radius: 10px;
		box-shadow:
			0 0 0 1px var(--border),
			0 12px 32px rgba(0, 0, 0, 0.2);
		padding: 8px;
		width: 264px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 2px;
	}
	.opt {
		border: none;
		background: none;
		font-size: 16px;
		line-height: 1;
		padding: 5px 0;
		border-radius: 6px;
		cursor: pointer;
	}
	.opt:hover {
		background: var(--hover);
	}
	.opt.sel {
		background: var(--accent-soft);
		outline: 1px solid var(--accent);
	}
	.clear {
		display: block;
		width: 100%;
		margin-top: 6px;
		font: inherit;
		font-size: 11.5px;
		padding: 5px 0;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--panel);
		color: var(--text-muted);
		cursor: pointer;
	}
	.clear:hover:not(:disabled) {
		background: var(--hover);
	}
	.clear:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
