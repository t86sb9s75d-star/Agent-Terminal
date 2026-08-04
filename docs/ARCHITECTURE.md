# Architecture

This document describes the system as it actually exists after the
safety-foundation work (branch `claude/rucker-park-safety-foundation`,
built on the Phase 2 Workstreams baseline). It is not a design proposal —
every claim here should be checkable against the code it references.

## What this is, deliberately

Rucker Park is a **single-instance, single-operator, JSON-file-backed**
agent operations dashboard. Those three constraints are load-bearing
architectural decisions, not gaps waiting to be filled:

- **Single-instance**: exactly one server process may run against a given
  data directory at a time (`src/instanceLock.js`). There is no
  distributed coordination, no leader election, no shared-state protocol.
  Two instances racing on the same files would silently corrupt state
  (see "What this is not," below) — the lock exists because that failure
  mode is real and was verified live, not theoretical.
- **Single-operator**: there is no authentication system, no user
  accounts, no per-user permissions. `src/actor.js` distinguishes *how* a
  request arrived (the dashboard's own browser vs. some other API caller)
  but cannot and does not try to distinguish *which human* sent it. This
  is intentional — see `docs/SECURITY_MODEL.md` for the full boundary.
- **JSON-file-backed, not a database**: every store (agents, runs,
  workstreams, config history, security findings) is one JSON file,
  fully rewritten on every write, read fresh on every read. No query
  engine, no indexes, no transactions spanning multiple stores. This
  keeps the system's entire persisted state human-readable and
  diffable, and keeps the operational surface (what can break, what
  "backup" means, what "corrupt" means) small enough to reason about
  completely. The cost is bounded scale (this is not meant to hold
  millions of runs) and no cross-store atomicity (see "Known boundary:
  no cross-store transactions," below).

## Layers

```
public/               Vanilla JS frontend, no build step, no framework
  index.html            Shell + nav + modals
  app.js                All view rendering + WebSocket handling
  styles.css             Design tokens + component styles

src/server.js          Express API + WebSocket server — the only process
                        entry point; wires every store's init() together
src/agentManager.js    Runtime orchestration: start/stop, timeouts,
                        budget checks, Sentinel rule evaluation
src/actor.js           HTTP request -> structured actor object
src/errors.js          AppError + stable error codes

src/store.js           Agent registry
src/runsStore.js       Run history + cost/success aggregation
src/workstreamsStore.js Workstreams: CRUD, effective status, metrics
src/configHistoryStore.js  Narrow agent-config change history
src/sentinel.js        Deterministic security findings + containment
src/eventLog.js        Append-only, hash-chained audit trail
src/systemState.js     In-memory degraded-subsystem tracker
src/budget.js           Spending-cap checks
src/instanceLock.js     Single-instance enforcement
src/idempotency.js       Idempotency-key replay cache

src/persistence/        Shared primitives every snapshot store is built on
  atomicJsonFile.js       Atomic write-then-rename, corruption detection
  backup.js                Rotating per-store backups
  integrityChain.js        Hash computation for both store shapes
  chainedLog.js             Append-only hash-chained log (used by eventLog)
  versionedStore.js          Ties the above into read/write/recover

src/workers/            One runner per provider (anthropic, openai, custom)
```

## The two persistence shapes

Everything in `data/` is one of two shapes, and every store uses the
shared primitive for its shape rather than reimplementing it:

**Snapshot stores** (`versionedStore.js`) — agents, runs, workstreams,
config history, security findings. Each is `{schemaVersion, updatedAt,
records}`, fully rewritten on every write. A sidecar hash file
(`.{name}.hash.json`) records the hash of the last content this
application itself wrote, so a later read can tell whether the file
still matches what the application believes it wrote — see
`docs/PERSISTENCE_AND_RECOVERY.md`.

**Append-only chained log** (`chainedLog.js`) — the audit trail
(`events.jsonl`) only. Each line carries `previousHash`/`recordHash`
instead of a separate sidecar, because the log's own history IS the
data being protected; a snapshot-style external hash file would only
protect the latest state, not the trail leading to it.

Both shapes share atomic writes, corruption detection, and backup
rotation, but their read/write/recover APIs are intentionally distinct —
"append a record" and "rewrite the whole file" are different enough
operations that unifying them behind one interface would have hidden
real differences (e.g., a snapshot store's `recover()` fully replaces
the file; an append-only log's integrity failure is instead surfaced via
`systemState` and the boot log, and its recovery is deliberately a
manual, deliberate action — see `docs/PERSISTENCE_AND_RECOVERY.md`).

## Key design choices and what they were for

**Structured actor attribution replaced a flat `'operator'` string**
(`src/actor.js`, `eventLog.js`'s `normalizeActor`). Every audit/security
event now carries `{actorType, actorId, triggerType, requestId}`. This
exists specifically for incident review under unattended operation:
"did a human do this, or did something automated do this while nobody
was watching" needs to be answerable from the log itself, not inferred.

**Dependency-injected `onEvent` callbacks instead of importing
`eventLog` directly.** Every store takes an `onEvent` callback at
`init()` rather than requiring `eventLog` at the top of the file. This
avoids a circular dependency (`eventLog` itself uses the same
`versionedStore`/`chainedLog` primitives every other store does, and
needs to be able to report ITS OWN corruption/tampering somewhere) and
keeps each store testable in isolation without needing the whole
audit-log machinery wired up.

**Option B for workstream blocked-state** (`workstreamsStore.js`,
`resolveIncident`/`computeMetrics`): a run failure stays attached to the
workstream it happened in — and keeps that workstream showing
`Blocked` — even after the responsible agent is reassigned elsewhere,
until an operator explicitly resolves it. The alternative (Option A:
status auto-clears the moment the agent leaves) was rejected because it
lets a real unresolved failure quietly vanish from view just because an
agent moved, which is the wrong default for incident accountability.
Documented and tested explicitly (`test/workstreamsStore.test.js`,
"Option B" section) because this is exactly the kind of behavior a
well-intentioned refactor could silently invert.

**Sentinel is deterministic rules, not an autonomous agent or an AI
classifier.** See `docs/SENTINEL.md` for the full scope boundary; the
short version is that every finding traces to a plain conditional over
data this system already collects, and every consequential action
(acknowledge/contain/resolve, and whether containment also stops an
agent) requires an explicit operator API call.

## Known boundaries (not gaps — documented, deliberate scope limits)

- **No cross-store transactions.** Creating an agent writes to
  `agents.json`, then (if the create succeeds) `eventLog` records a
  separate event, then `configHistoryStore` records a separate entry.
  If the process crashes between these writes, the agent exists but its
  audit trail entry might not (or vice versa for actions with multiple
  writes). This is a real, accepted gap for a JSON-file system without a
  transaction log spanning stores. It does NOT apply to a single store's
  own write (that write is atomic — see `PERSISTENCE_AND_RECOVERY.md`),
  only to sequences of writes across different stores.
- **No encryption at rest.** `data/` is plain JSON on disk. Anyone with
  filesystem access to the host can read agent configurations, run
  history, and audit logs directly. This is consistent with the
  single-operator, trusted-machine threat model — see
  `docs/SECURITY_MODEL.md`.
- **Bounded scale.** `runsStore.js` caps run history at 5000 records
  (oldest trimmed on write); nothing else has an explicit cap, so an
  extremely long-running unattended deployment could grow
  `events.jsonl` or `config_history.json` without bound. Not addressed
  in this pass — flagged for the two-year-unattended-operation
  discussion, not silently ignored.

## What was deliberately NOT built in this pass

Per the safety-foundation directive's explicit constraints: no database,
no real authentication/authorization system, no multi-tenancy, no full
event-sourcing (config history is narrow and agent-scoped, not a
general-purpose event store), no Kubernetes/container orchestration, no
UI framework rewrite, no autonomous offensive-security capability, no
"hack back," and no LLM-only security detection (Sentinel's rules are
100% deterministic; see `docs/SENTINEL.md` for the explicit AI-advisory
stub boundary).

## Feature Onboard: Workspace as the parent of Workstream

Feature Onboard introduced business workspaces. The hierarchy is:

```
Workspace  →  Workstream  →  Agents  →  Runs
```

**Decision: Workspace was added as the PARENT of the existing Workstream
concept, rather than replacing it or sitting beside it as a peer.**

The alternatives and why they lost:

- *Replace Workstream with Workspace.* Rejected as destructive. Every run
  permanently snapshots its `workstreamId` at start time (see
  `runsStore.startRun`), which is what makes run history immune to later
  reassignment. Replacing the concept would have required rewriting or
  reinterpreting that attribution on historical runs — exactly the kind of
  retroactive history edit the rest of this system refuses to do.
- *Workspace and Workstream as peers.* Rejected as permanently confusing: two
  overlapping grouping concepts with no stated relationship, which every future
  feature would have to disambiguate.

Consequences of the chosen shape:

- A workspace is a business, company, or major project. A workstream is a
  subordinate objective inside one (customer interviews, launch MVP).
- Runs keep their existing workstream attribution unchanged, and reach a
  workspace transitively through that workstream.
- **Agent definitions stay global.** An agent is not duplicated per workspace;
  only its enablement, permission preferences, and configuration are
  per-workspace (`workspaceAgentSettingsStore`). This avoids N copies of the
  same Interview Agent drifting apart.
- **Workspace-owned records require a `workspaceId` and may optionally
  reference a `workstreamId`.** Requiring a workstream would have forced the
  operator to invent empty workstreams just to file business-wide information
  such as a company-level decision. The optional reference is deliberately not
  existence-checked: a workstream can be archived or removed independently, and
  a stale optional pointer is far less harmful than a record with no workspace.
- **Nothing is auto-migrated.** Agents and workstreams that predate Feature
  Onboard stay unassigned until explicitly attached. The system never guesses
  which business an existing object belonged to.
