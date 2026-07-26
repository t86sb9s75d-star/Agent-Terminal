# Operations

Running Rucker Park day-to-day: environment variables, what "healthy"
means, backup locations, and how to recover from the failure modes this
safety-foundation work addressed.

## Starting the server

```bash
npm install
cp .env.example .env   # fill in API keys for providers you plan to use
npm start
```

Served at `http://127.0.0.1:4173` by default. On startup the server:

1. Acquires the single-instance lock on `data/` (refuses to start if
   another live process already holds it — see `docs/SECURITY_MODEL.md`).
2. Initializes every store with the audit emitter wired in.
3. Runs crash recovery for any run left `running` by a previous unclean
   shutdown (`recoverInterruptedRuns`).
4. Checks the agent registry's integrity and logs a flagged event if it
   was modified outside the API since last known-good.

If startup fails with `[fatal] another Rucker Park process (pid N)
already holds the lock...`, either that process is a legitimate running
instance (don't start a second one against the same `data/`), or it's a
genuinely stale lock from something that didn't clean up — check `ps -p
N`; if it's not actually running, the next start attempt will correctly
reclaim the stale lock automatically.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `RUCKER_DATA_DIR` | `<repo>/data` | Where every store persists — see `docs/PERSISTENCE_AND_RECOVERY.md` |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic`-provider agents |
| `OPENAI_API_KEY` | — | Required for `openai`-provider agents |
| `RUCKER_MAX_OUTPUT_BYTES` | `1000000` (1MB) | Per-run output cap for `custom` agents before truncation |
| `RUCKER_DEFAULT_RUNTIME_TIMEOUT_MS` | `1800000` (30 min) | Hard per-run ceiling; overridable per-agent via `agent.maxRuntimeMs` |
| `RUCKER_PROVIDER_TIMEOUT_MS` | `300000` (5 min) | Network-level timeout on the Anthropic/OpenAI SDK call itself |
| `RUCKER_MAX_COST_PER_RUN_USD` | unset (unlimited) | Flags a run as over-cap after the fact (cost isn't known until usage is reported) |
| `RUCKER_MAX_DAILY_COST_PER_AGENT_USD` | unset (unlimited) | Blocks a paid-provider run from starting if this agent's known spend today already meets it |
| `RUCKER_MAX_DAILY_COST_SYSTEM_USD` | unset (unlimited) | Same, system-wide across all agents |

All budget-related variables are opt-in — unset means unlimited, so a
fresh install has no surprise blocking behavior.

## Reading system health

Two places, and they answer slightly different questions:

- **Top bar "System healthy / needs attention"** — reflects both agent
  error status (any agent currently in an `error` state) AND store
  integrity (`/api/security/status`). Either condition alone flips it to
  "needs attention."
- **Security view** — the authoritative source for store integrity
  specifically: which subsystems (if any) are degraded, why, since when,
  and the recovery actions available. Also where Sentinel findings live.

## Backups

`data/backups/<storeName>/<storeName>.<ISO-timestamp>.json` — up to 5
most-recent versions per snapshot store (agents, runs, workstreams,
config_history, security_events), rotated automatically on every write.
The audit log (`events.jsonl`) is backed up once at each server startup,
not per-append (append-only logs would be wasteful to fully re-copy on
every single line).

These are local filesystem backups only — they protect against file
corruption and detected tampering, not against loss of the entire host.
Off-host backup (copying `data/` elsewhere on a schedule) is an
operator responsibility this system does not automate.

## Recovering a degraded store

If the Security view shows "Degraded":

1. Read the listed reason (`tampered`, `corrupt_no_backup`, or
   `unsupported_schema`) and the detail shown for each affected store.
2. Decide: was the change on disk something you made deliberately (or
   otherwise trust), or not?
   - **Trust it** → click "Accept current file as-is." The current
     content becomes the new known-good baseline.
   - **Don't trust it, or it's genuinely corrupt** → click "Restore
     last known-good backup." Anything written since that backup is
     lost.
3. Confirm. The action is recorded in the audit trail
   (`store.recovery_performed`, flagged) either way.

See `docs/PERSISTENCE_AND_RECOVERY.md` for the full mechanics and the
one exception (the audit log itself isn't recoverable through this same
one-click flow — deliberately, see that doc).

## Recovering from a crash

Nothing manual is required. On restart, any run left `running` is
automatically marked `interrupted` (not `error` — an interruption isn't
a known failure), and every agent's in-memory status resets correctly.
Check the Activity feed for `runs.recovered_after_restart` to see what,
if anything, was affected.

## Testing before trusting a change

```bash
npm test              # unit tests, then integration tests
npm run test:unit      # fast unit tests only
npm run test:integration  # spawns real server instances against throwaway data dirs
```

The integration suite (`test/integration.test.js`) is the closest thing
to a repeatable version of the manual verification performed throughout
this safety-foundation work — see `docs/VERIFICATION_MATRIX.md`.

## What this system will NOT do for you

- It will not notice a host running out of disk space and warn you in
  advance — a failed write will surface as a normal I/O error, not a
  distinct "low disk" signal.
- It will not restart itself if the process dies outright (not via the
  crash-recovery mechanisms described above, which only run at the
  *next* startup) — process supervision (systemd, a process manager,
  etc.) is an operator responsibility this system does not include.
- It will not alert you outside of what's visible in the dashboard
  itself — no email/SMS/webhook notifications exist yet.
