# Feature Onboard

The operating layer above individual agents: business workspaces, a founder
command center, goals/decisions/assumptions/evidence, an agent catalog, and a
YC preparation checklist — plus the first-run onboarding flow that sets them up.

This document describes what is actually implemented. Where something is
recorded but not enforced, it says so explicitly — and for agent permissions,
that turned out to be all thirteen capabilities. See "Permissions — what the
toggles actually do" below.

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

## Permissions — what the toggles actually do

This is the most important honesty boundary in the feature, and an earlier
version of this document got it wrong in a way worth stating plainly.

**No permission value stored on this screen is consulted by the runtime.
Not one of the thirteen.** Turning any of them off changes what is recorded
and nothing else. This was established by reading every call site, not by
trusting the labels.

An earlier version of this table split the thirteen into "stored preference"
and "enforced", listing an enforcement point for three. That was misleading.
Three capabilities do have a **related system-level control**, but those
controls run unconditionally and never read these values:

- `budget.assertWithinBudget()` is called before every run
  (`src/agentManager.js`) and checks the configured daily caps. It does not
  look at `spend_money` or `paid_model_calls` for this agent or workspace.
- `src/workers/custom.js` applies its trusted-operator boundary and
  `minimalEnv()` to every custom run. It does not look at
  `use_custom_provider`.

So the honest statement is: **a system control exists for three actions; the
per-agent toggle gates nothing, for any of the thirteen.**

`src/permissions.js` is the single authority for this, and the UI and this
table both read from it rather than restating it:

| Capability | Default | Classification | Related always-on control |
|---|---|---|---|
| `read_workspace_data` | on | recorded only | — |
| `write_workspace_data` | on | recorded only | — |
| `create_tasks` | on | recorded only | — |
| `modify_tasks` | on | recorded only | — |
| `read_files` | on | recorded only | — |
| `edit_files` | **off** | recorded only | — |
| `run_commands` | **off** | recorded only | — |
| `use_custom_provider` | **off** | system control | `src/workers/custom.js` — trusted-operator boundary + `minimalEnv()`, on every custom run |
| `access_network` | **off** | recorded only | — |
| `contact_people` | **off** | recorded only | — |
| `spend_money` | **off** | system control | `src/budget.js` — daily caps, before every paid run |
| `paid_model_calls` | **off** | system control | `src/budget.js` — daily caps, before every paid run |
| `act_without_approval` | **off** | recorded only | — |

Defaults follow least authority: every consequential capability starts off.
That is a defensible default for a value that will one day be enforced — it is
not itself a control.

**There is no approval workflow anywhere in this system.** Nothing pauses to
ask the operator before an agent acts. A `requiresApproval()` helper used to
exist in `src/permissions.js`; it had no caller outside its own test and named
a mechanism that does not exist, so it was removed rather than renamed.

The interface must not describe any of these as *blocked*, *protected*,
*prevented*, *disabled*, *enforced*, *approval-gated* or *guaranteed*, and this
document will not either. That rule is enforced by a browser contract test
(`[contract] no permission surface claims enforcement or approval it does not
have`) which forbids claims rather than vocabulary — "not enforced" and
"nothing in the runtime reads this value" remain sayable, because they are true.

### Where to review them

Business → Agents → **Review permissions** on any agent lists all thirteen with
their classification, the code path behind each system control, and the stored
value, and lets you change any of them. The onboarding permissions step shows
the same list read-only. Both render `src/permissions.js`'s own summary
sentence verbatim so the UI and this document cannot drift apart.

Known limitation: the budget control is a **lower bound** — see `src/budget.js`
and Known limitations below.

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

### Routes with no operator interface

A route existing is not the same as a capability being delivered. These are
**API-only** — reachable with `curl`, deliberately not surfaced in the UI:

| Route | Why there is no interface |
|---|---|
| `GET /api/workspaces/:workspaceId` | the UI always works from the decorated list, so a single-workspace read has no surface |
| `GET /api/workspaces/:workspaceId/{type}/:id` | records are rendered from the list response; a single-record read has no surface |
| `DELETE /api/workspaces/:workspaceId/decisions/:id` | a decision's text and reasoning are immutable so the revision trail survives. A delete button would let the interface destroy exactly the history that rule exists to preserve, so decisions are the one record type with no delete control. The route remains for an operator who has deliberately decided otherwise. |

Everything else under `/api` that Feature Onboard registers **is** reachable
through the interface, and that is enforced rather than asserted:
`test/routeCoverage.test.js` collects the routes from the real registration
function and fails if a route is unclassified, if a classified route has been
removed, or if a route claimed to be operator-reachable has no call site in
`public/onboard.js`.

## Testing

| Layer | Command | Count |
|---|---|---|
| Unit | `npm run test:unit` | 97 |
| Integration (real HTTP, real server) | `npm run test:integration` | 35 |
| Frontend (real Chromium) | `npm run test:frontend` | 41 |
| Everything | `npm run test:all` | **173** |

CI (`.github/workflows/ci.yml`) runs all three plus a syntax check, `npm audit`,
and a working-tree-clean gate, on pull requests and pushes to `main` and
`claude/**`. No secrets are referenced, so **no paid model call can occur in
CI**; the test harnesses additionally strip provider API keys from the server
environment.

Browser coverage is **Chromium only**. Firefox and WebKit are not tested.

## Known limitations

Named rather than hidden. These are accepted, not oversights:

1. **No permission value is enforced — zero of thirteen** (table above). Three
   capabilities have a related always-on system control that does not read the
   setting. There is also no approval workflow anywhere in the system.
2. **Workspace separation is organizational, not security isolation.** Single
   trusted operator; no authentication exists.
3. **A corrupt goals store makes the whole workspace list unavailable.**
   `GET /api/workspaces` computes progress from that store, so a
   `STORE_DEGRADED` there returns 503 for the list rather than degrading
   progress alone. The UI now renders this as an explicit error (it previously
   rendered "No workspaces yet", which was worse than blank), and the operator
   can still recover the store through the Security view. Returning workspaces
   with progress marked unavailable would need a new progress state, which is a
   product decision rather than a bug fix.
4. **Sentinel findings still accumulate one per request per tampered store.**
   The per-request amplification is fixed (one read, one event — see
   `docs/ENGINEERING_FINDINGS.md` R-006), but `evaluateIntegrityEvent()` has no
   dedupe by `(store, reason)` and `security_events.json` has no retention cap,
   so repeated page loads against a store the operator has not yet recovered
   keep adding findings. Pre-existing behaviour; capping it is a retention
   decision, not a defect fix.
5. **Two routes have no operator interface**, listed above with reasons.
6. **Concurrent permission edits silently revert each other.** The permission
   grid is checkbox state: each toggle PUTs the whole resolved capability map,
   computed from client state that has not yet refreshed. Two toggles in quick
   succession make the second write the first's stale value back — a grant or a
   revocation disappears with no error, and the UI then agrees with the wrong
   result. Reproduced with two clicks 120ms apart; the outcome is
   nondeterministic. The API has the same problem independently: two concurrent
   PUTs with disjoint maps are last-write-wins, because the contract is full
   replace with no merge and no version.
   **Deliberately not fixed here.** Phase 9 replaces this model with capability
   grants as versioned transactions (previous version, requested version,
   reviewer, timestamp, audit entry), which removes the race by construction.
   Patching the checkbox path first would be discarded work. Tracked as A-002.
7. **A `corrupt_no_backup` store cannot be repaired through the product.** Both
   recovery actions return an opaque 500. See `docs/PERSISTENCE_AND_RECOVERY.md`
   for the reproduction and the two underlying defects (a plain `Error` that
   `sendError` does not map, and an unguarded `JSON.parse`), plus the fact that
   `accept_current` performs no shape validation on what it blesses. The
   corrupt bytes are preserved on disk and repairable by hand. Tracked as A-003.
8. **An oversized request body returns 500, not a documented error.** `express.json()`
   runs with the default 100kb limit and `sendError` maps `entity.parse.failed`
   but not `entity.too.large`, so a large payload surfaces as
   `INTERNAL_ERROR` — contradicting `src/errors.js`'s stated rule that every
   user-facing error is a stable code. Record string fields also have no length
   bound at all. Tracked as A-004.
9. **The two new tabs render in O(n*m).** Tasks resolve their goal name and
   experiments their assumption text with a `find()` inside a `map()`.
   Irrelevant at realistic record counts, quadratic at large ones. Tracked as
   A-006.
10. **The browser harness leaks a Chromium process and temp directory if the
   suite is killed mid-run** (not on a normal failure — `check()` cleans up in a
   `finally`). An orphan causes CPU contention that shows up as flaky failures
   in later runs. If two consecutive runs fail on *different* tests, check for
   orphaned `chrome-linux/chrome` processes and `/tmp/rucker-fe-*` directories
   before investigating either test. (A-008)
11. **No test exercises concurrent operator actions.** Every case in every layer
   is sequential, so the suite is structurally unable to observe a race unless
   one is forced explicitly. Two of the findings above were only found by
   deliberately inducing concurrency. This is the largest known gap in the test
   strategy, not an oversight in any single test.
12. **Budget enforcement is a lower bound.** A model genuinely absent from the
   pricing table still yields `costUsd: null` and stays outside `knownCost`.
13. **Real paid-call accounting is not verified end-to-end** — doing so would
   require real spend or SDK mocking, neither done.
14. **Pricing-table drift is unguarded.** Rates in `src/pricing.js` are
   hand-maintained; a published price change goes stale silently.
15. **`maxTokens` default (`|| 1024`) is duplicated** in both provider workers.
   Same shape as the effective-model defect, but it affects no accounting.
16. **Historical runs are not backfilled.** Runs recorded before the
   effective-model fix keep `model: null`.
17. **Record deletion is a hard delete** (audit-logged, but the record is gone).
18. **Single-process only.** Every store assumes one process owns the data
   directory (`instanceLock.js`). No multi-process or multi-instance safety is
   claimed.
19. **`public/app.js` (the pre-Feature-Onboard UI) still has unhardened
    interpolation sites** in the Security/Sentinel view. Feature Onboard's own
    UI (`public/onboard.js`) escapes every operator-controlled value, but the
    legacy file was deliberately not rewritten in this work.
20. **Optional `workstreamId` references are not existence-checked.** A record
    may point at a workstream that was later removed; this is preferred over
    letting an unrelated deletion invalidate a record.
21. **No accessibility audit by a real screen reader.** Semantics are asserted
    programmatically (roles, `aria-valuetext`, focus, Escape), which is not the
    same as verified assistive-technology behavior.
