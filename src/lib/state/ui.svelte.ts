export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'gantt-theme';

function loadTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'system';
	const saved = localStorage.getItem(THEME_KEY);
	return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

/** Ephemeral UI state — never part of the plan document. */
export class UiStore {
	/** People-board (members × days) or classic Gantt (tasks × days). */
	viewMode = $state<'board' | 'gantt'>('board');
	/** Task-list sidebar. */
	sidebarCollapsed = $state(false);
	sidebarWidth = $state(270);
	/** Gantt: ids of parent tasks whose workstreams are collapsed. */
	ganttCollapsed = $state<Record<string, boolean>>({});
	/** 'all' or a group id; drives the async per-sub-team view. */
	groupFilter = $state<string>('all');
	ptoMode = $state(false);
	/** Row height in px. */
	zoom = $state(24);
	/** Minimum column width in px (columns still stretch to fill spare space). */
	colWidth = $state(120);
	/** Bumped by the toolbar's "Fit" button; the grid reacts by shrinking columns to fit. */
	fitColumnsRequest = $state(0);

	/**
	 * Spotlight: one or more tasks (+ their descendants) or a whole sub-team's
	 * tasks stay vivid, everything else is muted. ⌘/Ctrl-click toggles tasks in
	 * and out of the selection; ⇧-click selects a range.
	 */
	highlight = $state<{ kind: 'group'; id: string } | { kind: 'tasks'; ids: string[] } | null>(null);
	#lastTaskAnchor: string | null = null;
	/** Right-click menu for the current task selection (assignmentId set when opened on a block). */
	contextMenu = $state<{ x: number; y: number; assignmentId?: string } | null>(null);
	/** Task-paint mode: drag on the board to add chunks of this task (PTO-style). */
	paintTask = $state<{ taskId: string } | null>(null);
	/** ⌥-drag from the task list: the board cell under the cursor, highlighted by the grid. */
	backlogDropCell = $state<{ memberId: string; date: string } | null>(null);

	theme = $state<Theme>(loadTheme());

	taskDialog = $state<{ open: boolean; taskId?: string; parentId?: string }>({ open: false });
	splitDialog = $state<{ open: boolean; taskId?: string }>({ open: false });
	teamDialogOpen = $state(false);
	jiraImportOpen = $state(false);

	popover = $state<{ kind: 'assignment' | 'absence'; id: string; x: number; y: number } | null>(
		null
	);

	setTheme(theme: Theme) {
		this.theme = theme;
		if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, theme);
	}

	toggleHighlight(kind: 'task' | 'group', id: string) {
		if (kind === 'group') {
			this.highlight = this.isHighlighted('group', id) ? null : { kind: 'group', id };
			return;
		}
		this.selectTask(id);
	}

	/**
	 * Click semantics: plain = single spotlight (click again to clear);
	 * toggle (⌘/Ctrl) = add/remove from the selection; rangeOrder (⇧) = select
	 * the visible range from the last clicked task.
	 */
	selectTask(id: string, opts: { toggle?: boolean; rangeOrder?: string[] | null } = {}) {
		const current = this.highlight?.kind === 'tasks' ? [...this.highlight.ids] : [];
		let ids: string[];
		const anchor = this.#lastTaskAnchor;
		if (
			opts.rangeOrder &&
			anchor &&
			opts.rangeOrder.includes(anchor) &&
			opts.rangeOrder.includes(id)
		) {
			const a = opts.rangeOrder.indexOf(anchor);
			const b = opts.rangeOrder.indexOf(id);
			const range = opts.rangeOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
			ids = opts.toggle ? [...new Set([...current, ...range])] : range;
		} else if (opts.toggle) {
			ids = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
		} else {
			ids = current.length === 1 && current[0] === id ? [] : [id];
		}
		this.#lastTaskAnchor = id;
		this.highlight = ids.length ? { kind: 'tasks', ids } : null;
	}

	/** Replaces the spotlight selection wholesale (drag-select); anchor feeds later ⇧-ranges. */
	setSelection(ids: string[], anchor?: string) {
		this.highlight = ids.length ? { kind: 'tasks', ids } : null;
		if (anchor) this.#lastTaskAnchor = anchor;
	}

	selectedTaskIds(): string[] {
		return this.highlight?.kind === 'tasks' ? this.highlight.ids : [];
	}

	isHighlighted(kind: 'task' | 'group', id: string): boolean {
		if (!this.highlight) return false;
		if (kind === 'group') return this.highlight.kind === 'group' && this.highlight.id === id;
		return this.highlight.kind === 'tasks' && this.highlight.ids.includes(id);
	}

	openNewTask(parentId?: string) {
		this.taskDialog = { open: true, parentId };
	}
	openEditTask(taskId: string) {
		this.taskDialog = { open: true, taskId };
	}
	openSplit(taskId: string) {
		this.splitDialog = { open: true, taskId };
	}
	closeDialogs() {
		this.taskDialog = { open: false };
		this.splitDialog = { open: false };
		this.teamDialogOpen = false;
		this.jiraImportOpen = false;
	}
}

export const ui = new UiStore();
