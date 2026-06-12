# Gantter — agent guide

Team capacity planner: a SvelteKit SPA-style app where the schedule is **computed** from a small
set of facts (tasks, per-member assignments in days, PTO, holidays). There is no stored start/end
date per assignment — the scheduler packs each member's queue front-to-back over working days.
See `README.md` for the full feature tour.

## Commands

```sh
npm run dev        # vite dev server on :5173
npm test           # vitest, single run
npm run check      # svelte-kit sync && svelte-check
npm run lint       # prettier --check + eslint
npm run format     # prettier --write
npm run build      # Node adapter app in build/ (run with: node build)
```

## Layout

- `src/lib/model/types.ts` — the whole data model (`Plan`, `Task`, `Assignment`, `Absence`…)
  and `SCHEMA_VERSION`. Dates are `ISODate` strings (`'2026-06-11'`); string comparison ==
  chronological comparison. Start here for any data-shape question.
- `src/lib/engine/` — pure TypeScript scheduling: `calendar.ts` (working-day math),
  `schedule.ts` (queue packing, dependencies), `moves.ts` (drag/drop block operations),
  `board.ts`. No Svelte imports; fully unit-tested.
- `src/lib/state/plan.svelte.ts` — `PlanStore`, the single source of truth. **Every mutation
  funnels through `#commit(command, mutate)`** — that's the undo/redo seam and where a future
  sync layer plugs in. Never mutate `store.plan` outside a commit.
- `src/lib/state/persistence.ts` — localStorage registry (one plan per period) and the
  `planToJSON`/`planFromJSON` export/import pair. `migrate()` is the only validation gate for
  external data; schema migrations chain there, bumping `schemaVersion`.
- `src/lib/components/` — Svelte 5 components (runes: `$state`, `$derived`, `$props`).
- `src/lib/export/` — Excel export (exceljs, lazy-imported).
- `src/lib/integrations/` — Jira and Google Calendar clients (browser-side; Jira goes through
  the `/api/jira/*` proxy in `src/routes/api/`).

## Invariants worth knowing

- Each period (quarter or custom range) owns its own `Plan`; the registry is keyed by plan id
  and `importPlan` replaces the plan for the period the file describes (`startDate`/`numWeeks`
  travel inside the exported JSON).
- Back-to-back assignment chunks of the same task on the same member are always merged
  (`mergeAdjacentChunks`); `#commit` enforces this after every mutation.
- A task never starts before its `dependsOn` tasks (including all their workstreams) finish.
- Credentials live in localStorage only and must never end up in exported plan files.

## Conventions

- Svelte 5 runes everywhere; class-based stores in `*.svelte.ts` files.
- Tabs for indentation; Prettier + ESLint are the authority (`npm run lint`).
- Tests live next to the source as `*.test.ts` (vitest). Engine and store changes need tests;
  UI components are not unit-tested.
- Comments explain invariants and "why", not "what".
