# Persistence and Recovery

How data survives crashes, corruption, and tampering — and exactly what
an operator does when one of those happens. Everything here is
implemented in `src/persistence/` and wired into each store in `src/`.

## Atomic writes

`src/persistence/atomicJsonFile.js` — every write goes: serialize →
write to a temp file in the same directory → `fsync` → atomic rename
over the target. POSIX rename is atomic, so a crash mid-write can never
leave the target file half-written; the reader either sees the old
content or the new content, never a corrupt mix. Stale temp files (left
behind by a crash between the temp-write and the rename) are cleaned up
on the next store initialization.

## Corruption vs. empty vs. missing

`readJsonWithState()` returns one of five states, and callers are
required to handle them differently — a truncated file must never look
like "fresh install":

| State | Meaning | What happens |
|---|---|---|
| `missing` | No file at this path | Fresh envelope written, no error |
| `empty` | Valid envelope, zero records | Normal — a real fresh/cleared store |
| `populated` | Valid envelope, has records | Normal |
| `recovered` | Was corrupt, restored from backup | Logged as a flagged event |
| `corrupt` | Invalid JSON/shape, no valid backup exists | Store marked degraded; operator action required |

A corrupt file is never silently discarded — it's copied to
`<file>.corrupt-<timestamp>` before any recovery attempt, so the exact
bytes that were on disk remain inspectable even after the primary store
recovers.

## Backup rotation

`src/persistence/backup.js` — each store keeps up to 5 timestamped
backups under `data/backups/<storeName>/`. Critically, the backup is
taken of the version **just written**, not the version being replaced —
backing up the outgoing content instead would mean the most recently
written state is never itself backed up, so a corruption immediately
after a legitimate write could roll back further than the operator
expects. (This exact bug was caught and fixed during development —
verified live: create a record, corrupt the file, confirm recovery
returns the just-created record, not zero records.)

**Post-merge stabilization note**: a PR review later found that
`backup.js`'s own header comment still described the pre-fix (backwards)
behavior, even though the actual code had already been corrected — a
documentation-vs-implementation mismatch, not a behavior regression.
Re-verified with real files before touching anything (two sequential
writes, corrupt the primary file, `restore_backup`, confirm the SECOND
write's content — not the first — comes back) and covered by a dedicated
`test/integration.test.js` case; the comment was then corrected to match
the already-correct implementation.

## Schema versioning

Every snapshot store's envelope is `{schemaVersion, updatedAt, records}`.
On read, a mismatched `schemaVersion` triggers an optional `migrate()`
callback (none of the current stores define one — schema version 1 is
still current everywhere); if migration isn't possible, the store is
marked degraded with `unsupported_schema` rather than guessing at the
shape.

## Tamper detection — and why it never auto-heals

`src/persistence/integrityChain.js` — each snapshot store has a sidecar
hash file (`.{name}.hash.json`) recording the SHA-256 of the last
content **this application** wrote. On every read, the current file's
hash is compared against that record. A mismatch means the file changed
outside the API (a hand edit, an unrelated script, a bug in something
else writing to the same directory).

The critical property: `recordSnapshotHash()` — the function that
updates the expected hash — is only ever called from `persist()`, which
only runs on a write made **through this application's own code**.
Reading tampered content never updates the expected hash, so a tampered
file stays flagged on every subsequent read, indefinitely, until an
operator takes one of the two explicit recovery actions below. This was
a deliberate requirement (never auto-rebaseline tampering) and is
structurally guaranteed by where `recordSnapshotHash()` is called from,
not by an extra check that could be bypassed.

## The append-only audit log is a different shape

`events.jsonl` (`src/eventLog.js`, built on
`src/persistence/chainedLog.js`) doesn't use the hash-sidecar approach.
Each line carries `previousHash` (the hash of the line before it) and
`recordHash` (hash of this record + `previousHash`), so deleting or
editing any single line breaks the chain from that point forward.
`verify()` reports exactly where the break is, not just "something is
wrong." This is checked at boot; a broken chain marks the `events`
subsystem degraded via `systemState` and logs a console error, but
deliberately does NOT auto-append anything onto a chain the system just
determined it can't trust.

This is **not** cryptographic proof against a fully privileged attacker
who could recompute the whole chain from scratch with write access to
both the log and every hash along the way — see `docs/SECURITY_MODEL.md`
for what this protects against and what it doesn't. It reliably catches
anything that doesn't go through this module: hand edits, unrelated
bugs, bad migrations.

## Crash recovery for in-flight runs

A run's status of `running` only means something while the process that
started it is alive. If the server crashes (or is killed) while a run
is in progress, nothing updates that run's status — it would otherwise
sit as `running` forever, permanently inflating "active" counts and
never resolving into any success/failure accounting.

`runsStore.recoverInterruptedRuns()` runs at boot, before anything else
touches run state (`server.js`, right after `eventLog.init()`): every
run still marked `running` is flipped to `interrupted` — a distinct
terminal state, deliberately not `error`, because an interruption isn't
a known failure of the run itself, just an unknown outcome. This is
attributed to a `system_recovery` actor and logged as a flagged event
(`runs.recovered_after_restart`) if any runs were actually recovered.

Verified live (and covered by `test/integration.test.js`): start a
long-running custom agent, `kill -9` the server mid-run, confirm the run
is still `running` on disk, restart, confirm it's `interrupted` and the
agent's in-memory status correctly resets to `idle` rather than staying
stuck.

## Operator recovery: the two explicit actions

When a store is marked degraded (`corrupt_no_backup` or `tampered`),
recovery is exactly one of two explicit choices — there is no automatic
third option:

- **`restore_backup`** — discard the current file entirely, restore the
  newest valid backup. Use this when the current content is untrusted
  and you don't need whatever changed since the last backup.
- **`accept_current`** — keep the current on-disk content exactly as-is
  and record its hash as the new known-good baseline. Use this only
  after reviewing the diff and confirming the change was intentional
  (e.g., a deliberate manual edit, or a migration you ran by hand).

Exposed via `POST /api/security/stores/:storeName/recover` (body:
`{"resolution": "restore_backup" | "accept_current"}`) and, more
usably, via the Security view's degraded-store banner, which shows the
store, the reason, and both actions as separately confirmed buttons.
Both paths record a flagged `store.recovery_performed` audit event.
Recoverable store names: `agents`, `runs`, `workstreams`,
`security_events`, `config_history`. The append-only audit log
(`events`) is not in this list — see "A note on recovering the audit
log itself," below.

Verified live: tampering with `agents.json` directly on disk, confirming
`/api/security/status` reports degraded, calling the recovery endpoint
with each resolution and confirming the expected content and healthy
state afterward, and confirming an unknown store name (404) and an
invalid resolution value (400) are both rejected. Also verified through
the actual browser UI end-to-end.

### A note on recovering the audit log itself

`events.jsonl`'s chain-broken state is currently NOT recoverable through
this same endpoint. Discarding the broken tail of an audit trail is a
more consequential decision than restoring a snapshot store — it means
accepting that some history is unrecoverable — and deserves deliberate,
manual operator involvement (inspect `data/backups/events/`, decide how
much history to keep) rather than a one-click API action. This is a
documented scope boundary, not an oversight: automating it felt like
exactly the kind of shortcut this safety-foundation work was supposed to
avoid.

## `RUCKER_DATA_DIR`

Every store's data directory defaults to `<repo>/data` but can be
overridden with the `RUCKER_DATA_DIR` environment variable. This exists
primarily so automated tests can run a real server against a disposable
directory without touching a real deployment's data — see
`test/integration.test.js` — but also lets an operator point at a
different location (e.g., a mounted volume) without code changes.
