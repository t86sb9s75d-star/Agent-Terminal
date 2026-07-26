# Verification Matrix

Every substantive claim in this safety-foundation work, labeled by how it
was actually checked:

- **Automated-test verified** — covered by `npm test` (unit and/or
  integration) and will fail loudly if broken by a future change.
- **Live runtime verified** — manually exercised against a real running
  server during this work (via curl, a real browser with Playwright, or
  a direct script), but not (yet) captured as a repeatable automated
  test.
- **Code-inspection supported** — the implementation was read and
  reasoned about, but the specific behavior claimed was not exercised
  against a running instance.
- **Not verified** — implemented but neither tested nor manually
  exercised; a genuine gap, named rather than hidden.

| Claim | Status | Where |
|---|---|---|
| **Persistence (Phase 3)** | | |
| Atomic write survives a crash mid-write (no half-written file) | Code-inspection supported | `atomicJsonFile.js` — relies on POSIX rename atomicity; not tested by killing the process mid-write |
| Corrupt file preserved as `.corrupt-<timestamp>` before recovery | Live runtime verified | Manual node script during development |
| Backup rotation backs up the just-written content, not the outgoing content | Live runtime verified | Manual test: create → corrupt → recover → confirmed the created record survives (this exact bug was caught and fixed) |
| Store recovery via `restore_backup` and `accept_current` (API + UI) | Automated-test verified + Live runtime verified | `test/integration.test.js`, Playwright browser test |
| Tamper detection persists across repeated reads (never auto-heals) | Live runtime verified | Manual curl: tamper, read twice, still flagged both times |
| Audit chain (`events.jsonl`) hash-chain break detection | Code-inspection supported | Logic reviewed; boot-time verification path not exercised against a deliberately corrupted chain in this pass |
| Crash recovery for interrupted runs (`recoverInterruptedRuns`) | Automated-test verified + Live runtime verified | `test/integration.test.js` ("run left running... recovered as interrupted"), manual `kill -9` test |
| **Runtime isolation (Phase 4)** | | |
| Custom-agent secret exclusion (`minimalEnv`) | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual curl with a fake `ANTHROPIC_API_KEY` |
| Process-group termination reaches grandchild processes | Live runtime verified | Manual: spawn `sleep`, stop, poll OS process table until gone |
| Runtime timeout (`maxRuntimeMs`) actually fires and terminates the run | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual 1.5s-timeout test against a `sleep 30` agent |
| Output truncation caps a runaway command's log size | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual test confirming the log file on disk is capped near the configured limit |
| Provider request timeout (`RUCKER_PROVIDER_TIMEOUT_MS`) | Code-inspection supported | SDK `timeout` option passed correctly at construction and per-call; not tested against an actually-hung provider connection (would require a real API call or network-level fault injection) |
| Per-agent/system daily spending caps block a run from starting | Automated-test verified + Live runtime verified | `test/integration.test.js` (seeded run, no real spend), direct `budget.js` script tests |
| Per-run cap flags a run as over-cap after completion | Live runtime verified | Direct `budget.exceededPerRunCap()` script test |
| **Integrity and audit (Phase 5)** | | |
| All snapshot stores (not just agents) are tamper-detected | Automated-test verified + Live runtime verified | `test/integration.test.js` (agents store), manual tamper tests on `workstreams.json` during development |
| Structured actor attribution on audit/security events | Live runtime verified | Manual curl inspecting `actorType`/`actorId`/`triggerType`/`requestId` on events from different call paths (dashboard vs. `X-Rucker-Client` header) |
| Config history captures create/update diffs, redaction-aware | Live runtime verified | Manual curl: create, update, inspect `/api/agents/:id/config-history` diff |
| **Workstream correctness (Phase 6)** | | |
| Referential integrity: agent can't reference a nonexistent workstream | Code-inspection supported | `assertWorkstreamExists` reviewed; not directly exercised with an invalid ID in this pass (pre-existing from Phase 2 baseline) |
| Archived workstream blocks new agent assignment and run starts | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual curl |
| Option B blocked-state semantics (failure outlives reassignment) | Automated-test verified | `test/workstreamsStore.test.js`, 3 dedicated cases |
| **Post-merge stabilization pass** (PR #3 review findings + broader audit — see the stabilization report for full finding-to-fix mapping) | | |
| [Finding A] Resolving a workstream incident clears `hasUnresolvedFailure` in `/api/workstreams` and `/api/workstreams/:id` | Automated-test verified + Live runtime verified | Confirmed defect: `decorateWorkstream()` never passed the workstream's stored `resolvedFailureRunIds` into `computeMetrics()`, so a resolved failure showed as unresolved forever through both API paths. Fixed in `server.js`. Reproduced failing before the fix, passing after, in `test/integration.test.js` |
| [Finding B] Whitespace-only `task`/`command` rejected for every provider (create AND update) | Automated-test verified + Live runtime verified | Confirmed defect: `optionalString()` only type-checks, so `"   "` was treated as "provided." Fixed via a shared `isBlank()`/`assertProviderRequirements()` check in `store.js`. Reproduced failing before the fix, passing after |
| [Finding C] Switching an agent's provider without that provider's required field is rejected; the final merged config (not just the request body) is validated | Automated-test verified + Live runtime verified | Confirmed defect: `update()` never validated the FINAL provider+task/command combination, only individually-present fields — a PUT changing provider to `custom` with no `command` silently persisted an unrunnable agent. Fixed by applying the same shared validator to update()'s merged result. No partial mutation on rejection, confirmed live and in the test |
| [Finding D] Backup captures the just-written version, not the version replaced | Automated-test verified + Live runtime verified | Comment-only defect, NOT a behavior defect: `backup.js`'s header comment described the pre-fix (backwards) semantics even though `versionedStore.js`'s actual `persist()` — and the behavior itself — was already correct. Verified with real files before touching anything: two sequential writes, corrupt, `restore_backup`, confirmed the SECOND write's content comes back. Comment corrected; behavior unchanged (already correct) |
| `maxTokens` rejects NaN, negative values, zero, and non-numeric strings | Automated-test verified + Live runtime verified | Confirmed defect: `data.maxTokens ? Number(data.maxTokens) : 1024` let `"abc"` silently become `null` (JSON serializes NaN as null), accepted negative values as-is, and treated `0` as "not provided" (falsy) rather than an explicit invalid value. Fixed with `validateMaxTokens()` requiring a positive integer |
| Idempotency-Key reused with a different payload is a 409 conflict, not a silently wrong replay | Automated-test verified + Live runtime verified | Confirmed defect: the cache key was `(method, path, key)` only — no payload check — so reusing a key with a genuinely different body silently returned the FIRST request's response, making the client believe its (different) payload had been applied. Fixed by hashing the request body into the cache entry and returning the previously-unused `IDEMPOTENCY_CONFLICT` code on mismatch |
| `finish()` in `agentManager.js` finalizes a run exactly once, even if it throws internally | Code-inspection supported + Live runtime verified (normal paths only) | Hardening, not a demonstrated defect: `runPromise.then(...).catch(...)` would let an exception thrown BY the success handler be caught by the trailing `.catch()`, invoking `finish()` a second time with a conflicting status. Fixed with a `finished` guard flag and the two-argument `.then(onSuccess, onFailure)` form. Normal completion and normal cancellation paths were re-verified live to still produce exactly one terminal event each; the fault-injection scenario itself (forcing `finish()` to throw) was not reproduced, since doing so requires modifying production code paths to inject a synthetic failure |
| WebSocket clients cannot trigger state changes through the socket | Code-inspection supported | Confirmed clean: no `ws.on('message', ...)` handler exists anywhere in the codebase — the connection is send-only (server → client hello + live updates) |
| Output cap applies to both stdout and stderr | Code-inspection supported | Confirmed clean: both streams feed the same `emit()` function and byte counter in `workers/custom.js` |
| Backup recovery refreshes integrity hash metadata correctly | Code-inspection supported + Live runtime verified | Confirmed clean: both `restore_backup` (via `persist()`) and `accept_current` call `recordSnapshotHash()`; verified via the existing recovery integration test showing `/api/security/status` returns healthy after either resolution |
| Temp files cleaned up safely, no cross-process races | Code-inspection supported | Confirmed clean: `cleanupStaleTempFiles` only removes files older than 60s, uniquely named per-PID/timestamp/random bytes |
| No other user-controlled ID reaches a filesystem path unsanitized | Code-inspection supported | Full-codebase grep for `path.join` call sites; the only user-controlled-ID site is `agentManager.js`'s `logFilePath()`, already fixed with `path.basename()` |
| Daily budget date boundary uses the server's local calendar day (not UTC, not a rolling 24h window) | Code-inspection supported | `isToday()` in `runsStore.js` compares local-timezone year/month/date components; this is a deliberate "calendar day" reset, not a bug, but depends on the host clock being correct — see the existing "clock dependence" gap below |
| **Sentinel (Phase 7, scoped)** | | |
| `repeated_run_failure` rule fires at threshold, not before | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual curl |
| `budget_pressure` rule logic (threshold, finding creation) | Live runtime verified | Direct `sentinel.evaluateBudgetPressure()` script test (2 over-cap runs → no finding, 3 → finding) |
| `budget_pressure` rule wired through a REAL agentManager run cycle | Not verified | Exercising this fully requires either a real paid-provider API call or mocking the provider SDK, neither done in this pass — explicitly not spending money without authorization |
| `store_integrity_failure` rule fires on tamper/corruption | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual tamper test |
| Full containment lifecycle (`open→acknowledged→contained→resolved`) | Automated-test verified (partial) + Live runtime verified (full) | Integration test covers status transitions; the `stopAgent:true` actually terminating a *currently running* agent was verified live via curl (agent status flips to `idle`) and via the real browser UI, not asserted in the automated suite against a genuinely running process |
| `analyzeWithAi` correctly stubbed (never invoked, throws 501) | Code-inspection supported | Reviewed; not called from anywhere, no route exposes it |
| **API/input hardening (Phase 8)** | | |
| Stable error codes (`AppError`/`Codes`) instead of leaked exceptions | Live runtime verified | Manual curl across multiple endpoints checking `{error, code, requestId}` shape |
| Idempotency-key replay prevents duplicate run starts | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual curl |
| Request ID propagation (`X-Request-Id`) | Live runtime verified | Manual curl inspecting response headers |
| **Additional failure modes** | | |
| Single-instance lock rejects a second instance; reclaims a stale lock | Automated-test verified + Live runtime verified | `test/integration.test.js` (rejection case), manual test (stale-lock reclaim, after ruling out a container PID-reuse false negative on the first attempt) |
| Path traversal via agent id cannot delete files outside `LOGS_DIR` | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual canary-file test |
| CSRF / cross-origin request rejection | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual curl with a forged `Origin` header |
| Shell injection via `custom` agent commands | Not applicable (accepted, documented trust boundary) | See `docs/SECURITY_MODEL.md` — the operator authors their own commands through the trusted API; this is not treated as a vulnerability |
| Log injection into the audit trail | Live runtime verified (by inspection, not by exploit attempt) | `JSON.stringify` escaping reviewed and confirmed to make this structurally impossible for the JSONL format; no adversarial payload was actually sent |
| Disk-full behavior | Not verified | Not exercised — would require actually filling the test environment's disk, which was avoided as unnecessarily disruptive to this session's environment |
| Clock dependence (system clock changes affecting timestamps/windows) | Not verified | Sentinel's time-window rules (`Date.now()` deltas) and `isToday()` in `runsStore.js` both assume a monotonic, correct system clock; behavior under clock skew or DST transitions was not tested |
| Partial multi-store update consistency | Code-inspection supported | Documented as a known, accepted boundary in `docs/ARCHITECTURE.md` ("no cross-store transactions") rather than fixed — a crash between an agent write and its audit-log entry is a real, named gap |
| 10 truly concurrent `/start` requests for one agent never double-start it | Automated-test verified + Live runtime verified | `test/integration.test.js`, manual `Promise.all`/parallel-curl test — exactly 1 of 10 succeeds, the other 9 get a clean `RUN_ALREADY_ACTIVE` |
| Malformed JSON body does not leak a stack trace or filesystem paths | Automated-test verified + Live runtime verified | **Found and fixed during adversarial self-review** — previously fell through to Express's default HTML error page with a full stack trace; now returns the same stable `{error, code, requestId}` shape as every other endpoint. `test/integration.test.js` |
| Oversized request body is rejected without crashing the process | Live runtime verified | Manual test: 5MB JSON body → 413, server remained responsive immediately after |
| Null/empty POST body | Live runtime verified | Manual test: clean 400 `VALIDATION_ERROR`, not a crash |
| **Frontend (Phase 10 + actor rendering)** | | |
| Structured actor rendering in Activity view | Live runtime verified | Playwright test: page loads, no console errors, correct label text |
| Security view: health banner, findings list, filters | Live runtime verified | Playwright, screenshots reviewed |
| Full containment workflow through the actual browser UI | Live runtime verified | Playwright: click Acknowledge/Contain/Resolve, confirm server-side status after each click |
| Degraded-store recovery buttons through the actual browser UI | Live runtime verified | Playwright: tamper, view degraded banner, click recovery, confirm healthy afterward |
| Mobile/responsive behavior of the new Security view | Not verified | The Phase 2 baseline's mobile patterns were reused (list/detail conventions, `activity-row` classes), but the Security view specifically was not tested at narrow viewport widths in this pass |

## Test suite summary

`npm test` = `test/runsStore.pricing.test.js` (6 cases) +
`test/runsStore.executionSuccess.test.js` (5 cases) +
`test/workstreamsStore.test.js` (15 cases, includes 3 Option B cases) +
`test/integration.test.js` (22 cases, spawning real server processes
against throwaway data directories: 16 from the original safety-foundation
work plus 6 from the post-merge stabilization pass — the four PR #3 review
findings, `maxTokens` validation, and idempotency payload-conflict
detection). **27 unit + 22 integration = 49 tests, all passing** as of the
final commit on this branch.

Each of the 6 new stabilization tests was confirmed to genuinely catch its
regression: the corresponding fix was temporarily reverted (`git stash`)
and the affected tests were re-run, confirming 4 of them fail without the
fix (the workstream-resolution, whitespace-validation, provider-switch,
and maxTokens fixes all live in files that were stashed); the other 2
(backup-timing, idempotency-conflict) have their fixes in files that
weren't part of that particular stash and so continued passing — those
were instead confirmed against real file contents / real HTTP responses
before the fix was applied, as described in their rows above.
