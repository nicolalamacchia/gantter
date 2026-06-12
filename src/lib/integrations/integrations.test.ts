import { describe, expect, it } from 'vitest';
import { PALETTE } from '$lib/model/colors';
import type { Task } from '$lib/model/types';
import { eventToOoo, expandEventDates, oooToAbsences } from './google';
import {
	buildJiraSyncUpdates,
	issuesToTasks,
	jiraColorToHex,
	pickEpicColorField,
	pickStoryPointsFields,
	storyPointsToDays
} from './jira';

describe('issuesToTasks', () => {
	const existing: Task[] = [
		{ id: 't1', name: 'VULN-1 · Done before', color: '#f5c6cb', jiraKey: 'VULN-1' }
	];

	it('maps issues to tasks and skips already-linked keys', () => {
		const tasks = issuesToTasks(
			[
				{ key: 'VULN-1', summary: 'Already here' },
				{ key: 'VULN-2', summary: 'Findings page', status: 'In Progress' }
			],
			existing
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].name).toBe('VULN-2 · Findings page');
		expect(tasks[0].jiraKey).toBe('VULN-2');
		expect(tasks[0].notes).toBe('Jira status: In Progress');
		expect(tasks[0].color).not.toBe('#f5c6cb'); // existing color is avoided
	});

	it('assigns distinct colors to a batch', () => {
		const tasks = issuesToTasks(
			[
				{ key: 'A-1', summary: 'one' },
				{ key: 'A-2', summary: 'two' }
			],
			[]
		);
		expect(tasks[0].color).not.toBe(tasks[1].color);
	});

	it('attaches child work items to their new parent and inherits its color by default', () => {
		const tasks = issuesToTasks(
			[
				{ key: 'E-1', summary: 'Epic', color: '#2684ff' },
				{ key: 'S-1', summary: 'Story', parentKey: 'E-1', color: '#57d9a3', storyPoints: 3 },
				{ key: 'S-9', summary: 'Orphan', parentKey: 'E-404' }
			],
			[]
		);
		const epic = tasks.find((t) => t.jiraKey === 'E-1')!;
		const story = tasks.find((t) => t.jiraKey === 'S-1')!;
		expect(story.parentId).toBe(epic.id);
		expect(story.color).toBe('#2684ff'); // inherited from the epic
		expect(story.estimateDays).toBe(3); // children keep their own estimates
		expect(tasks.find((t) => t.jiraKey === 'S-9')!.parentId).toBeUndefined();
	});

	it('links whole multi-level trees: epic → story → subtask', () => {
		const tasks = issuesToTasks(
			[
				{ key: 'E-1', summary: 'Epic', color: '#2684ff' },
				{ key: 'S-1', summary: 'Story', parentKey: 'E-1' },
				{ key: 'SUB-1', summary: 'Subtask', parentKey: 'S-1' }
			],
			[]
		);
		const epic = tasks.find((t) => t.jiraKey === 'E-1')!;
		const story = tasks.find((t) => t.jiraKey === 'S-1')!;
		const sub = tasks.find((t) => t.jiraKey === 'SUB-1')!;
		expect(story.parentId).toBe(epic.id);
		expect(sub.parentId).toBe(story.id);
		expect(sub.color).toBe(epic.color); // inheritance cascades down the tree
	});

	it('keeps child colors when inheritance is off and attaches to existing linked parents', () => {
		const existingEpic: Task = {
			id: 'tEpic',
			name: 'E-1 · Epic',
			color: '#2684ff',
			jiraKey: 'E-1'
		};
		const tasks = issuesToTasks(
			[{ key: 'S-1', summary: 'Story', parentKey: 'E-1', color: '#57d9a3' }],
			[existingEpic],
			{ inheritParentColor: false }
		);
		expect(tasks[0].parentId).toBe('tEpic');
		expect(tasks[0].color).toBe('#57d9a3');
	});

	it("prefers the issue's own Jira epic color over the palette", () => {
		const tasks = issuesToTasks(
			[
				{ key: 'A-1', summary: 'colored', color: '#8eb021' },
				{ key: 'A-2', summary: 'plain' }
			],
			[]
		);
		expect(tasks[0].color).toBe('#8eb021');
		expect(tasks[1].color).not.toBe('#8eb021');
	});
});

describe('epic colors', () => {
	it('maps classic ghx-labels, agile color keys, names and raw hex', () => {
		expect(jiraColorToHex('ghx-label-6')).toBe('#8eb021');
		expect(jiraColorToHex('color_2')).toBe('#2684ff');
		expect(jiraColorToHex('purple')).toBe('#8777d9');
		expect(jiraColorToHex('Dark Teal')).toBe('#00a3bf');
		expect(jiraColorToHex('#AABBCC')).toBe('#aabbcc');
		expect(jiraColorToHex('no-such-color')).toBeUndefined();
		expect(jiraColorToHex(7)).toBeUndefined();
	});

	it('finds the epic color field by schema or by name', () => {
		expect(
			pickEpicColorField([
				{ id: 'customfield_1', name: 'Sprint' },
				{
					id: 'customfield_2',
					name: 'Epic Colour',
					schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-color' }
				}
			])
		).toBe('customfield_2');
		expect(pickEpicColorField([{ id: 'customfield_3', name: 'Epic Color' }])).toBe('customfield_3');
		expect(pickEpicColorField([{ id: 'customfield_1', name: 'Sprint' }])).toBeNull();
	});
});

describe('story points', () => {
	it('collects ALL story-points candidates — sites often have two and either may hold the value', () => {
		expect(
			pickStoryPointsFields([
				{ id: 'customfield_1', name: 'Sprint' },
				{ id: 'customfield_2', name: 'Story point estimate' },
				{ id: 'customfield_3', name: 'Story Points' },
				{ id: 'customfield_4', name: 'Story Points (legacy)' }
			])
		).toEqual(['customfield_3', 'customfield_2', 'customfield_4']);
		expect(pickStoryPointsFields([{ id: 'customfield_1', name: 'Sprint' }])).toEqual([]);
	});

	it('converts story points to person-days (1 SP = 1 day, min 1)', () => {
		expect(storyPointsToDays(8)).toBe(8);
		expect(storyPointsToDays(2.5)).toBe(3);
		expect(storyPointsToDays(0.5)).toBe(1);
	});

	it('issuesToTasks maps story points to estimates', () => {
		const tasks = issuesToTasks(
			[
				{ key: 'A-1', summary: 'with sp', storyPoints: 5 },
				{ key: 'A-2', summary: 'without sp' }
			],
			[]
		);
		expect(tasks[0].estimateDays).toBe(5);
		expect(tasks[1].estimateDays).toBeUndefined();
	});
});

describe('buildJiraSyncUpdates', () => {
	it('refreshes auto-generated names, the status note and auto-assigned colors', () => {
		const tasks: Task[] = [
			{
				id: 't1',
				name: 'A-1 · Old summary',
				color: PALETTE[0],
				jiraKey: 'A-1',
				notes: 'Jira status: To Do\nkeep this line'
			}
		];
		const updates = buildJiraSyncUpdates(tasks, [
			{ key: 'A-1', summary: 'New summary', status: 'In Progress', color: '#8eb021' }
		]);
		expect(updates).toEqual([
			{
				taskId: 't1',
				fields: {
					name: 'A-1 · New summary',
					notes: 'Jira status: In Progress\nkeep this line',
					color: '#8eb021'
				}
			}
		]);
	});

	it('keeps customized names, colors and untracked notes', () => {
		const tasks: Task[] = [
			{
				id: 't1',
				name: 'My own name',
				color: '#123456',
				jiraKey: 'A-1',
				notes: 'my private notes'
			}
		];
		const updates = buildJiraSyncUpdates(tasks, [
			{ key: 'A-1', summary: 'New summary', status: 'Done', color: '#8eb021' }
		]);
		expect(updates).toEqual([]);
	});

	it('follows Jira when the color was previously synced from Jira', () => {
		const tasks: Task[] = [{ id: 't1', name: 'A-1 · x', color: '#2684ff', jiraKey: 'A-1' }];
		const updates = buildJiraSyncUpdates(tasks, [{ key: 'A-1', summary: 'x', color: '#57d9a3' }]);
		expect(updates[0]?.fields).toEqual({ color: '#57d9a3' });
	});

	it('fills only EMPTY estimates from story points', () => {
		const tasks: Task[] = [
			{ id: 't1', name: 'A-1 · x', color: PALETTE[0], jiraKey: 'A-1', estimateDays: 5 },
			{ id: 't2', name: 'A-2 · y', color: PALETTE[1], jiraKey: 'A-2' }
		];
		const updates = buildJiraSyncUpdates(
			tasks,
			[
				{ key: 'A-1', summary: 'x', storyPoints: 8 },
				{ key: 'A-2', summary: 'y', storyPoints: 3 }
			],
			{ useStoryPoints: true }
		);
		expect(updates).toEqual([{ taskId: 't2', fields: { estimateDays: 3 } }]);
	});

	it('ignores tasks whose issue was not fetched (deleted or unlinked)', () => {
		const tasks: Task[] = [{ id: 't1', name: 'A-1 · x', color: PALETTE[0], jiraKey: 'A-1' }];
		expect(buildJiraSyncUpdates(tasks, [])).toEqual([]);
	});
});

describe('eventToOoo', () => {
	it('treats all-day end dates as exclusive', () => {
		const ooo = eventToOoo({
			id: 'e1',
			summary: 'PTO',
			start: { date: '2026-07-01' },
			end: { date: '2026-07-04' } // exclusive → last day off is Jul 3
		});
		expect(ooo).toEqual({
			id: 'e1',
			summary: 'PTO',
			startDate: '2026-07-01',
			endDate: '2026-07-03'
		});
	});

	it('ignores hour-scoped events — only whole-day OOO counts as PTO', () => {
		expect(
			eventToOoo({
				id: 'e2',
				start: { dateTime: '2026-07-01T09:00:00+02:00' },
				end: { dateTime: '2026-07-01T18:00:00+02:00' }
			})
		).toBeNull();
		expect(eventToOoo({ summary: 'no id' })).toBeNull();
	});
});

describe('expandEventDates', () => {
	it('expands all-day ranges with exclusive ends and handles timed events', () => {
		expect(
			expandEventDates({ id: 'h1', start: { date: '2026-12-24' }, end: { date: '2026-12-27' } })
		).toEqual(['2026-12-24', '2026-12-25', '2026-12-26']);
		expect(
			expandEventDates({ id: 'h2', start: { dateTime: '2026-08-15T00:00:00+02:00' } })
		).toEqual(['2026-08-15']);
		expect(expandEventDates({ id: 'h3' })).toEqual([]);
	});
});

describe('oooToAbsences', () => {
	it('produces google-sourced absence facts with external ids', () => {
		const absences = oooToAbsences('m1', [
			{ id: 'evt-1', summary: 'Conference', startDate: '2026-07-06', endDate: '2026-07-08' }
		]);
		expect(absences).toEqual([
			{
				memberId: 'm1',
				startDate: '2026-07-06',
				endDate: '2026-07-08',
				note: 'Conference',
				source: 'google',
				externalId: 'evt-1'
			}
		]);
	});
});
