# Security Model

## Threat model

Rucker Park is built for **one trusted human operator, running the
server on a machine they control, with no other authenticated users**.
This is not a placeholder for "auth coming later, ignore for now" — it's
the actual current scope, stated explicitly so every control below can
be evaluated against what it's meant to defend, rather than judged
against a multi-tenant system it isn't.

What that means concretely:

- **In scope**: protecting the operator from their own mistakes and
  from bugs in this system (corruption, crashes, runaway processes,
  budget overruns); protecting the system from a webpage the operator
  visits in the same browser (CSRF); protecting the audit trail from
  silent tampering (by this system or by something else with
  filesystem access); making sure a custom agent's shell command can't
  read the credentials that fund the system's own paid-provider calls.
- **Out of scope for this pass**: multiple authenticated users with
  different permission levels; protecting against an attacker who
  already has a shell on the host machine (they can read `data/`
  directly regardless of anything this application does); protecting
  against a fully privileged attacker who can rewrite the audit chain
  from scratch (see `docs/PERSISTENCE_AND_RECOVERY.md`); any kind of
  network-facing exposure beyond localhost (the server binds to
  `127.0.0.1` by default and is not meant to be exposed directly to the
  internet without the operator adding their own auth/reverse-proxy
  layer — this is stated in the README and unchanged by this work).

## Controls actually implemented, and what each one prevents

### Secret exclusion for custom-command agents (`src/workers/custom.js`)

**Before this work**: a `custom`-provider agent's shell command ran with
`env: process.env` — the full server environment, including
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. Verified live during this work: a
custom agent running `echo $ANTHROPIC_API_KEY` printed the real key.
This meant the system's own agents could read the credentials funding
their own execution — not a hypothetical external-attacker scenario.

**Now**: `minimalEnv()` passes only an explicit allowlist
(`PATH`, `HOME`, `TMPDIR`/`TEMP`/`TMP`, `LANG`, `LC_ALL`, `TERM`, `USER`,
`SHELL`). Provider API keys are never in scope. Verified live and via
`test/integration.test.js` ("custom agents never see the server process
environment").

### Path traversal in agent log deletion (`src/agentManager.js`)

**Found and fixed during this work**: `DELETE /api/agents/:id` called
`agentManager.discard(id)` — which unlinks
`LOGS_DIR/${id}.log` — before checking the agent existed. Since `id` is
an unvalidated Express route param, a crafted id like
`../../../../tmp/some-target` resolved outside `LOGS_DIR` entirely.
Verified live: a DELETE against a non-existent, traversal-crafted agent
id could reach and delete an arbitrary `*.log` file elsewhere on the
filesystem (bounded by a forced `.log` suffix the attacker doesn't
control, but still a real out-of-scope deletion).

**Fix**: `logFilePath()` now runs the id through `path.basename()`
before joining it to `LOGS_DIR`, so the result can never leave that
directory regardless of what's in `id` — a fix at the lowest level, so
every current and future call site is protected, not just the one route
that happened to trigger it. The DELETE handler also now checks
existence before calling `discard()` at all, as defense in depth.
Verified live and via `test/integration.test.js`.

### CSRF / browser-origin protection (`src/server.js`,
`originCheckMiddleware`)

No auth system exists, and "binds to localhost" does not mean "safe
from the browser": any webpage the operator has open in the same
browser as the dashboard can still send a request to
`http://127.0.0.1:PORT` — the browser only blocks that page's JS from
*reading* the response, not from *sending* the request. `/start` and
`/stop` take no body, so a plain cross-origin
`fetch(url, {method:'POST'})` is a "simple" request needing no CORS
preflight, and would otherwise reach the server and actually act.

**Mitigation**: state-changing requests (non-GET/HEAD/OPTIONS) whose
`Origin` header doesn't match this server are rejected with 403.
Requests with no `Origin` header at all (curl, server-to-server calls,
the `X-Rucker-Client` automation convention) are allowed through —
browsers reliably send `Origin` on cross-site state-changing requests,
so its absence means a non-browser caller, not an exploitable gap. This
is a standard, low-cost mitigation appropriate for a system with no
session/token infrastructure to build real CSRF tokens on top of.
Verified live and via `test/integration.test.js`.

### Tamper detection and the append-only audit chain

Covered in full in `docs/PERSISTENCE_AND_RECOVERY.md`. The security-
relevant summary: any store file edited outside this application is
detected on the next read and stays flagged until an operator explicitly
resolves it (never silently re-baselined); the audit log itself is
hash-chained so a deleted or edited line breaks verifiably from that
point forward, closing what would otherwise be "the audit log can't
detect tampering with itself."

### Process isolation and containment

`terminateProcessGroup()` (`src/workers/custom.js`) reaches a custom
command's full process tree via `detached: true` + negative-PID
`kill()`, not just the immediate shell wrapper — a plain
`child.kill('SIGTERM')` could leave a grandchild process (e.g. `sleep`
under `sh -c`) running after "stop" was clicked. Graceful SIGTERM first,
forced SIGKILL after a grace period. Verified live: spawn a `sleep 30`
custom agent, call stop, poll for the actual OS process disappearing
(not just the tracked handle).

### Runtime and output limits (`agentManager.js`, `workers/custom.js`)

A hard per-run runtime ceiling (default 30 min, per-agent configurable
via `agent.maxRuntimeMs`) and a per-run output-size cap (default 1MB,
`RUCKER_MAX_OUTPUT_BYTES`) exist so a hung provider call or a runaway
looping command doesn't run — or produce output — forever with nothing
watching. A timeout is attributed to a `policy_engine` actor, distinct
from whoever started the run, since the system enforced it, not them.

### Spending controls (`src/budget.js`)

Per-agent-daily and system-daily cost ceilings, checked before a
paid-provider run is allowed to start (never applies to `custom` agents,
which have no cost concept). All limits are opt-in (unset env vars =
unlimited), so a fresh install has no surprise blocking behavior. A
per-run cap can't be checked before the call — cost is only known once
usage is reported back — so it's instead surfaced as a flagged policy
signal after the fact, feeding the `budget_pressure` Sentinel rule if it
recurs. See `docs/SENTINEL.md`.

### Single-instance lock (`src/instanceLock.js`)

Every store here assumes exactly one process owns `data/` at a time.
Two processes racing on the same JSON file (read-modify-write, no
cross-process locking on individual files) could silently drop one
process's change with no conflict detection. The lock refuses to start
a second instance against a data directory a live process already
holds, while correctly reclaiming a stale lock left behind by a crash
(checked against the live process table, not just file existence — a
hard `kill -9` never permanently locks out a legitimate restart).
Verified live.

### Idempotency keys (`src/idempotency.js`)

A client that times out waiting for a response has no way to know
whether the request landed. An `Idempotency-Key` header lets a retry ask
for "the result of that same request" instead of re-executing it — most
concretely, a retried `/start` doesn't launch a second run. This is a
convenience/retry-safety layer, not the sole guarantee: `agentManager`'s
own running-state check already makes a true concurrent double-start
impossible independent of this cache.

**Found and fixed during the post-merge stabilization pass**: the cache
was originally keyed on `(method, path, key)` only, with no check on the
request body. Reusing the same key with a genuinely different payload (a
stale key from a previous form, a UUID collision, a client bug) silently
returned the FIRST request's response — the client would see a
successful 201 and believe its own (different) payload had been applied,
when nothing about that payload was actually processed. Each cached entry
now also stores a hash of the request body, checked on reuse; reusing a
key with a different payload returns a clean `409 IDEMPOTENCY_CONFLICT`
instead. Verified live and via `test/integration.test.js`.

### Workspace separation is NOT a security boundary

Feature Onboard adds business workspaces. Every workspace-owned record carries
a `workspaceId`, and every store operation is keyed on `(workspaceId, id)`
together, so a record filed under one workspace is not reachable through
another — verified at the store level, over HTTP, and in the rendered UI, each
with a test proven to fail when the scoping is removed.

The UI-level half of that claim needed correcting once and is worth stating
precisely, because it is the layer the operator actually sees. Scoping is
enforced in the stores and over HTTP; the UI additionally has to avoid
*displaying* the wrong workspace's data, which is a different problem and was
briefly broken. A slow load for a workspace the operator had already navigated
away from resolved later and overwrote the current one, so the selector read
one workspace while the panel rendered another's records. Fixed with a
monotonic load token in `loadActiveWorkspaceDetail()` and covered by a
regression case that forces the race deterministically by delaying one
workspace's fetch. What is verified is therefore: the stores and API never
*return* another workspace's records, and the UI never *renders* them,
including under a raced load.

That property is **organizational separation, not tenant isolation**, and the
distinction matters:

- There is still **no authentication**. Anyone who can reach the API can reach
  every workspace. Scoping prevents accidental cross-contamination of one
  business's records into another's views; it stops nothing an attacker does.
- It is enforced in application code only. Anyone with filesystem access reads
  every workspace's JSON directly, exactly as before.
- It must never be cited as a reason this system could host more than one
  person's data. Multi-user use would require authentication, authorization,
  and a re-examination of the `custom` provider (below) — none of which exist.

### Feature Onboard permissions are recorded, not enforced

Business → Agents → Review permissions lists all thirteen capabilities (spend
money, run commands, contact people, act without approval, and so on) with
least-authority defaults — every consequential capability is off unless
explicitly granted.

**No stored value on that screen is consulted by the runtime.** All thirteen
are recorded and displayed only. This is stronger than the earlier claim in
this document, which said three were "enforced"; that was checked against every
call site and found to be misleading:

- `budget.assertWithinBudget()` runs before every run and reads the configured
  daily caps. It never reads `spend_money` or `paid_model_calls` for this agent
  or workspace.
- `src/workers/custom.js` applies its trusted-operator boundary and
  `minimalEnv()` to every custom run. It never reads `use_custom_provider`.

Those two controls are real and do constrain the system — they are simply
**not gated on these settings**. So three actions have an always-on system
control, and zero of the thirteen toggles gate anything.

There is also **no approval workflow** anywhere in this system. Nothing pauses
to ask the operator before an agent acts, and no surface may imply otherwise.

This is why neither the interface nor `docs/FEATURE_ONBOARD.md` describes those
permissions as "blocked" or "protected". Granting or denying them changes what
is recorded, not what an agent can do. The full per-capability table lives in
`docs/FEATURE_ONBOARD.md`.

## Explicitly accepted, not fixed: shell injection via `custom` agents

`workers/custom.js` runs `spawn(agent.command, { shell: true, ... })`.
This is **not treated as a vulnerability** — a `custom` agent's command
is authored by the operator themselves, through the same trusted API
that creates and edits every other agent. The threat model in this pass
does not include the operator attacking themselves via their own agent
configuration. If this system ever accepts agent configuration from an
untrusted source (a second user, an external API with different trust),
this becomes a real, unaddressed risk and would need to be revisited
before that expansion — flagged here explicitly so it isn't rediscovered
as a surprise.

## Explicitly not attempted: log injection

Every audit/security event is JSON-serialized before being written
(`JSON.stringify`), so arbitrary string content in a `details` field
(including embedded newlines) cannot break the JSONL structure —
`JSON.stringify` escapes those characters within the string value. This
was reviewed, not just assumed; no fix was needed because there was no
finding.

## What Sentinel is and is not, security-wise

See `docs/SENTINEL.md` for the full design. The one-line version
relevant here: Sentinel is a deterministic rule engine over data this
system already collects. It is explicitly **not** an autonomous
offensive-security agent (no scanning, no probing, no "hack back"), not
an AI/LLM-driven classifier (detection is 100% deterministic
conditionals), and never takes a containment action on its own — every
state transition on a finding requires an explicit operator API call.
