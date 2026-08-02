# Sentinel

The Phase 7 (scoped) defensive foundation. This document exists partly
to record the design and partly to record the boundary of what was
deliberately **not** built, since the original directive was explicit
that this should not become an autonomous security agent.

## What it is

`src/sentinel.js` — a rule engine that turns already-collected system
data (run outcomes, budget-cap breaches, store integrity events) into a
distinct, triaged **finding** with a captured evidence snapshot and an
explicit, operator-driven lifecycle. It is the layer between "something
happened and got logged" and "something happened, is worth a human
noticing, and has a place to track whether it's been dealt with."

## What it is explicitly NOT

- **Not an autonomous offensive-security agent.** There is no scanning,
  probing, network reconnaissance, or "hack back" capability, here or
  planned. Sentinel only ever looks at this system's own already-
  collected data.
- **Not an AI/LLM-driven classifier.** Every rule is a plain conditional
  (`if count >= threshold within window`) over structured data. Nothing
  probabilistic decides severity or whether something is a finding.
  `analyzeWithAi()` is an explicit, unimplemented stub (throws 501) that
  documents the boundary for any future work: an AI-assisted layer may
  eventually summarize or suggest triage priority for a human to read,
  but must never be the thing that sets severity, status, or triggers
  containment. That is a design constraint on future work, not just a
  missing feature.
- **Not autonomous containment.** Every status transition
  (`open → acknowledged → contained → resolved`) happens only via an
  explicit API call (`transition()` is never invoked from anywhere
  except a route handler responding to an operator request). A finding
  carries a `suggestedAction` string — Sentinel proposes, in plain
  English, what an operator might want to do. It never does it.

## Findings: storage and evidence

Findings are stored via the same `versionedStore` foundation as every
other store (`security_events.json`) — tamper-detected, backed up,
schema-versioned. Each finding is:

```
{
  id, ruleId, severity (info|warning|critical), category, summary,
  entityType, entityId,
  evidence: { ...whatever justified the finding, captured at detection time },
  suggestedAction,
  status: open | acknowledged | contained | resolved,
  statusHistory: [{ status, actor, at, note }, ...],
  createdAt,
}
```

`evidence` is a snapshot, not a live query — e.g. the exact run IDs and
timestamps that crossed a threshold, frozen at detection time, so an
operator reviewing it later sees exactly what justified the finding
rather than data that could have since changed underneath them.

Every finding also mirrors into the existing `eventLog`/Activity feed
(`sentinel.finding_created`, flagged), so it's visible even without
opening the dedicated Security view.

## The three rules

Rules run inline, at the moment their condition could newly be true —
after a run finishes, or right after a store integrity event — not on a
polling loop. This means their timing needs no separate verification
(there's no "does the poll interval work correctly" question to answer)
and findings appear immediately, not after some delay.

| Rule | Trigger | Rationale |
|---|---|---|
| `repeated_run_failure` | ≥3 `error`/`timed_out` runs for one agent within 15 minutes | A single failure is just a failure. A burst is the pattern that, left running unattended, silently repeats a broken action instead of surfacing as something worth a human's attention. |
| `budget_pressure` | ≥3 per-run spending-cap breaches for one agent within 24h | A single expensive run is already flagged per-run (see `budget.js`); a *pattern* of breaches suggests the agent's task scope or its cap needs revisiting, not just that one run ran long. |
| `store_integrity_failure` | Any store reports tamper/corruption | Promotes a tamper/corruption event (already in the audit log) to a tracked finding with a proper lifecycle, rather than leaving it as a log line that scrolls away. |

Thresholds and windows are constants in `sentinel.js`
(`REPEATED_FAILURE_THRESHOLD`, `REPEATED_FAILURE_WINDOW_MS`,
`BUDGET_PRESSURE_THRESHOLD`, `BUDGET_PRESSURE_WINDOW_MS`), not yet
operator-configurable — a reasonable next increment, not built in this
pass to keep the initial rule set small and easy to fully verify.

## The containment workflow

A finding's lifecycle is exactly four states, and every transition is
operator-initiated:

- **open** — created by a rule match.
- **acknowledged** — an operator has seen it (`POST
  /api/security/findings/:id/acknowledge`).
- **contained** — an operator has taken (or decided to skip) a
  mitigating action (`POST /api/security/findings/:id/contain`). If the
  finding's entity is an agent, the request body's `stopAgent: true` is
  a **separate, explicit opt-in** — marking a finding contained never
  silently stops a run the operator didn't ask to stop. The Security UI
  enforces this as a distinct confirm dialog, not a checkbox easy to
  miss.
- **resolved** — an operator considers the underlying issue dealt with
  (`POST /api/security/findings/:id/resolve`).

`statusHistory` records every transition with its actor and an optional
note, so the full sequence — who did what, when — is inspectable later,
not just the current state.

## Verified live

- 3 consecutive failures for one agent produced exactly one
  `repeated_run_failure` finding (not one per failure) — confirmed via
  the API and via `test/integration.test.js`.
- A direct file tamper on `agents.json` produced a
  `store_integrity_failure` finding and flipped `/api/security/status`
  to unhealthy.
- Every operator transition (`acknowledge`, `contain`, `resolve`) now also
  writes a `sentinel.finding_<status>` entry to the append-only, hash-chained
  audit log, not only to the finding's own `statusHistory`. That distinction
  matters: `statusHistory` lives in `security_events.json`, a snapshot store
  rewritten in full on every write, while `events.jsonl` is the tamper-evident
  one. Until this was fixed the entire operator lifecycle was invisible to the
  audit trail — including containment, which can stop a running agent. The stop
  was audited; the decision to contain was not. See A-009 in
  `docs/ENGINEERING_FINDINGS.md`; enforced by an integration contract that
  drives every mutating route and diffs the log.
- The full `acknowledge → contain → resolve` lifecycle, including
  `stopAgent: true` actually stopping a currently-running implicated
  agent (confirmed via the agent's status flipping to `idle`), verified
  both via direct API calls and through the real browser UI
  (Playwright), including that `statusHistory` correctly attributes the
  initial `open` state to Sentinel and each subsequent transition to the
  operator.

## Deliberately out of scope for this pass

- Configurable thresholds (currently constants).
- Any rule beyond the three above — e.g. detecting unusual agent
  behavior patterns, cross-agent correlation, or anything requiring
  more than a single agent's own history. Adding rules is meant to be
  cheap (each is a small pure function plus a `createFinding()` call)
  precisely so this can grow incrementally without re-architecting.
- The AI-analysis interface (`analyzeWithAi`) — stubbed, not wired to
  any model. Wiring it is future work that must preserve the
  advisory-only boundary described above.
