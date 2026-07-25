# Rucker Park

The agent operations foundation for Naismith — a self-hosted command environment for registering, running, and auditing AI agents across providers.

Naismith is the intelligence system; Rucker Park is where it's operated. This first version is the operational foundation: register an agent, start it, watch it run, stop it, and keep an honest record of what happened — cost, duration, outcome, and a permanent audit trail. Missions, approvals, and the full system map come later, once this layer is solid.

## Features

- **Command view** — a real-time summary of the whole system: active agents, what completed today, what needs attention, cost today, and execution success — no invented metrics.
- **Agent registry** — define agents (name, role, provider, model, prompt/task or shell command) and persist them to disk.
- **Start / stop / status** — run agents on demand and track their lifecycle (idle, running, completed, failed, cancelled).
- **Live log streaming** — agent output streams to the browser over WebSocket as it's produced, and is persisted per-agent so you can revisit it later.
- **Multi-provider** — built-in runners for Anthropic and OpenAI (streaming chat completions), plus a `custom` provider that runs any local shell command as an agent.
- **Real cost tracking** — token usage is read from each provider's response and priced against a documented table (`src/pricing.js`). Cost aggregates are structured (`complete` / `partial` / `unavailable` / `empty`) so a mix of priced and unpriced runs is never silently summed and shown as if it were a complete total — see `test/runsStore.pricing.test.js`.
- **Run history** — every run is a discrete, timestamped record (duration, tokens, cost, outcome), queryable per agent.
- **Audit trail** — every state-changing action (agent created/edited/deleted, every run started/stopped/completed/failed) is logged append-only with actor, timestamp, and details, and streamed live to the Activity view (two-level: human-readable summary, expandable technical detail).
- **Registry integrity check** — `agents.json` is hash-verified on every server start; an edit made outside the API (bypassing the system) is flagged in the audit trail instead of silently accepted.

What's deliberately **not** measured yet: task/answer quality, decision quality, or any single "reliability" score. Cards show "Execution success" (did the run finish without error — cancelled runs are excluded from this rate, not scored as failures, since stopping a run is an operator decision) and "Task quality: Not measured" — those are different things, and only the first one is real right now.

## Design system

The UI follows `docs/VISUAL_REFERENCE_AUDIT.md` — a short, practical record of the structural patterns (hierarchy, typography, segmented-control usage, motion restraint) it's built against, so later changes have something concrete to check themselves against instead of drifting back toward generic dashboard defaults.

## Tests

```bash
npm test
```

Covers the cost-aggregation and execution-success semantics described above (`test/`). These are the two places a well-intentioned refactor could quietly reintroduce a misleading number, so they're pinned down explicitly.

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

Rucker Park has no built-in authentication and the `custom` provider executes arbitrary shell commands you configure. It binds to `127.0.0.1` by default and is intended to run locally on a trusted machine — do not expose it directly to the internet without adding your own auth/reverse-proxy layer. The audit trail records every action taken through the API and flags edits made directly to the registry file on disk, but it cannot see or log activity that never goes through this system.

## Project layout

```
src/
  server.js        Express API + WebSocket server
  agentManager.js   Runtime lifecycle: start/stop, run records, audit events
  store.js          JSON-file backed agent registry + integrity check
  runsStore.js       Per-run history (tokens, cost, duration, outcome)
  eventLog.js        Append-only audit trail
  pricing.js          $/token table used to estimate run cost
  workers/           One runner per provider (anthropic, openai, custom)
public/              Rucker Park dashboard (vanilla JS, no build step)
data/                Runtime state: agents.json, runs.json, events.jsonl, logs/ (gitignored)
```

## Roadmap (not built yet)

Phase 2+ per the current design direction: missions (grouping agents around an objective, with stages/dependencies/risks), an approvals center for agent actions that need sign-off, decision rooms for structured multi-agent recommendations, and eventually a system map — built only once the underlying objects and events above are real, so every node and animation reflects actual backend state rather than decoration.
