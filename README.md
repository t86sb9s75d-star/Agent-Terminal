# Rucker Park

The agent operations foundation for Naismith — a self-hosted command environment for registering, running, and auditing AI agents across providers.

Naismith is the intelligence system; Rucker Park is where it's operated. This first version is the operational foundation: register an agent, start it, watch it run, stop it, and keep an honest record of what happened — cost, duration, outcome, and a permanent audit trail. Approvals and the full system map come later, once this layer is solid.

## Features

- **Command view** — a real-time summary of the whole system: active agents, what completed today, what needs attention, cost today, and execution success — no invented metrics.
- **Workstreams** — group agents around an objective (`Workspace → Workstream → Agents → Runs → Events`). Status (Planning/Active/Blocked/Review/Completed/Archived) is computed from real run outcomes or manually overridden — never auto-promoted to "Review"/"Completed", since the system can't honestly judge that. A run's workstream attribution is a permanent snapshot taken when it started: reassigning an agent later never rewrites history. "Progress" is deliberately always "unavailable" — there's no planned-work baseline to measure it against, and the alternative (faking it from a success ratio) was rejected as misleading.
- **Agent registry** — define agents (name, role, provider, model, prompt/task or shell command) and persist them to disk.
- **Start / stop / status** — run agents on demand and track their lifecycle (idle, running, completed, failed, cancelled).
- **Live log streaming** — agent output streams to the browser over WebSocket as it's produced, and is persisted per-agent so you can revisit it later.
- **Multi-provider** — built-in runners for Anthropic and OpenAI (streaming chat completions), plus a `custom` provider that runs any local shell command as an agent.
- **Real cost tracking** — token usage is read from each provider's response and priced against a documented table (`src/pricing.js`). Cost aggregates are structured (`complete` / `partial` / `unavailable` / `empty`) so a mix of priced and unpriced runs is never silently summed and shown as if it were a complete total — see `test/runsStore.pricing.test.js`.
- **Run history** — every run is a discrete, timestamped record (duration, tokens, cost, outcome), queryable per agent.
- **Audit trail** — every state-changing action (agent created/edited/deleted, every run started/stopped/completed/failed) is logged append-only with actor, timestamp, and details, and streamed live to the Activity view (two-level: human-readable summary, expandable technical detail).
<<<<<<< HEAD
- **Registry integrity check** — every store (not just agents), not just `agents.json`, is hash-verified on every read; an edit made outside the API is flagged and stays flagged until an operator explicitly resolves it — never silently re-baselined. See `docs/PERSISTENCE_AND_RECOVERY.md`.
- **Crash-safe by construction** — atomic writes, corruption-vs-empty-state distinction, rotating backups, and boot-time recovery for any run left mid-execution by an unclean shutdown. See `docs/PERSISTENCE_AND_RECOVERY.md`.
- **Runtime isolation** — custom-agent shell commands run with a minimal, secret-excluding environment; a hard per-run timeout and output-size cap prevent a runaway process from running (or logging) forever; full process-tree termination on stop, not just the immediate shell wrapper.
- **Spending controls** — optional per-agent-daily and system-daily spending caps, checked before a paid-provider run starts.
- **Sentinel** — deterministic security findings (repeated run failures, budget-cap pressure, store tampering/corruption) with an evidence snapshot and an operator-driven acknowledge/contain/resolve workflow. Not an autonomous or AI-driven security agent — see `docs/SENTINEL.md`.
- **Structured audit attribution** — every audit/security event carries who or what caused it (`human_operator`/`system`/`policy_engine`/`security_monitor`/etc.), not a flat "operator" string, so an incident review can tell whether a human did something or the system enforced a policy on its own.

What's deliberately **not** measured yet: task/answer quality, decision quality, or any single "reliability" score. Cards show "Execution success" (did the run finish without error — cancelled runs are excluded from this rate, not scored as failures, since stopping a run is an operator decision) and "Task quality: Not measured" — those are different things, and only the first one is real right now.

## Safety and reliability documentation

- `docs/ARCHITECTURE.md` — system layers, key design decisions, documented boundaries
- `docs/PERSISTENCE_AND_RECOVERY.md` — atomic writes, tamper detection, backup/recovery mechanics
- `docs/SECURITY_MODEL.md` — threat model, every control and what it actually prevents
- `docs/SENTINEL.md` — the deterministic security-finding rule engine and its explicit non-goals
- `docs/OPERATIONS.md` — environment variables, backups, day-to-day operation
- `docs/INCIDENT_RESPONSE.md` — what to actually do for each kind of signal
- `docs/VERIFICATION_MATRIX.md` — every safety claim above, labeled by how it was actually verified

=======
- **Registry integrity check** — `agents.json` is hash-verified on every server start; an edit made outside the API (bypassing the system) is flagged in the audit trail instead of silently accepted.

What's deliberately **not** measured yet: task/answer quality, decision quality, or any single "reliability" score. Cards show "Execution success" (did the run finish without error — cancelled runs are excluded from this rate, not scored as failures, since stopping a run is an operator decision) and "Task quality: Not measured" — those are different things, and only the first one is real right now.

>>>>>>> origin/main
## Design system

The UI follows `docs/VISUAL_REFERENCE_AUDIT.md` — a short, practical record of the structural patterns (hierarchy, typography, segmented-control usage, motion restraint) it's built against, so later changes have something concrete to check themselves against instead of drifting back toward generic dashboard defaults.

## Tests

```bash
<<<<<<< HEAD
npm test              # unit tests, then integration tests
npm run test:unit      # fast unit tests only
npm run test:integration  # spawns real server instances against throwaway data directories
```

Unit tests cover the cost-aggregation, execution-success, and workstream-status/history semantics described above — the places a well-intentioned refactor could quietly reintroduce a misleading number or silently rewrite history. Integration tests spawn a real `node src/server.js` process per case and talk to it over real HTTP, covering the safety-foundation behaviors: crash recovery, tamper detection, archived-workstream enforcement, the path-traversal fix, CSRF rejection, single-instance locking, idempotency-key replay, runtime timeouts, output truncation, budget enforcement, and Sentinel findings/containment. 27 unit + 14 integration = 41 tests, all passing. See `docs/VERIFICATION_MATRIX.md` for exactly what each safety claim is (and isn't) covered by.
=======
npm test
```

Covers the cost-aggregation, execution-success, and workstream-status/history semantics described above (`test/`). These are the places a well-intentioned refactor could quietly reintroduce a misleading number or silently rewrite history, so they're pinned down explicitly (23 cases across three files).
>>>>>>> origin/main

## Getting started

```bash
npm install
cp .env.example .env   # then fill in the API keys for the providers you plan to use
npm start
```

The dashboard is served at `http://127.0.0.1:4173` by default (override with `HOST`/`PORT` in `.env`).

## Agent types

| Provider    | What it does                                                                 | Required config              |
|-------------|-------------------------------------------------------------------------------|-------------------------------|
| `anthropic` | Streams a single-turn Claude completion for the agent's task/system prompt   | `ANTHROPIC_API_KEY`, `task`  |
| `openai`    | Streams a single-turn OpenAI chat completion                                  | `OPENAI_API_KEY`, `task`     |
| `custom`    | Spawns an arbitrary local shell command and streams its stdout/stderr        | `command`                    |

## Security note

<<<<<<< HEAD
Rucker Park has no built-in authentication and the `custom` provider executes arbitrary shell commands you configure — that's an accepted, documented trust boundary (the operator authors their own commands through the same trusted API as everything else), not an oversight. It binds to `127.0.0.1` by default and is intended to run locally on a trusted machine — do not expose it directly to the internet without adding your own auth/reverse-proxy layer. A cross-origin-request check (`docs/SECURITY_MODEL.md`) still protects against a webpage in the same browser blind-POSTing to the dashboard, since "localhost-only" doesn't mean "safe from the browser." The audit trail records every action taken through the API and flags edits made directly to any store file on disk (not just the registry), but it cannot see or log activity that never goes through this system. See `docs/SECURITY_MODEL.md` for the complete threat model and every control actually implemented.

## Environment variables

See `docs/OPERATIONS.md` for the full reference (timeouts, output caps, spending limits, data directory override). `PORT`/`HOST` and provider API keys are set via `.env` as shown above.
=======
Rucker Park has no built-in authentication and the `custom` provider executes arbitrary shell commands you configure. It binds to `127.0.0.1` by default and is intended to run locally on a trusted machine — do not expose it directly to the internet without adding your own auth/reverse-proxy layer. The audit trail records every action taken through the API and flags edits made directly to the registry file on disk, but it cannot see or log activity that never goes through this system.
>>>>>>> origin/main

## Project layout

```
src/
  server.js            Express API + WebSocket server
<<<<<<< HEAD
  agentManager.js       Runtime lifecycle: start/stop, timeouts, budget checks, Sentinel evaluation
  actor.js               HTTP request -> structured actor object; request-ID + CSRF middleware
  errors.js               Stable error codes (AppError)
  budget.js                Spending-cap checks
  instanceLock.js           Single-instance enforcement
  idempotency.js             Idempotency-key replay cache
  sentinel.js                Deterministic security findings + containment
  store.js               JSON-file backed agent registry
  runsStore.js             Per-run history (tokens, cost, duration, outcome, workstream snapshot)
  workstreamsStore.js       Workstreams: CRUD, effective status, derived metrics, archive enforcement
  configHistoryStore.js      Narrow agent-config change history
  eventLog.js                 Append-only, hash-chained audit trail
  systemState.js                In-memory degraded-subsystem tracker
  pricing.js                     $/token table used to estimate run cost
  persistence/                    Shared atomic-write/backup/tamper-detection primitives
  workers/                         One runner per provider (anthropic, openai, custom)
public/                  Rucker Park dashboard (vanilla JS, no build step)
data/                    Runtime state (gitignored) — agents.json, runs.json, workstreams.json,
                          config_history.json, security_events.json, events.jsonl, logs/, backups/
test/
  *.test.js               Unit tests (cost, execution-success, workstream semantics)
  integration.test.js       Spawns real server instances against throwaway data directories
=======
  agentManager.js       Runtime lifecycle: start/stop, run records, audit events
  store.js              JSON-file backed agent registry + integrity check
  runsStore.js           Per-run history (tokens, cost, duration, outcome, workstream snapshot)
  workstreamsStore.js     Workstreams: CRUD, effective status, derived metrics
  eventLog.js             Append-only audit trail
  pricing.js               $/token table used to estimate run cost
  workers/               One runner per provider (anthropic, openai, custom)
public/                  Rucker Park dashboard (vanilla JS, no build step)
data/                    Runtime state: agents.json, runs.json, workstreams.json, events.jsonl, logs/ (gitignored)
>>>>>>> origin/main
```

## Roadmap (not built yet)

An approvals center for agent actions that need sign-off, decision rooms for structured multi-agent recommendations, and eventually a system map — built only once the underlying objects and events are real, so every node and animation reflects actual backend state rather than decoration.
