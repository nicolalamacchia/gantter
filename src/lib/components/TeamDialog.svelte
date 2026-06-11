<script lang="ts">
	import { isSignedIn, searchDirectory, type DirectoryPerson } from '$lib/integrations/google';
	import { store } from '$lib/state/plan.svelte';
	import { serverConfig } from '$lib/state/serverConfig.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import EmojiPicker from './EmojiPicker.svelte';
	import Modal from './Modal.svelte';

	let newGroup = $state('');
	let dirFor = $state<string | null>(null);
	let dirResults = $state<DirectoryPerson[]>([]);
	let dirTimer: ReturnType<typeof setTimeout> | undefined;
	let dirReq = 0;

	/** Directory autocomplete (needs an active Google sign-in from Settings). */
	function searchEmails(memberId: string, query: string) {
		clearTimeout(dirTimer);
		const q = query.trim();
		if (!isSignedIn() || q.length < 2) {
			dirFor = null;
			dirResults = [];
			return;
		}
		const req = ++dirReq;
		dirTimer = setTimeout(async () => {
			try {
				const results = await searchDirectory(q);
				if (req !== dirReq) return;
				dirResults = results;
				dirFor = results.length ? memberId : null;
			} catch {
				if (req === dirReq) {
					dirFor = null;
					dirResults = [];
				}
			}
		}, 300);
	}

	function pickEmail(memberId: string, email: string) {
		store.updateMember(memberId, { googleEmail: email });
		dirFor = null;
		dirResults = [];
	}
	let newMember = $state('');
	let newMemberGroup = $state('');

	function close() {
		ui.teamDialogOpen = false;
	}

	function addGroup() {
		if (!newGroup.trim()) return;
		store.addGroup(newGroup.trim());
		newGroup = '';
	}

	function addMember() {
		if (!newMember.trim()) return;
		store.addMember(newMember.trim(), newMemberGroup || undefined);
		newMember = '';
	}

	function removeMember(id: string, name: string) {
		if (confirm(`Remove ${name}? Their assignments and PTO will be deleted.`)) {
			store.removeMember(id);
		}
	}

	function removeGroup(id: string, name: string) {
		if (confirm(`Delete sub-team "${name}"? Members stay, but lose the grouping.`)) {
			store.removeGroup(id);
		}
	}
</script>

<Modal open={ui.teamDialogOpen} title="Team" onclose={close}>
	<div class="body">
		{#if serverConfig.locked}
			<p class="managed">🔒 The team is managed by the server configuration.</p>
		{/if}
		<fieldset class="plain" disabled={serverConfig.locked}>
			<section>
				<h3>Sub-teams</h3>
				{#each store.plan.groups as g (g.id)}
					<div class="row">
						<input
							type="text"
							value={g.name}
							onchange={(e) => store.updateGroup(g.id, { name: e.currentTarget.value })}
						/>
						<EmojiPicker value={g.emoji} onselect={(emoji) => store.updateGroup(g.id, { emoji })} />
						<button class="x" onclick={() => removeGroup(g.id, g.name)} title="Delete sub-team">
							✕
						</button>
					</div>
				{/each}
				<form
					class="row"
					onsubmit={(e) => {
						e.preventDefault();
						addGroup();
					}}
				>
					<input type="text" bind:value={newGroup} placeholder="e.g. Backend" />
					<button type="submit" class="add" disabled={!newGroup.trim()}>Add</button>
				</form>
			</section>
			<section>
				<h3>Members</h3>
				{#each store.plan.members as m (m.id)}
					<div class="row">
						<input
							type="text"
							value={m.name}
							onchange={(e) => store.updateMember(m.id, { name: e.currentTarget.value })}
						/>
						<select
							value={m.groupId ?? ''}
							onchange={(e) =>
								store.updateMember(m.id, { groupId: e.currentTarget.value || undefined })}
						>
							<option value="">— no sub-team —</option>
							{#each store.plan.groups as g (g.id)}
								<option value={g.id}>{g.name}</option>
							{/each}
						</select>
						<div class="gbox">
							<input
								class="gmail"
								type="email"
								placeholder={isSignedIn()
									? 'Google email — type to search'
									: 'Google email (PTO sync)'}
								value={m.googleEmail ?? ''}
								title="Google account used to fetch out-of-office events"
								oninput={(e) => searchEmails(m.id, e.currentTarget.value)}
								onchange={(e) => store.updateMember(m.id, { googleEmail: e.currentTarget.value })}
								onfocusout={() => setTimeout(() => (dirFor = dirFor === m.id ? null : dirFor), 150)}
							/>
							{#if dirFor === m.id}
								<ul class="gsuggest">
									{#each dirResults as person (person.email)}
										<li>
											<button
												type="button"
												onmousedown={(e) => {
													e.preventDefault();
													pickEmail(m.id, person.email);
												}}
											>
												{#if person.name}<strong>{person.name}</strong>{/if}
												{person.email}
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
						<button class="x" onclick={() => removeMember(m.id, m.name)} title="Remove member">
							✕
						</button>
					</div>
				{/each}
				<form
					class="row"
					onsubmit={(e) => {
						e.preventDefault();
						addMember();
					}}
				>
					<input type="text" bind:value={newMember} placeholder="Name" />
					<select bind:value={newMemberGroup}>
						<option value="">— no sub-team —</option>
						{#each store.plan.groups as g (g.id)}
							<option value={g.id}>{g.name}</option>
						{/each}
					</select>
					<button type="submit" class="add" disabled={!newMember.trim()}>Add</button>
				</form>
			</section>
		</fieldset>
	</div>
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 18px;
		font-size: 12.5px;
		min-width: 460px;
	}
	.plain {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.managed {
		margin: 0;
		font-size: 12px;
		color: var(--warn);
	}
	.gbox {
		flex: 1.2;
		position: relative;
		min-width: 0;
	}
	.gmail {
		width: 100%;
		font-size: 11.5px;
	}
	.gsuggest {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 10;
		background: var(--panel);
		border-radius: 8px;
		box-shadow:
			0 0 0 1px var(--border),
			0 10px 24px rgba(0, 0, 0, 0.18);
		list-style: none;
		margin: 4px 0 0;
		padding: 4px;
		max-height: 180px;
		overflow-y: auto;
	}
	.gsuggest button {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 6px 8px;
		border-radius: 6px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.gsuggest button:hover {
		background: var(--hover);
	}
	.gsuggest strong {
		color: var(--accent);
		margin-right: 4px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin: 0 0 8px;
	}
	.row {
		display: flex;
		gap: 6px;
		margin-bottom: 6px;
		align-items: center;
	}
	input,
	select {
		font: inherit;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
	}
	input {
		flex: 1;
		min-width: 0;
	}
	.x {
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 12px;
		padding: 4px;
	}
	.x:hover {
		color: var(--danger);
	}
	.add {
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		padding: 5px 12px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		cursor: pointer;
	}
	.add:disabled {
		opacity: 0.5;
	}
</style>
