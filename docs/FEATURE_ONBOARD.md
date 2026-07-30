# Feature Onboard

The operating layer above individual agents: business workspaces, a founder
command center, goals/decisions/assumptions/evidence, an agent catalog, and a
YC preparation checklist — plus the first-run onboarding flow that sets them up.

This document describes what is actually implemented and enforced. Where
something is stored but not enforced, it says so explicitly.

## Product scope — read this first

Rucker Park, including Feature Onboard, is a **private system for one trusted
operator**. It is not a multi-user product and makes none of the guarantees one
would need:

- There is **no authentication** and no concept of a user account.
- Workspace separation is **organizational, not a security boundary**. It keeps
  one business's records from appearing under another inside *your own*
  installation. It is not tenant isolation and must not be relied on as such.
- There is **no public deployment story**. The server binds to `127.0.0.1` by
  default and is meant to run on a machine you control.
- The `custom` provider runs arbitrary shell commands you author. That is an
  accepted, documented trust boundary for a single trusted operator — it would
  be a remote-code-execution vulnerability the moment a second, less-trusted
  user existed. See `docs/SECURITY_MODEL.md`.

## Architecture

```
Workspace  →  Workstream  →  Agents  →  Runs
```

- **Workspace** — one business, company, or major project (an apparel company,
  contractor software, a new idea). Created and selected by the operator.
- **Workstream** — a subordinate objective *inside* a workspace (customer
  interviews, launch MVP). This is the pre-existing Workstream concept,
  unchanged; Feature Onboard added Workspace as its parent rather than
  replacing it.
- **Agents** — global definitions. An agent is **not** duplicated per
  workspace. What is per-workspace is its *enablement, permission preferences,
  and configuration* (`workspaceAgentSettingsStore`).
- **Runs** — unchanged. A run still snapshots its `workstreamId` permanently, so
  reassigning an agent later never rewrites history. A run reaches its workspace
  *through* that workstream relationship.

**Workspace-owned records** (goals, tasks, decisions, assumptions/risks,
experiments, evidence) require a `workspaceId` and may **optionally** reference
a `workstreamId`. This is deliberate: business-wide information should not have
to invent a throwaway workstream just to be filed.

**Nothing is auto-migrated.** Agents and workstreams that existed before Feature
Onboard remain unassigned until you explicitly attach them. The system never
guesses which workspace something belongs to.

## Onboarding flow

Nine steps: welcome → founder profile → operating mode → first workspace →
recommended agents → permissions → YC → review → done.

- **First-run detection** is simply the absence of a completed onboarding
  record. No onboarding record → the wizard opens.
- **Skippable** — "Skip for now" marks onboarding complete with `skipped: true`
  and does not reopen on reload.
- **Resumable** — each step change is persisted (`currentStep` plus an
  accumulated `draft`), so a refresh mid-flow resumes where you left off.
- **Reopenable** — Settings → "Reopen onboarding" restarts the flow.
- **Non-destructive** — the wizard only writes through the API at completion
  (profile save, workspace create, mark complete). Reopening it does not delete
  existing workspaces, agents, or workstreams.

## Progress calculations

All progress is computed **server-side**. A client-supplied progress or total is
never trusted.

### Workspace progress (`src/progress.js` → `workspaceProgress`)

```
progress = Σ(milestone weight × completion fraction) / Σ(milestone weight) × 100
```

- Milestones come from every goal in the workspace.
- `weight` defaults to `1`; a non-positive or non-finite weight falls back to
  `1` rather than silently removing the milestone from the denominator.
- `fraction` (0–1) supports partial completion; otherwise a truthy `done`
  counts as 1.
- **No milestones → `null`, not `0`.** "Not measurable yet" and "0% done" are
  different statements, and the UI renders them differently. This matches the
  existing refusal to fabricate a workstream progress number.
- Zero total weight → also `null` (defended, though the weight fallback makes it
  unreachable in practice).

### YC progress (`src/progress.js` → `ycOverall`, `src/ycStore.js`)

Weighted average of four fixed sections:

| Section | Weight |
|---|---|
| YC Startup School Progress | 20 |
| YC Business Process | 30 |
| YC Partner Search | 15 |
| YC Application Process | 35 |

- A section's score is `completed items / total items × 100`. Sections without
  checklist items support a manual score instead.
- Unlike workspace progress, **0 is a real value** here: the checklist always
  exists, so "nothing done yet" genuinely is 0, not "unmeasurable".
- The UI shows each section's score, its weight, its completed/total counts, and
  its missing items — so the number is always inspectable.
- Item ids are validated against the template; an unknown item is rejected
  rather than silently inflating the score.

**A YC score of 100 means the configured preparation checklist is complete. It
is not a prediction, probability, or estimate of acceptance, and the interface
must never present it as one.** There is currently no AI-generated YC
commentary; if one is added it must be stored and displayed separately and must
not be able to move the checklist number.

## Permissions — stored vs enforced

This is the most important honesty boundary in the feature.

Defaults follow least authority: **every consequential capability is off by
default** and must be explicitly granted per workspace.

| Capability | Default | Status | Enforcement point |
|---|---|---|---|
| `read_workspace_data` | on | stored preference | — |
| `write_workspace_data` | on | stored preference | — |
| `create_tasks` | on | stored preference | — |
| `modify_tasks` | on | stored preference | — |
| `read_files` | on | stored preference | — |
| `edit_files` | **off** | stored preference | — |
| `run_commands` | **off** | stored preference | — |
| `use_custom_provider` | **off** | **enforced** | `workers/custom.js` trust boundary + minimal env |
| `access_network` | **off** | stored preference | — |
| `contact_people` | **off** | stored preference | — |
| `spend_money` | **off** | **enforced** | `budget.js` daily caps, checked before a paid run starts |
| `paid_model_calls` | **off** | **enforced** | `budget.js` daily caps |
| `act_without_approval` | **off** | stored preference | — |

**"Stored preference" means exactly that**: the value is recorded, displayed,
and available to a future enforcement layer. Nothing consults it yet. The
interface must not describe these as *blocked* or *protected*, and this document
will not either.

The three enforced capabilities are enforced by pre-existing mechanisms
(spending caps and the custom-provider boundary), not by new Feature Onboard
code. Known limitation: budget enforcement is a **lower bound** — see
`src/budget.js` and Known limitations below.

## Persistence

Every Feature Onboard store is built on the same `createVersionedStore` seam as
the rest of the system — no new persistence logic was written.

New stores (each its own JSON file under the data directory, schema version 1):

| Store | File |
|---|---|
| workspaces | `workspaces.json` |
| founder profile | `founder_profile.json` |
| onboarding state | `onboarding_state.json` |
| YC progress | `yc_progress.json` |
| workspace agent settings | `workspace_agent_settings.json` |
| goals / tasks / decisions / assumptions / experiments / evidence | `workspace_<type>.json` |

Each inherits, unchanged: atomic write (temp + fsync + rename), the
missing/empty/populated/recovered/corrupt state distinction, rotating backups,
hash-sidecar tamper detection that never auto-rebaselines, and explicit operator
recovery. **All of them are registered in the recovery endpoint**
(`POST /api/security/stores/:storeName/recover`) — a new store that recovery
didn't know about would be a real gap, so this is asserted rather than assumed.

Corruption/tamper events from these stores reach the audit log and Sentinel via
the same `onStoreEvent` emitter as every other store.

No migration is required: absent files are created as fresh empty envelopes on
first read, which is exactly the first-run case.

## Record semantics worth knowing

- **Decisions are immutable except status.** The decision text and reasoning
  cannot be rewritten — record a new decision instead. This preserves a
  revision trail rather than letting history be edited.
- **Assumptions keep `status` and `confidence` as separate fields.** A belief
  can be strongly held and completely untested; collapsing them would lose that.
  Assumptions and risks use different status vocabularies.
- **Evidence preserves say-vs-do.** `evidenceKind` is required and distinguishes
  a founder belief, something a customer *said*, something a customer *did*, and
  an actual transaction or commitment. A stated preference is a weaker signal
  than a payment, and the schema refuses to blur them.
- **Deletion is a hard delete** for records, but every deletion emits a
  **flagged** audit event.

## API surface

All routes are under `/api`. Every workspace-scoped route resolves and
validates `:workspaceId` first and returns `404 WORKSPACE_NOT_FOUND` for an
unknown one; the stores additionally key every operation on
`(workspaceId, id)` together.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/stages` | the nine business stages |
| GET | `/api/catalog` | agent definitions, stage recommendations, capabilities |
| GET/PUT | `/api/profile` | founder profile (partial merge) |
| GET | `/api/onboarding` | `null` until started (first-run detection) |
| POST | `/api/onboarding/start` | |
| PUT | `/api/onboarding` | save step/draft/modes |
| POST | `/api/onboarding/complete` | `{ skipped }` |
| GET/POST | `/api/workspaces` | list is decorated with server-computed progress |
| GET/PUT | `/api/workspaces/:workspaceId` | |
| POST | `/api/workspaces/:workspaceId/archive` | `{archived:false}` to unarchive |
| GET/POST | `/api/workspaces/:workspaceId/{goals,tasks,decisions,assumptions,experiments,evidence}` | |
| GET/PUT/DELETE | `…/{type}/:id` | scoped to the workspace |
| GET | `/api/workspaces/:workspaceId/agents` | catalog + per-workspace settings + recommendations |
| PUT | `/api/workspaces/:workspaceId/agents/:agentId` | enablement/permissions/config |
| GET/PUT | `/api/workspaces/:workspaceId/yc` | PUT toggles one checklist item |

Errors use the existing stable shape: `{ error, code, requestId }`. Meaningful
mutations emit audit events.

## Testing

| Layer | Command | Count |
|---|---|---|
| Unit | `npm run test:unit` | 86 |
| Integration (real HTTP, real server) | `npm run test:integration` | 32 |
| Frontend (real Chromium) | `npm run test:frontend` | 29 |
| Everything | `npm run test:all` | **147** |

CI (`.github/workflows/ci.yml`) runs all three plus a syntax check, `npm audit`,
and a working-tree-clean gate, on pull requests and pushes to `main` and
`claude/**`. No secrets are referenced, so **no paid model call can occur in
CI**; the test harnesses additionally strip provider API keys from the server
environment.

Browser coverage is **Chromium only**. Firefox and WebKit are not tested.

## Known limitations

Named rather than hidden. These are accepted, not oversights:

1. **Most permissions are stored preferences, not enforcement** (table above).
   Only `spend_money`, `paid_model_calls`, and `use_custom_provider` have a real
   enforcement point today.
2. **Workspace separation is organizational, not security isolation.** Single
   trusted operator; no authentication exists.
3. **Budget enforcement is a lower bound.** A model genuinely absent from the
   pricing table still yields `costUsd: null` and stays outside `knownCost`.
4. **Real paid-call accounting is not verified end-to-end** — doing so would
   require real spend or SDK mocking, neither done.
5. **Pricing-table drift is unguarded.** Rates in `src/pricing.js` are
   hand-maintained; a published price change goes stale silently.
6. **`maxTokens` default (`|| 1024`) is duplicated** in both provider workers.
   Same shape as the effective-model defect, but it affects no accounting.
7. **Historical runs are not backfilled.** Runs recorded before the
   effective-model fix keep `model: null`.
8. **Record deletion is a hard delete** (audit-logged, but the record is gone).
9. **Single-process only.** Every store assumes one process owns the data
   directory (`instanceLock.js`). No multi-process or multi-instance safety is
   claimed.
10. **`public/app.js` (the pre-Feature-Onboard UI) still has unhardened
    interpolation sites** in the Security/Sentinel view. Feature Onboard's own
    UI (`public/onboard.js`) escapes every operator-controlled value, but the
    legacy file was deliberately not rewritten in this work.
11. **Optional `workstreamId` references are not existence-checked.** A record
    may point at a workstream that was later removed; this is preferred over
    letting an unrelated deletion invalidate a record.
12. **No accessibility audit by a real screen reader.** Semantics are asserted
    programmatically (roles, `aria-valuetext`, focus, Escape), which is not the
    same as verified assistive-technology behavior.
