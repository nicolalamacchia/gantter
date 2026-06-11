<script lang="ts">
	import { formatMonthDay } from '$lib/engine/calendar';
	import { clampToViewport } from './clampToViewport';
	import { store } from '$lib/state/plan.svelte';
	import { ui } from '$lib/state/ui.svelte';

	const info = $derived.by(() => {
		if (ui.popover?.kind !== 'absence') return null;
		const absence = store.plan.absences.find((a) => a.id === ui.popover!.id);
		if (!absence) return null;
		return { absence, member: store.membersById.get(absence.memberId) };
	});

	const pos = $derived.by(() => {
		if (!ui.popover) return { x: 0, y: 0 };
		return {
			x: Math.min(ui.popover.x, (window?.innerWidth ?? 1200) - 280),
			y: Math.min(ui.popover.y, (window?.innerHeight ?? 800) - 180)
		};
	});

	function close() {
		ui.popover = null;
	}
</script>

{#if info && ui.popover}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="backdrop" onclick={close}></div>
	<div class="popover" use:clampToViewport style="left: {pos.x}px; top: {pos.y}px">
		<header>🏖 <strong>Absence</strong></header>
		<div class="meta">
			{info.member?.name}
			· {formatMonthDay(info.absence.startDate)} → {formatMonthDay(info.absence.endDate)}
		</div>
		<label class="title">
			Title
			<input
				type="text"
				value={info.absence.note ?? 'PTO'}
				placeholder="PTO, conference, …"
				onchange={(e) => store.updateAbsenceNote(info.absence.id, e.currentTarget.value)}
			/>
		</label>
		<footer>
			<button
				class="danger"
				onclick={() => {
					store.removeAbsence(info.absence.id);
					close();
				}}
			>
				Delete
			</button>
		</footer>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.popover {
		position: fixed;
		z-index: 31;
		width: 264px;
		background: var(--panel);
		border-radius: 10px;
		box-shadow:
			0 0 0 1px var(--border),
			0 12px 32px rgba(0, 0, 0, 0.18);
		padding: 12px 14px;
		font-size: 12.5px;
	}
	header {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 6px;
	}
	.meta {
		color: var(--text-muted);
		margin-bottom: 8px;
	}
	.title {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
		margin-bottom: 10px;
	}
	.title input {
		font: inherit;
		font-weight: 400;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
	}
	footer {
		display: flex;
		justify-content: flex-end;
	}
	button {
		font: inherit;
		font-size: 12px;
		padding: 5px 10px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	.danger {
		color: var(--danger);
		border-color: var(--danger-border);
	}
	.danger:hover {
		background: var(--danger-bg);
	}
</style>
