<script lang="ts">
	import { boardColumns } from '$lib/engine/board';
	import { store } from '$lib/state/plan.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import Modal from './Modal.svelte';

	const task = $derived(
		ui.splitDialog.taskId ? store.tasksById.get(ui.splitDialog.taskId) : undefined
	);

	let total = $state(5);
	let shares = $state<Record<string, { checked: boolean; days: number }>>({});

	$effect(() => {
		if (!ui.splitDialog.open || !task) return;
		const alreadyAssigned = store.schedule.rollups[task.id]?.assignedDays ?? 0;
		total = Math.max(1, (task.estimateDays ?? 5) - alreadyAssigned);
		shares = Object.fromEntries(store.plan.members.map((m) => [m.id, { checked: false, days: 0 }]));
	});

	const columns = $derived(boardColumns(store.plan));
	const checkedIds = $derived(columns.filter((c) => shares[c.memberId]?.checked));
	const sum = $derived(checkedIds.reduce((s, c) => s + (shares[c.memberId]?.days || 0), 0));

	function toggle(memberId: string) {
		const share = shares[memberId];
		if (!share) return;
		share.checked = !share.checked;
		if (share.checked && share.days === 0) share.days = 1;
		if (!share.checked) share.days = 0;
	}

	function splitEqually() {
		const n = checkedIds.length;
		if (!n) return;
		const base = Math.floor(total / n);
		let remainder = total - base * n;
		for (const c of checkedIds) {
			shares[c.memberId].days = base + (remainder-- > 0 ? 1 : 0);
		}
	}

	function close() {
		ui.splitDialog = { open: false };
	}

	function schedule() {
		if (!task) return;
		store.assignTask(
			task.id,
			checkedIds.map((c) => ({ memberId: c.memberId, days: shares[c.memberId].days }))
		);
		close();
	}
</script>

<Modal open={ui.splitDialog.open} title="Schedule: {task?.name ?? ''}" onclose={close}>
	<div class="body">
		<div class="top">
			<label>
				Total person-days
				<input type="number" min="1" bind:value={total} />
			</label>
			<button type="button" onclick={splitEqually} disabled={!checkedIds.length}>
				Split equally
			</button>
		</div>
		<div class="members">
			{#each columns as col, i (col.memberId)}
				{#if i === 0 || columns[i - 1].groupId !== col.groupId}
					<div class="group-label">{col.groupName ?? 'No sub-team'}</div>
				{/if}
				<label class="member" class:on={shares[col.memberId]?.checked}>
					<input
						type="checkbox"
						checked={shares[col.memberId]?.checked ?? false}
						onchange={() => toggle(col.memberId)}
					/>
					<span class="mname">{col.name}</span>
					{#if shares[col.memberId]?.checked}
						<input class="days" type="number" min="1" bind:value={shares[col.memberId].days} />
						<span class="unit">d</span>
					{/if}
				</label>
			{/each}
		</div>
		<div class="sum" class:ok={sum === total} class:warn={sum !== total && sum > 0}>
			{sum} of {total} person-days distributed
		</div>
		<footer>
			<button type="button" onclick={close}>Cancel</button>
			<button type="button" class="primary" disabled={sum === 0} onclick={schedule}>
				Add to plan
			</button>
		</footer>
	</div>
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-size: 12.5px;
		min-width: 360px;
	}
	.top {
		display: flex;
		align-items: flex-end;
		gap: 10px;
	}
	.top label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
	}
	input[type='number'] {
		font: inherit;
		padding: 6px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		width: 90px;
	}
	.top button {
		font: inherit;
		font-size: 12px;
		padding: 7px 12px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	.top button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.members {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 280px;
		overflow-y: auto;
	}
	.group-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin: 8px 0 2px;
	}
	.member {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 6px;
	}
	.member.on {
		background: var(--accent-soft);
	}
	.mname {
		flex: 1;
	}
	.member .days {
		width: 60px;
		padding: 3px 6px;
	}
	.unit {
		color: var(--text-faint);
	}
	.sum {
		font-weight: 600;
		color: var(--text-muted);
	}
	.sum.ok {
		color: var(--ok);
	}
	.sum.warn {
		color: var(--warn);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	footer button {
		font: inherit;
		font-size: 12.5px;
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	.primary:disabled {
		opacity: 0.5;
	}
</style>
