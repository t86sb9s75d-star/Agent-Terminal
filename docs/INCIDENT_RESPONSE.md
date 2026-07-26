# Incident Response

What to actually do when something goes wrong, organized by the signal
you're looking at. This complements `docs/OPERATIONS.md` (day-to-day
mechanics) and `docs/SENTINEL.md` (what the automated findings mean).

## "System needs attention" in the top bar

**Check**: is it an agent-error signal, a store-integrity signal, or
both? Open the Security view — it separates these clearly. If Security
shows "Healthy," the issue is an agent in `error` status; check the
Agents view for which one and read its last run's error in the Activity
feed.

## A Sentinel finding appears

1. Open the Security view, read the finding's summary, evidence, and
   `suggestedAction`.
2. **Acknowledge** it once you've seen it — this doesn't do anything
   except record that a human has looked, which matters for later
   review ("was this seen and ignored, or never seen at all").
3. Decide on a response based on the rule:
   - `repeated_run_failure` — check the agent's recent run errors (the
     `runIds` in the finding's evidence link to specific runs). If the
     underlying cause isn't obvious or isn't quickly fixable, **Contain**
     the finding with "also stop this agent" checked, so it stops
     retrying the same broken action.
   - `budget_pressure` — review whether the agent's task scope
     legitimately needs that much spend, or whether its per-run cap
     needs lowering. Contain (optionally stopping it) if the spend
     looks like a runaway pattern rather than legitimate work.
   - `store_integrity_failure` — this is the same signal as a "Degraded"
     system status; follow the recovery steps in `docs/OPERATIONS.md`
     ("Recovering a degraded store"). Resolve the finding once the store
     is healthy again.
4. **Resolve** once the underlying issue is actually dealt with — not
   just acknowledged. `statusHistory` on the finding is the permanent
   record of this sequence.

## A store shows "Degraded"

This means a tamper or corruption event was detected on a store file.
See `docs/OPERATIONS.md` → "Recovering a degraded store" for the exact
steps. The short version: read the reason, decide whether to trust the
current file or roll back to the last backup, and use the corresponding
button in the Security view. Every degraded state also produces a
matching `store_integrity_failure` Sentinel finding, so the two views
(system status and Security findings) stay consistent.

## An agent is stuck / unresponsive

- If it's genuinely still running and you want it stopped: use Stop
  from the Agents view (or the Security view's Contain-with-stopAgent
  action if it's tied to a finding). This reaches the full process tree
  for `custom` agents, not just the immediate process handle.
- If it's been running unusually long: the hard runtime ceiling
  (`RUCKER_DEFAULT_RUNTIME_TIMEOUT_MS`, default 30 min, or the agent's
  own `maxRuntimeMs`) will eventually stop it automatically and mark the
  run `timed_out`, attributed to the policy engine, not you. You don't
  need to intervene for this specifically — it's a backstop, not the
  primary way to manage a long task.

## The server won't start

**`[fatal] another Rucker Park process (pid N) already holds the
lock...`** — check `ps -p N`. If that process is genuinely running, you
have two instances trying to use the same `data/` directory, which is
unsafe (see `docs/SECURITY_MODEL.md`) — stop one of them. If it's not
running, the lock is stale and the next start attempt will reclaim it
automatically; if it doesn't, something is unusual enough to warrant
manual inspection of `data/.server.lock` before deleting it by hand.

## Suspected external tampering with `data/`

1. Do not delete anything yet. A corrupt file is automatically preserved
   as `<file>.corrupt-<timestamp>` before recovery touches it, but a
   deliberate manual copy of the whole `data/` directory before taking
   any recovery action costs little and preserves the exact evidence.
2. Check the Activity feed for `*.tamper_detected` /
   `*.corrupt_no_backup` events and their timestamps — this narrows down
   when the modification happened relative to what you were doing on
   the machine at the time.
3. Follow the degraded-store recovery steps once you've reviewed enough
   to decide `accept_current` vs. `restore_backup`.
4. If the audit log itself (`events.jsonl`) is the one flagged as
   broken, see `docs/PERSISTENCE_AND_RECOVERY.md` — this one is
   deliberately not a one-click recovery; inspect
   `data/backups/events/` by hand.

## After any incident

The audit trail (Activity view) and, where applicable, a Sentinel
finding's `statusHistory` are the permanent record — resist the urge to
"clean up" by deleting anything from `data/`. If a finding or a
degraded-store event turns out to have been a false positive or an
intentional, harmless action, resolve/accept it through the normal flow
rather than trying to make it disappear from history; the record that
it happened and was reviewed is itself the point.
