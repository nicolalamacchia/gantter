<script lang="ts">
	import { addDays, formatMonthDay, periodEndOf } from '$lib/engine/calendar';
	import {
		fetchCalendarDates,
		fetchOutOfOffice,
		listCalendars,
		oooToAbsences,
		signIn,
		signOut,
		type GoogleCalendarInfo
	} from '$lib/integrations/google';
	import {
		ensureStartDateField,
		ensureStoryPointsFields,
		fetchStoryPoints,
		jiraTestConnection,
		pushIssueDates,
		storyPointsToDays
	} from '$lib/integrations/jira';
	import { store } from '$lib/state/plan.svelte';
	import { connection } from '$lib/state/connection.svelte';
	import { jiraSync, runJiraSync, SYNC_INTERVAL_MIN } from '$lib/state/jiraSync.svelte';
	import { serverConfig } from '$lib/state/serverConfig.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import Modal from './Modal.svelte';

	let jiraStatus = $state('');
	let jiraBusy = $state(false);
	let spBusy = $state(false);
	let spStatus = $state('');
	let googleStatus = $state('');
	let holStatus = $state('');
	let calendarChoices = $state<GoogleCalendarInfo[]>([]);

	const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

	function toggleWorkday(day: number) {
		const current = store.plan.workdays;
		const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
		if (next.length) store.setWorkdays(next);
	}

	async function loadCalendars() {
		holStatus = '';
		try {
			calendarChoices = await listCalendars();
			if (!calendarChoices.length) holStatus = '✗ No calendars visible to your account';
		} catch (e) {
			holStatus = `✗ ${e instanceof Error ? e.message : 'Could not list calendars'}`;
		}
	}

	interface HolidayProposal {
		date: string;
		selected: boolean;
	}
	let holidayProposals = $state<HolidayProposal[]>([]);

	/** Fetches the calendar's dates and presents them for review — nothing is applied yet. */
	async function fetchHolidays() {
		const calendarId = settings.google.holidayCalendarId;
		if (!calendarId) return;
		googleBusy = true;
		holStatus = '';
		holidayProposals = [];
		try {
			const timeMin = store.plan.startDate;
			const timeMax = addDays(periodEndOf(store.plan.startDate, store.plan.numWeeks), 1);
			const dates = await fetchCalendarDates(calendarId, timeMin, timeMax);
			const existing = new Set(store.plan.holidays);
			holidayProposals = dates
				.filter((d) => !existing.has(d))
				.map((date) => ({ date, selected: true }));
			const known = dates.length - holidayProposals.length;
			holStatus = holidayProposals.length
				? `${holidayProposals.length} new date${holidayProposals.length === 1 ? '' : 's'} found — review below` +
					(known ? ` (${known} already in the plan)` : '')
				: `✓ Nothing new (${dates.length} found, all already in the plan)`;
		} catch (e) {
			holStatus = `✗ ${e instanceof Error ? e.message : 'Fetch failed'}`;
		} finally {
			googleBusy = false;
		}
	}

	function applyHolidays() {
		const selected = holidayProposals.filter((p) => p.selected).map((p) => p.date);
		const added = store.addHolidays(selected);
		holidayProposals = [];
		holStatus = `✓ ${added} holiday${added === 1 ? '' : 's'} added to this period`;
	}
	let googleBusy = $state(false);
	const signedIn = $derived(connection.google);

	function close() {
		settings.dialogOpen = false;
	}

	async function testJira() {
		jiraBusy = true;
		jiraStatus = '';
		try {
			const who = await jiraTestConnection(settings.jira);
			jiraStatus = `✓ Connected as ${who}`;
		} catch (e) {
			jiraStatus = `✗ ${e instanceof Error ? e.message : 'Connection failed'}`;
		} finally {
			jiraBusy = false;
		}
	}

	function ensureSpFields(): Promise<string[]> {
		return ensureStoryPointsFields(settings.jira, (fieldIds) =>
			settings.updateJira({ storyPointsField: fieldIds })
		);
	}

	interface SpProposal {
		taskId: string;
		name: string;
		current?: number;
		proposed: number;
		selected: boolean;
	}
	let spProposals = $state<SpProposal[]>([]);

	/** Fetches story points and proposes changes — nothing is applied automatically. */
	async function checkEstimates() {
		spBusy = true;
		spStatus = '';
		spProposals = [];
		const linked = store.plan.tasks.filter((t) => t.jiraKey);
		if (!linked.length) {
			spStatus = '✗ No tasks are linked to Jira issues yet';
			spBusy = false;
			return;
		}
		try {
			const fieldIds = await ensureSpFields();
			const proposals: SpProposal[] = [];
			const misses: string[] = [];
			for (const task of linked) {
				try {
					const sp = await fetchStoryPoints(settings.jira, task.jiraKey!, fieldIds);
					if (!sp) {
						misses.push(task.jiraKey!);
						continue;
					}
					const proposed = storyPointsToDays(sp);
					if (proposed === task.estimateDays) continue;
					proposals.push({
						taskId: task.id,
						name: task.name,
						current: task.estimateDays,
						// Tasks that already have a size are NOT pre-selected.
						proposed,
						selected: task.estimateDays === undefined
					});
				} catch {
					misses.push(task.jiraKey!);
				}
			}
			spProposals = proposals;
			spStatus = proposals.length
				? `${proposals.length} task${proposals.length === 1 ? '' : 's'} differ from Jira` +
					(misses.length ? ` · no story points: ${misses.join(', ')}` : '')
				: '✓ All linked tasks already match Jira' +
					(misses.length ? ` · no story points: ${misses.join(', ')}` : '');
		} catch (e) {
			spStatus = `✗ ${e instanceof Error ? e.message : 'Check failed'}`;
		} finally {
			spBusy = false;
		}
	}

	function applyProposals(rows: SpProposal[]) {
		if (!rows.length) return;
		store.setTaskEstimates(rows.map((r) => ({ taskId: r.taskId, estimateDays: r.proposed })));
		const applied = new Set(rows.map((r) => r.taskId));
		spProposals = spProposals.filter((p) => !applied.has(p.taskId));
		spStatus = `✓ ${rows.length} estimate${rows.length === 1 ? '' : 's'} updated`;
	}

	function applyAllProposals() {
		if (
			confirm(
				`Overwrite the estimates of ALL ${spProposals.length} differing tasks with Jira story points? (Undo is available.)`
			)
		) {
			applyProposals([...spProposals]);
		}
	}

	// ---- dates → Jira (one way: the board's schedule is the source of truth) ----

	interface DateProposal {
		taskId: string;
		key: string;
		name: string;
		start: string;
		end: string;
		selected: boolean;
	}
	let datesBusy = $state(false);
	let datesStatus = $state('');
	let dateProposals = $state<DateProposal[]>([]);

	function collectDateProposals() {
		dateProposals = store.plan.tasks
			.filter((t) => t.jiraKey)
			.map((t) => ({ task: t, rollup: store.schedule.rollups[t.id] }))
			.filter(({ rollup }) => rollup?.startDate && rollup?.endDate)
			.map(({ task, rollup }) => ({
				taskId: task.id,
				key: task.jiraKey!,
				name: task.name,
				start: rollup.startDate!,
				end: rollup.endDate!,
				selected: true
			}));
		datesStatus = dateProposals.length
			? `${dateProposals.length} linked task${dateProposals.length === 1 ? '' : 's'} with scheduled dates`
			: '✗ No Jira-linked tasks with scheduled dates';
	}

	async function pushDates(rows: DateProposal[]) {
		if (!rows.length) return;
		datesBusy = true;
		datesStatus = '';
		try {
			const startField = await ensureStartDateField(settings.jira, (fieldId) =>
				settings.updateJira({ startDateField: fieldId })
			);
			let ok = 0;
			const failures: string[] = [];
			const pushed = new Set<string>();
			for (const row of rows) {
				try {
					await pushIssueDates(settings.jira, row.key, {
						startDate: row.start,
						endDate: row.end,
						startDateField: startField
					});
					ok++;
					pushed.add(row.taskId);
				} catch (e) {
					failures.push(`${row.key}: ${e instanceof Error ? e.message : 'failed'}`);
				}
			}
			dateProposals = dateProposals.filter((p) => !pushed.has(p.taskId));
			datesStatus =
				`✓ ${ok} issue${ok === 1 ? '' : 's'} updated` +
				(startField ? '' : ' (no "Start date" field on this site — only due dates set)') +
				(failures.length ? ` · ✗ ${failures.join(' · ')}` : '');
		} catch (e) {
			datesStatus = `✗ ${e instanceof Error ? e.message : 'Push failed'}`;
		} finally {
			datesBusy = false;
		}
	}

	async function googleSignIn() {
		googleBusy = true;
		googleStatus = '';
		try {
			await signIn(settings.google.clientId);
			googleStatus = '✓ Signed in';
		} catch (e) {
			googleStatus =
				`✗ ${e instanceof Error ? e.message : 'Sign-in failed'} — if Google showed ` +
				`"origin_mismatch", add ${location.origin} to the OAuth client's Authorized JavaScript origins`;
		} finally {
			googleBusy = false;
		}
	}

	interface PtoProposal {
		memberId: string;
		memberName: string;
		note: string;
		startDate: string;
		endDate: string;
		externalId: string;
		selected: boolean;
	}
	let ptoProposals = $state<PtoProposal[]>([]);
	let ptoSyncedMembers: string[] = [];

	/** Fetches everyone's out-of-office events and presents them for review. */
	async function fetchPtos() {
		googleBusy = true;
		googleStatus = '';
		ptoProposals = [];
		const linked = store.plan.members.filter((m) => m.googleEmail);
		if (!linked.length) {
			googleStatus = '✗ No members are linked to a Google account (see Team dialog)';
			googleBusy = false;
			return;
		}
		const timeMin = store.plan.startDate;
		const timeMax = addDays(periodEndOf(store.plan.startDate, store.plan.numWeeks), 1);
		const proposals: PtoProposal[] = [];
		const failures: string[] = [];
		for (const member of linked) {
			try {
				const events = await fetchOutOfOffice(member.googleEmail!, timeMin, timeMax);
				for (const absence of oooToAbsences(member.id, events)) {
					proposals.push({
						memberId: member.id,
						memberName: member.name,
						note: absence.note ?? 'OOO',
						startDate: absence.startDate,
						endDate: absence.endDate,
						externalId: absence.externalId,
						selected: true
					});
				}
			} catch (e) {
				failures.push(`${member.name}: ${e instanceof Error ? e.message : 'failed'}`);
			}
		}
		ptoSyncedMembers = linked
			.filter((m) => !failures.some((f) => f.startsWith(`${m.name}:`)))
			.map((m) => m.id);
		ptoProposals = proposals;
		googleStatus =
			(proposals.length
				? `${proposals.length} out-of-office event${proposals.length === 1 ? '' : 's'} found — review below`
				: '✓ No out-of-office events found in this period') +
			(failures.length ? ` · ✗ ${failures.join(' · ')}` : '');
		googleBusy = false;
	}

	function applyPtos() {
		const selected = ptoProposals
			.filter((p) => p.selected)
			.map((p) => ({
				memberId: p.memberId,
				startDate: p.startDate,
				endDate: p.endDate,
				note: p.note,
				source: 'google' as const,
				externalId: p.externalId
			}));
		const { added, updated, removed } = store.syncExternalAbsences(ptoSyncedMembers, selected);
		ptoProposals = [];
		googleStatus = `✓ PTOs applied: ${added} added, ${updated} updated, ${removed} removed`;
	}
</script>

<Modal open={settings.dialogOpen} title="Settings" onclose={close}>
	<div class="body">
		{#if serverConfig.locked}
			<p class="managed">
				🔒 Board, team and integration settings are managed by the server configuration.
			</p>
		{/if}
		<section>
			<h3>Board</h3>
			<label class="check">
				<input
					type="checkbox"
					disabled={serverConfig.locked}
					checked={store.plan.showWeekends ?? false}
					onchange={(e) => store.updatePlanMeta({ showWeekends: e.currentTarget.checked })}
				/>
				Show weekend days as gray rows (board and Excel export)
			</label>
			<div class="field">
				<span class="flabel">Working days (this period's plan)</span>
				<div class="weekdays">
					{#each DAY_LABELS as label, i (label)}
						<button
							type="button"
							class="day"
							disabled={serverConfig.locked}
							class:on={store.plan.workdays.includes(i + 1)}
							onclick={() => toggleWorkday(i + 1)}
						>
							{label}
						</button>
					{/each}
				</div>
			</div>
		</section>

		<section>
			<h3>Jira</h3>
			<p class="help">
				Create an API token at
				<code>id.atlassian.com → Security → API tokens</code> and paste it here. Credentials stay in this
				browser.
			</p>
			<label>
				Site URL
				<input
					type="url"
					disabled={serverConfig.locked}
					placeholder="https://yourorg.atlassian.net"
					value={settings.jira.baseUrl}
					oninput={(e) => settings.updateJira({ baseUrl: e.currentTarget.value.trim() })}
				/>
			</label>
			<div class="grid2">
				<label>
					Account email
					<input
						type="email"
						disabled={serverConfig.locked}
						value={settings.jira.email}
						oninput={(e) => settings.updateJira({ email: e.currentTarget.value.trim() })}
					/>
				</label>
				<label>
					API token
					<input
						type="password"
						disabled={serverConfig.locked}
						value={settings.jira.token}
						oninput={(e) => settings.updateJira({ token: e.currentTarget.value.trim() })}
					/>
				</label>
			</div>
			<div class="row">
				<button onclick={testJira} disabled={jiraBusy || !settings.jiraConfigured()}>
					{jiraBusy ? 'Testing…' : 'Test connection'}
				</button>
				<span class="status" class:err={jiraStatus.startsWith('✗')}>{jiraStatus}</span>
			</div>
			<label class="check">
				<input
					type="checkbox"
					disabled={serverConfig.locked}
					checked={settings.jira.useStoryPoints ?? false}
					onchange={(e) => settings.updateJira({ useStoryPoints: e.currentTarget.checked })}
				/>
				Use story points as estimates — 1 SP = 1 person-day (epics sum their children)
			</label>
			{#if settings.jira.useStoryPoints}
				<div class="row">
					<button onclick={checkEstimates} disabled={spBusy || !settings.jiraConfigured()}>
						{spBusy ? 'Checking…' : 'Check estimates from Jira'}
					</button>
					<span class="status" class:err={spStatus.startsWith('✗')}>{spStatus}</span>
				</div>
				{#if spProposals.length}
					<div class="proposals">
						{#each spProposals as p (p.taskId)}
							<div class="proposal">
								<input type="checkbox" bind:checked={p.selected} />
								<span class="pname" title={p.name}>{p.name}</span>
								<span class="pdelta">{p.current ?? '—'}d → {p.proposed}d</span>
								<button class="papply" onclick={() => applyProposals([p])}>Apply</button>
							</div>
						{/each}
						<div class="row">
							<button
								onclick={() => applyProposals(spProposals.filter((p) => p.selected))}
								disabled={!spProposals.some((p) => p.selected)}
							>
								Apply selected ({spProposals.filter((p) => p.selected).length})
							</button>
							<button class="danger" onclick={applyAllProposals}>Apply all…</button>
						</div>
					</div>
				{/if}
			{/if}
			<label class="check">
				<input
					type="checkbox"
					disabled={serverConfig.locked}
					checked={settings.jira.autoSync ?? false}
					onchange={(e) => settings.updateJira({ autoSync: e.currentTarget.checked })}
				/>
				Auto-sync linked tasks with Jira — on load and every {SYNC_INTERVAL_MIN} minutes
			</label>
			<p class="help">
				Refreshes auto-generated “KEY · summary” names, the “Jira status” note and epic colors
				(custom names and colors are kept), and fills <em>empty</em> estimates from story points. Existing
				estimates never change automatically — review those with “Check estimates from Jira”.
			</p>
			<div class="row">
				<button
					onclick={() => runJiraSync()}
					disabled={jiraSync.busy || !settings.jiraConfigured()}
				>
					{jiraSync.busy ? 'Syncing…' : 'Sync now'}
				</button>
				<span class="status" class:err={jiraSync.lastOutcome.startsWith('✗')}>
					{jiraSync.lastOutcome}
				</span>
			</div>
			<div class="row">
				<button
					onclick={collectDateProposals}
					disabled={datesBusy || !settings.jiraConfigured()}
					title="Write each linked task's scheduled start/end onto the Jira issue (board → Jira)"
				>
					Push dates to Jira…
				</button>
				<span class="status" class:err={datesStatus.startsWith('✗')}>{datesStatus}</span>
			</div>
			{#if dateProposals.length}
				<div class="proposals">
					{#each dateProposals as p (p.taskId)}
						<div class="proposal">
							<input type="checkbox" bind:checked={p.selected} />
							<span class="pname" title={p.name}>{p.key} · {p.name}</span>
							<span class="pdelta">{p.start} → {p.end}</span>
						</div>
					{/each}
					<div class="row">
						<button
							onclick={() => pushDates(dateProposals.filter((p) => p.selected))}
							disabled={datesBusy || !dateProposals.some((p) => p.selected)}
						>
							{datesBusy
								? 'Pushing…'
								: `Push selected (${dateProposals.filter((p) => p.selected).length})`}
						</button>
					</div>
				</div>
			{/if}
			<div class="row">
				<button
					onclick={() => {
						close();
						ui.jiraImportOpen = true;
					}}
					disabled={!settings.jiraConfigured()}
				>
					Import tasks from Jira…
				</button>
			</div>
			<p class="help">
				Also reachable from the task list, next to “＋ New task”. Individual tasks can be linked
				one-by-one from the task editor (Jira issue field).
			</p>
		</section>

		<section>
			<h3>Google Calendar</h3>
			<p class="help">
				Needs an OAuth <strong>Client ID</strong> (Web application) from
				<code>console.cloud.google.com</code> with the Calendar API enabled and
				<code>{typeof location !== 'undefined' ? location.origin : ''}</code> as an authorized
				JavaScript origin. Colleagues' calendars must be visible to your account. Link members to
				their Google accounts in the <strong>Team</strong> dialog. Tip: set
				<code>PUBLIC_GOOGLE_CLIENT_ID</code> in a <code>.env</code> file to pre-fill this for everyone
				— then signing in is the only step.
			</p>
			<label>
				OAuth Client ID
				<input
					type="text"
					disabled={serverConfig.locked}
					placeholder="1234567890-xxxx.apps.googleusercontent.com"
					value={settings.google.clientId}
					oninput={(e) => settings.updateGoogle({ clientId: e.currentTarget.value.trim() })}
				/>
			</label>
			<div class="row">
				{#if signedIn}
					<button
						onclick={() => {
							signOut();
							googleStatus = '';
						}}
					>
						Sign out
					</button>
				{:else}
					<button onclick={googleSignIn} disabled={googleBusy || !settings.google.clientId}>
						{googleBusy ? '…' : 'Sign in with Google'}
					</button>
				{/if}
				<button onclick={fetchPtos} disabled={googleBusy || !signedIn}>
					{googleBusy ? 'Fetching…' : 'Fetch PTOs…'}
				</button>
			</div>
			{#if googleStatus}
				<div class="status" class:err={googleStatus.startsWith('✗')}>{googleStatus}</div>
			{/if}
			{#if ptoProposals.length}
				<div class="proposals">
					{#each ptoProposals as p (p.externalId)}
						<div class="proposal">
							<input type="checkbox" bind:checked={p.selected} />
							<span class="pname" title="{p.memberName} · {p.note}">{p.memberName} · {p.note}</span>
							<span class="pdelta">
								{formatMonthDay(p.startDate)} → {formatMonthDay(p.endDate)}
							</span>
						</div>
					{/each}
					<div class="row">
						<button
							onclick={applyPtos}
							disabled={googleBusy || !ptoProposals.some((p) => p.selected)}
						>
							Apply selected ({ptoProposals.filter((p) => p.selected).length})
						</button>
						<button class="papply" onclick={() => ptoProposals.forEach((p) => (p.selected = true))}>
							All
						</button>
						<button
							class="papply"
							onclick={() => ptoProposals.forEach((p) => (p.selected = false))}
						>
							None
						</button>
					</div>
				</div>
			{/if}
			<label>
				Company holidays calendar
				<div class="row">
					<input
						type="text"
						disabled={serverConfig.locked}
						placeholder="e.g. en.italian#holiday@group.v.calendar.google.com"
						value={settings.google.holidayCalendarId ?? ''}
						oninput={(e) =>
							settings.updateGoogle({ holidayCalendarId: e.currentTarget.value.trim() })}
					/>
					<button onclick={loadCalendars} disabled={!signedIn}>My calendars…</button>
				</div>
			</label>
			{#if calendarChoices.length}
				<label>
					Pick a calendar
					<select
						onchange={(e) => {
							if (e.currentTarget.value) {
								settings.updateGoogle({ holidayCalendarId: e.currentTarget.value });
							}
						}}
					>
						<option value="">— choose —</option>
						{#each calendarChoices as c (c.id)}
							<option value={c.id} selected={c.id === settings.google.holidayCalendarId}>
								{c.summary}
							</option>
						{/each}
					</select>
				</label>
			{/if}
			<div class="row">
				<button
					onclick={fetchHolidays}
					disabled={googleBusy || !signedIn || !settings.google.holidayCalendarId}
					title="Adds the calendar's dates as company holidays of the current period"
				>
					{googleBusy ? 'Fetching…' : 'Fetch holidays…'}
				</button>
				<span class="status" class:err={holStatus.startsWith('✗')}>{holStatus}</span>
			</div>
			{#if holidayProposals.length}
				<div class="proposals">
					{#each holidayProposals as p (p.date)}
						<div class="proposal">
							<input type="checkbox" bind:checked={p.selected} />
							<span class="pname">{formatMonthDay(p.date)}</span>
							<span class="pdelta">{p.date}</span>
						</div>
					{/each}
					<div class="row">
						<button onclick={applyHolidays} disabled={!holidayProposals.some((p) => p.selected)}>
							Apply selected ({holidayProposals.filter((p) => p.selected).length})
						</button>
						<button
							class="papply"
							onclick={() => holidayProposals.forEach((p) => (p.selected = true))}
						>
							All
						</button>
						<button
							class="papply"
							onclick={() => holidayProposals.forEach((p) => (p.selected = false))}
						>
							None
						</button>
					</div>
				</div>
			{/if}
		</section>
	</div>
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 20px;
		font-size: 12.5px;
		min-width: 420px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin: 0 0 8px;
	}
	.managed {
		margin: 0;
		font-size: 12px;
		color: var(--warn);
	}
	.help {
		color: var(--text-muted);
		margin: 0 0 10px;
		line-height: 1.45;
	}
	code {
		background: var(--hover);
		border-radius: 4px;
		padding: 0 4px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
		color: var(--text-mid);
		margin-bottom: 10px;
	}
	input {
		font: inherit;
		font-weight: 400;
		padding: 6px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		width: 100%;
	}
	.flabel {
		display: block;
		margin-bottom: 4px;
	}
	.field {
		font-weight: 600;
		color: var(--text-mid);
		margin-top: 10px;
	}
	.weekdays {
		display: flex;
		gap: 4px;
	}
	.day {
		font: inherit;
		font-size: 11.5px;
		padding: 4px 0;
		width: 44px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text-muted);
		cursor: pointer;
	}
	.day.on {
		background: var(--chip-active-bg);
		border-color: var(--chip-active-bg);
		color: var(--chip-active-text);
		font-weight: 600;
	}
	.check {
		flex-direction: row;
		align-items: center;
		gap: 8px;
		font-weight: 500;
		margin-bottom: 0;
	}
	.check input {
		width: auto;
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 6px;
	}
	.row input {
		flex: 1;
	}
	button {
		font: inherit;
		font-size: 12px;
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:not(:disabled) {
		background: var(--hover);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.proposals {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 6px 8px;
		margin-bottom: 10px;
		max-height: 220px;
		overflow-y: auto;
	}
	.proposal {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 0;
		font-size: 12px;
	}
	.pname {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pdelta {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.papply {
		flex: none;
		padding: 2px 8px;
		font-size: 11px;
	}
	.danger {
		color: var(--danger);
		border-color: var(--danger-border);
	}
	.danger:hover:not(:disabled) {
		background: var(--danger-bg);
	}
	.status {
		font-size: 12px;
		color: var(--ok);
	}
	.status.err {
		color: var(--danger);
	}
</style>
