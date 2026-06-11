import { addDays, quarterOf, startOfWeek, toISO } from '$lib/engine/calendar';
import { PALETTE } from '$lib/model/colors';
import { SCHEMA_VERSION, type Plan } from '$lib/model/types';

/**
 * Demo plan covering the current quarter — generic, anonymous people and
 * projects (nothing real), in the structural spirit of the original sheet.
 */
export function createDemoPlan(): Plan {
	const quarter = quarterOf(toISO(new Date()));
	const monday = startOfWeek(addDays(quarter.start, 6)); // first full week of the quarter
	return {
		id: 'demo',
		name: quarter.label,
		schemaVersion: SCHEMA_VERSION,
		startDate: quarter.start,
		numWeeks: quarter.weeks,
		workdays: [1, 2, 3, 4, 5],
		holidays: [addDays(monday, 28)], // a Monday off, four weeks in
		groups: [
			{ id: 'fe', name: 'Frontend', emoji: '🎨' },
			{ id: 'be', name: 'Backend', emoji: '🛠️' }
		],
		members: [
			{ id: 'alice', name: 'Alice', groupId: 'fe' },
			{ id: 'ben', name: 'Ben', groupId: 'fe' },
			{ id: 'carla', name: 'Carla', groupId: 'be' },
			{ id: 'dan', name: 'Dan', groupId: 'be' }
		],
		tasks: [
			{ id: 'search', name: 'Search Revamp', color: PALETTE[0], estimateDays: 12 },
			{ id: 'billing', name: 'Billing Migration', color: PALETTE[1], estimateDays: 20 },
			{ id: 'rep', name: 'Reporting MVP – Data Export', color: PALETTE[4] },
			{
				id: 'rep-fe',
				name: 'FE',
				color: PALETTE[4],
				parentId: 'rep',
				groupId: 'fe',
				estimateDays: 8
			},
			{
				id: 'rep-be',
				name: 'BE',
				color: PALETTE[9],
				parentId: 'rep',
				groupId: 'be',
				estimateDays: 10
			},
			{
				id: 'dash',
				name: 'Reporting MVP – Dashboard',
				color: PALETTE[2],
				estimateDays: 15,
				dependsOn: ['rep']
			},
			{
				id: 'api',
				name: 'Public API v2',
				color: PALETTE[3],
				estimateDays: 8,
				jiraKey: 'DEMO-42'
			}
		],
		assignments: [
			{ id: 'a1', taskId: 'search', memberId: 'alice', days: 6, order: 0 },
			{ id: 'a2', taskId: 'search', memberId: 'ben', days: 6, order: 0 },
			{ id: 'a3', taskId: 'billing', memberId: 'alice', days: 10, order: 1 },
			{ id: 'a4', taskId: 'billing', memberId: 'ben', days: 10, order: 1 },
			{ id: 'a5', taskId: 'rep-fe', memberId: 'alice', days: 5, order: 2 },
			{ id: 'a6', taskId: 'rep-fe', memberId: 'ben', days: 3, order: 2 },
			{ id: 'a7', taskId: 'rep-be', memberId: 'carla', days: 6, order: 0 },
			{ id: 'a8', taskId: 'rep-be', memberId: 'dan', days: 4, order: 0 },
			{ id: 'a9', taskId: 'api', memberId: 'carla', days: 8, order: 1 }
		],
		absences: [
			{
				id: 'pto1',
				memberId: 'dan',
				startDate: addDays(monday, 14),
				endDate: addDays(monday, 18),
				note: 'PTO'
			},
			{
				id: 'pto2',
				memberId: 'alice',
				startDate: addDays(monday, 10),
				endDate: addDays(monday, 11),
				note: 'PTO'
			}
		]
	};
}
