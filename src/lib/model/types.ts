/** ISO calendar date, e.g. '2026-06-11'. String comparison === chronological comparison. */
export type ISODate = string;

export interface Group {
	id: string;
	name: string;
	/** Shown on the right edge of the team's blocks; clicking it spotlights the team's tasks. */
	emoji?: string;
}

export interface Member {
	id: string;
	name: string;
	groupId?: string;
	/** Google account for Calendar out-of-office sync. */
	googleEmail?: string;
}

/**
 * A unit of work. Tasks form a tree via parentId: a top-level task
 * ("Supply Chain MVP – Findings Page") can have per-group child workstreams
 * (FE workstream, BE workstream). Assignments attach to any task, but
 * typically to leaves. Rollups aggregate over the whole subtree.
 */
export interface Task {
	id: string;
	name: string;
	color: string;
	parentId?: string;
	groupId?: string;
	estimateDays?: number;
	/** Keep estimateDays equal to the children's rollup, recomputed on every commit. */
	autoEstimate?: boolean;
	notes?: string;
	/**
	 * Task ids that must fully finish (including all their workstreams) before
	 * any work on this task starts. Inherited by descendant workstreams.
	 */
	dependsOn?: string[];
	/** Linked Jira issue key, e.g. 'VULN-123'. */
	jiraKey?: string;
	/** Manual Gantt position among siblings; unset = sorted by start date. */
	ganttRank?: number;
}

/**
 * One member's share of a task, in person-days. Splitting a task between
 * members = several assignments to the same task. Position in the member's
 * work queue is `order`; the scheduler packs queues front-to-back with no
 * idle gaps, so moving a block is just an order change.
 */
export interface Assignment {
	id: string;
	taskId: string;
	memberId: string;
	days: number;
	order: number;
}

/** Personal time off; both ends inclusive. Company-wide holidays live on Plan.holidays. */
export interface Absence {
	id: string;
	memberId: string;
	startDate: ISODate;
	endDate: ISODate;
	note?: string;
	/** Set when imported from an external calendar; manual absences leave it unset. */
	source?: 'google';
	/** External event id, used to upsert on re-sync. */
	externalId?: string;
}

export interface Plan {
	id: string;
	name: string;
	schemaVersion: number;
	/** First day of the timeline. */
	startDate: ISODate;
	/** Rendered horizon, in weeks. */
	numWeeks: number;
	/** Working weekdays, ISO numbering (1 = Monday … 7 = Sunday). */
	workdays: number[];
	/** Render weekend (non-working) days as gray rows on the board and in exports. */
	showWeekends?: boolean;
	holidays: ISODate[];
	groups: Group[];
	members: Member[];
	tasks: Task[];
	assignments: Assignment[];
	absences: Absence[];
}

export const SCHEMA_VERSION = 1;

export function newId(): string {
	return crypto.randomUUID();
}
