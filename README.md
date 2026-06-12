# <img src="src/lib/assets/favicon.svg" width="28" alt=""> Gantter

_Team capacity planner. Yes, named after that guy from Central Perk._

A spreadsheet-style team planning board: people across columns (grouped by sub-team), working days
down the rows, colored blocks for task assignments. The schedule is **computed** from a small set
of facts — tasks, per-member assignments, PTO, holidays — so moving or resizing anything
automatically repacks everyone's queue. Exports back to Excel/Google Sheets in the familiar
colored-grid format.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

Data persists automatically in the browser (localStorage). Use **Data → Export plan file** for a
portable JSON backup, and **Data → Export Excel** for the colored spreadsheet (imports cleanly
into Google Sheets).

### Run with Docker

```sh
docker compose up --build      # http://localhost:3000
```

The compose file passes optional `PUBLIC_*` defaults through from your shell or a local `.env`
(see Integrations). Secrets like a Jira token belong in a mounted `gantter.config.json`, never
in the image — the `.dockerignore` keeps them out of the build context too.

## Concepts

- **Task** — unit of work with a color and an estimate in person-days. The editor offers 12
  well-contrasted primary/secondary colors plus a custom color picker; block text flips between
  black and white automatically to stay readable (on the board and in the Excel export). Tasks
  can have child _workstreams_ (e.g. an FE and a BE child for one main task), each owned by a
  **sub-team**, and can **depend on** other tasks.
- **Assignment** — one member's share of a task (in days) plus a position in that member's queue.
  Splitting a task between people = several assignments.
- **Scheduling** — each member's queue is packed front-to-back over working days with no idle
  gaps, skipping weekends, company holidays and that member's PTO. PTO in the middle of an
  assignment splits the block (shown with `⋯`); removing/resizing anything repacks what follows.
  A task never starts before its dependencies (including all their workstreams) finish; while one
  is blocked, the next ready task in the queue runs instead.
- **Sync/async** — filter the board to one sub-team to plan independently (_async_); the rollup
  strip always shows each top-level task's overall span across all sub-teams (_sync_).

## Using the board

| Action                       | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch views                 | **Board** (people × days) or **Gantt** (tasks × days) toggle in the toolbar; the Excel export contains a sheet for each. In the Gantt, rows are ordered by start date (▲▼ on hover nudges a task among its siblings and freezes a manual order), ▾/▸ collapses a parent's workstreams (the parent bar keeps showing the whole subtree) and ⊞/⊟ in the corner expand/collapse all                                                                                                                                                                                                                                    |
| Create / edit a task         | **＋ New task** in the sidebar, or ✎ on a task row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Delete a task                | ✕ on a task row (confirms; removes its workstreams and assignments too), or **Delete** in the task editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Add a sub-team workstream    | ＋ on a top-level task row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Schedule / split a task      | ▸ on a task row, pick members and days — or ⌥-drag the task (or the whole selection) from the list onto a member's column: each task lands as a block of its remaining estimate, queued at the drop date (tasks without an estimate, or already fully scheduled, are skipped)                                                                                                                                                                                                                                                                                                                                       |
| Move a block                 | Drag it — moves within the person's own lane; **⇧-drag to move it to another person**; ⌥/Alt-drag moves all members' shares of the task together; ⌘-drag (Ctrl elsewhere) drops it into the middle of another block, splitting it; ⌥⌘-drag (Ctrl+Alt elsewhere) carves off the chunk from the grabbed day to the end and moves just that piece — the grid suppresses the browser context menu so these never fight it. The board rearranges live while dragging; the change is saved on release (Esc cancels)                                                                                                       |
| Resize a block               | Drag its bottom edge (live preview, saved on release)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Discover actions             | Dwell on any block for a moment — a card shows its full title and all drag/click actions with their modifiers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Spotlight / edit a block     | Click a block to spotlight its task (⌘/Ctrl adds to the selection); right-click it (or a task row in the sidebar) for the actions menu — edit days, remove, paint chunks, move to another period, set the selection's parent task, open the linked Jira issue, delete the selection                                                                                                                                                                                                                                                                                                                                 |
| Track dependencies           | Edit a task → "Depends on"; the schedule keeps it after those tasks finish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Spotlight a task             | Click a task in the sidebar, the rollup strip, or a Gantt row — it and its subtasks stay vivid, everything else is muted. ⌘/Ctrl-click adds or removes tasks from the selection, ⇧-click selects a range, and dragging across task-list rows selects the swept range (⌘/Ctrl-drag adds it). Workstream blocks show a side bar in the parent's color (click = spotlight the family) and the sub-team's emoji on the right (click = spotlight the whole team's tasks). Esc or clicking empty space clears                                                                                                             |
| Continue a task elsewhere    | Right-click → "↪ Continue in Q…" creates the same task (same identity, no assignments) in the next period, keeping this period's part; or pick "Continue a task from another period" in the New-task dialog for any timeframe                                                                                                                                                                                                                                                                                                                                                                                       |
| Move tasks to another period | Select tasks, right-click → "Move to Q…": they transfer with workstreams and assignments, keeping each one's working-day offset from the period start. Tasks that then run past the target period get a ⚠ (hover for details) for you to resolve. Not undoable. Any drag, resize, or day-edit that pushes a task's end later than the period's end offers to roll over **only the overflowing days** — they continue in the next quarter as the same task, just for the people whose work spills, while the fitting part stays put. Reducing days never prompts. Blocks that continue show a ⤵ at their bottom edge |
| Team emoji                   | Pick per sub-team in **👥 Team** (dropdown with a clear option); appears on the team's blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Paint extra task chunks      | Right-click a task or block → "🖌 Paint chunks": drag on any member's column (PTO-style); painted days touching an existing block of that task extend it, otherwise they become a separate chunk. Esc / Done to finish                                                                                                                                                                                                                                                                                                                                                                                              |
| Add PTO                      | Toggle **🏖 PTO**, drag over a member's days; click painted cells to remove                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Move / resize PTO            | Drag the block (working-day length is kept — it rolls over weekends/holidays; ⇧ to move it to another person), drag its bottom edge to resize                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Rename / delete PTO          | Click the block to set a title (PTO, conference, …) or delete it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Company holiday              | Click a date in the left column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Working days                 | **⚙ Settings → Board** — toggle which weekdays count as working, per period's plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Holidays from Google         | **⚙ Settings → Google Calendar** — pick a holidays calendar (one of yours or a public regional one) and fetch its dates into the current period as company holidays                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Show weekends                | **⚙ Settings → Board** — renders Sat/Sun as gray rows on the board, in the Gantt and in the Excel export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Timeline period              | Each period owns its own plan: the quarter picker switches between them (● marks quarters with data), new quarters start empty with your team carried over, and imported plan files attach to the period they describe (replacing that period's plan after a confirm). **Custom…** adjusts the active plan's range                                                                                                                                                                                                                                                                                                  |
| Column width                 | **Cols** slider sets exact column width; **⇤⇥ Fit** sizes columns so the whole team fits the view (also the default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Theme                        | Light / Dark / System selector in the toolbar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Undo / redo                  | ⌘Z / ⇧⌘Z                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Integrations (⚙ Settings)

Credentials live only in this browser's localStorage and never travel with exported plan files.
A `.env` file can pre-fill everything so a fresh browser needs zero setup:

```sh
PUBLIC_GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
PUBLIC_JIRA_BASE_URL=https://yourorg.atlassian.net
PUBLIC_JIRA_EMAIL=you@yourorg.com
PUBLIC_JIRA_TOKEN=…
```

`PUBLIC_` values are readable by anyone who can open the app — fine for a personal/localhost
setup, but don't bake your personal Jira token into a deployment other people use.

### Server-provisioned config

For a shared deployment, drop a `gantter.config.json` next to where the server starts (or point
`GANTTER_CONFIG` at one) — see `gantter.config.example.json`. It can provision the **team**
(groups/members, upserted by id into the active plan — nothing is ever deleted), **board
defaults** (working days, weekends) and **integration settings**. With `"locked": false` it only
fills fresh setups and empty fields; with `"locked": true` the provisioned values are enforced
and their fields become read-only in the UI. Personal preferences (theme, zoom, sidebar) always
stay with the user.

### Jira

1. Create an API token at **id.atlassian.com → Security → API tokens**.
2. In **⚙ Settings → Jira** enter your site URL (`https://yourorg.atlassian.net`), account email
   and the token, then **Test connection**.
3. Link a single task to an issue via the **Jira issue** field in the task editor — start typing
   and pick from the live autocomplete (selecting fills the task name) — or bulk-import tasks
   with a JQL query via **⤓ Jira** next to “＋ New task” (also reachable from Settings). Both
   ways, the issue's child work items come along as child tasks carrying their own story-point
   estimates — in the task editor the whole descendant tree (stories and their subtasks) appears
   as a pre-checked, indented review list (All/None; pick the ones to import, already-linked ones
   are skipped; unchecking a parent drops its subtree) before you hit Create; a checkbox controls
   whether they inherit the parent's color (on by default). The task's estimate follows the
   selected children's story points; a second checkbox (off by default) keeps Jira's original
   total instead, even when only a subset is imported. Linked tasks are marked everywhere: a key chip in the sidebar and the Gantt (opening the issue), a 🔗
   on their board blocks, and a link in the block popover. When the site exposes epic colors,
   linked and imported tasks adopt them as task colors.
4. Optionally enable **Use story points as estimates** (1 SP = 1 person-day): linking and
   importing then fill the task estimate from the issue's story points — epics sum their
   children's — and **Check estimates from Jira** refreshes every linked task at once. All
   story-points fields are auto-detected per site and each is checked (sites commonly have two:
   “Story Points” for company-managed projects, “Story point estimate” for team-managed ones).
5. Optionally enable **Auto-sync linked tasks with Jira** (off by default): on every load and
   every 15 minutes (plus a **Sync now** button) linked tasks are refreshed — auto-generated
   names (the issue summary; the key stays in its chip, not the name), the “Jira status” note
   and epic colors update (custom names, colors
   and other notes are kept), and story points fill _empty_ estimates. Existing estimates never
   change automatically; “Check estimates from Jira” remains the review flow for those.
6. Whenever the period has Jira-linked tasks, the task list header grows **⇣ Pull** and
   **⇡ Push** buttons: Pull refreshes every linked task (same conservative rules as auto-sync),
   Push writes each task's scheduled start/end dates — and, with story points enabled, its
   estimate as story points — onto the issues (one way, the board is the source of truth, after
   a confirm). The same actions live in the right-click menu, scoped to the selected tasks.

The task list itself can be collapsed (◂ in its header) and resized by dragging its right edge.

Jira Cloud blocks browser calls, so requests go through a small same-origin proxy
(`/api/jira/*`) that forwards your credentials per-request — which is why the production build
uses the Node adapter (`npm run build && node build`); `npm run dev` works as always.

### Google Calendar (automatic PTO)

1. In Google Cloud Console create an **OAuth Client ID** (Web application) with the Calendar API
   enabled and the app's origin (e.g. `http://localhost:5173`) as an authorized JavaScript
   origin. No client secret is needed.
2. Paste the Client ID in **⚙ Settings → Google Calendar** and **Sign in with Google**
   (calendar read-only scope; the token stays in memory).
3. In **👥 Team**, set each colleague's Google email — once signed in, the field autocompletes
   from your company directory (needs the **People API** enabled on the same GCP project).
4. **Fetch PTOs…** pulls their whole-day out-of-office events (hour-scoped OOO is ignored) over
   the plan horizon and presents them as a
   review list — select/deselect (All/None) and **Apply selected**. The selection becomes the
   imported set: deselected events aren't added (and are removed if previously imported);
   manually painted PTO is never touched. Holiday fetches work the same way: review the dates,
   apply the ones you want. Colleagues' calendars must be visible to your signed-in account.

## Development

```sh
npm test           # engine + store + export + integration-mapping unit tests
npm run check      # svelte-check
npm run lint       # prettier + eslint
npm run build      # Node app in build/ (run with: node build)
```

The scheduling engine (`src/lib/engine/`) is pure TypeScript with full test coverage. All state
mutations funnel through named commands in `src/lib/state/plan.svelte.ts` — the seam where a
future multi-user sync layer (server or CRDT) can plug in.

### Possible next steps

- Push directly to Google Sheets (Sheets API `batchUpdate` reusing the existing Google sign-in)
- Multi-user sync backend behind the command layer
