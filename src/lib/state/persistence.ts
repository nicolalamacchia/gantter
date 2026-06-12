import { SCHEMA_VERSION, type Plan } from '$lib/model/types';

/**
 * Storage holds a registry of plans, one per period (quarter or custom range),
 * plus which one is active. Older versions stored a single plan under the
 * legacy key; that is migrated on first load.
 */
const REGISTRY_KEY = 'gantter-plans';
const LEGACY_KEY = 'gantt-planner-doc';

function migrate(doc: unknown): Plan | null {
	if (!doc || typeof doc !== 'object') return null;
	const plan = doc as Plan;
	if (
		typeof plan.schemaVersion !== 'number' ||
		plan.schemaVersion > SCHEMA_VERSION ||
		// The period (dates/quarter) must round-trip: imports attach to the
		// period the file describes, so a plan without one is unusable.
		!/^\d{4}-\d{2}-\d{2}$/.test(plan.startDate ?? '') ||
		typeof plan.numWeeks !== 'number' ||
		plan.numWeeks < 1 ||
		!Array.isArray(plan.members) ||
		!Array.isArray(plan.tasks) ||
		!Array.isArray(plan.assignments)
	) {
		return null;
	}
	// Future schema migrations chain here, bumping plan.schemaVersion step by step.
	return plan;
}

export interface PlanBoot {
	registry: Record<string, Plan>;
	active: Plan;
}

/** Parses a stored registry payload; exported for tests. */
export function parseRegistry(raw: string): PlanBoot | null {
	try {
		const doc = JSON.parse(raw) as { activeId?: string; plans?: Record<string, unknown> };
		if (!doc || typeof doc !== 'object' || !doc.plans) return null;
		const registry: Record<string, Plan> = {};
		for (const [id, candidate] of Object.entries(doc.plans)) {
			const plan = migrate(candidate);
			if (plan) registry[id] = plan;
		}
		const ids = Object.keys(registry);
		if (!ids.length) return null;
		const active = registry[doc.activeId ?? ''] ?? registry[ids[0]];
		return { registry, active };
	} catch {
		return null;
	}
}

export function loadBoot(): PlanBoot | null {
	if (typeof localStorage === 'undefined') return null;
	const raw = localStorage.getItem(REGISTRY_KEY);
	if (raw) return parseRegistry(raw);
	// Legacy single-plan storage → wrap into a registry.
	try {
		const legacy = localStorage.getItem(LEGACY_KEY);
		if (!legacy) return null;
		const plan = migrate(JSON.parse(legacy));
		if (!plan) return null;
		return { registry: { [plan.id]: plan }, active: plan };
	} catch {
		return null;
	}
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function saveRegistry(activeId: string, plans: Record<string, Plan>): void {
	if (typeof localStorage === 'undefined') return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		localStorage.setItem(REGISTRY_KEY, JSON.stringify({ activeId, plans }));
	}, 250);
}

export function planToJSON(plan: Plan): string {
	return JSON.stringify(plan, null, 2);
}

export function planFromJSON(json: string): Plan {
	const plan = migrate(JSON.parse(json));
	if (!plan) throw new Error('Not a valid plan file');
	return plan;
}
