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
| **Effective-model accounting** | | |
| A blank-model paid agent records the model it actually executes against | Automated-test verified + Live runtime verified | `test/integration.test.js` (run record + `run.started` audit event both assert `claude-sonnet-5`); reproduced live before the fix against a real server, where the same run recorded `model: null` |
| The executed model is the one passed to `estimateCostUsd` | Automated-test verified | `test/effectiveModel.test.js` — resolved default prices to a non-null cost, while the previously-passed unresolved value prices to `null` |
| Default-model spend is visible to `knownCost` (and so to the budget caps) | Automated-test verified | `test/effectiveModel.test.js` — aggregate over two default-model runs is `complete` with `knownCost > 0`; the pre-fix shape is asserted alongside it as `unavailable` / `0` |
| An explicitly configured model is never replaced by a default | Automated-test verified | `test/effectiveModel.test.js`, `test/integration.test.js` (`gpt-4o` preserved) |
| A genuinely unpriced model still reports `costUsd: null` | Automated-test verified | `test/effectiveModel.test.js` — resolution preserves the unknown model rather than substituting a priced one |
| An unknown provider is never given another provider's default | Automated-test verified | `test/effectiveModel.test.js` |
| Every provider default has a pricing-table entry | Automated-test verified | `test/effectiveModel.test.js` — guards against a future default change silently re-hiding spend |
| Real paid-provider usage priced end-to-end through a live API call | Not verified | Same boundary as the `budget_pressure` row: would require real spend or SDK mocking. The integration tests exercise the provenance path without contacting a provider (the run record and audit event are written before the worker fails on the absent key) |
| **Feature Onboard — workspace operating layer** | | |
| Workspace-owned records never leak across workspaces (store level) | Automated-test verified | `test/workspaceStores.test.js` — get/update/delete under the wrong workspace; proven to fail when scoping is reduced to id-only |
| Workspace isolation holds over real HTTP | Automated-test verified | `test/integration.test.js` — cross-workspace GET/PUT/DELETE all 404 |
| Workspace isolation holds in the rendered UI | Automated-test verified | `test/frontend/featureOnboard.test.js` — switching workspaces swaps records for every record type; proven to fail when server-side scoping is removed |
| Workspace progress is computed server-side, never trusted from the client | Automated-test verified | `test/integration.test.js` — a client-supplied `progress: 99` is ignored; server returns the milestone-derived value |
| No milestones yields `null` (not a fabricated 0) | Automated-test verified | `test/progress.test.js` — proven to fail when changed to return 0 |
| YC sections carry their checklist items through the API | Automated-test verified | `test/workspaceStores.test.js` + `test/frontend/featureOnboard.test.js` — this exact contract broke once and the browser test is what caught it |
| YC scores update deterministically and survive reload | Automated-test verified | `test/frontend/featureOnboard.test.js` |
| YC score is never presented as an acceptance probability | Automated-test verified | `test/frontend/featureOnboard.test.js` asserts the rendered copy contains no probability language |
| Onboarding first-run / skip / resume / complete / reopen | Automated-test verified | `test/frontend/featureOnboard.test.js` (5 cases) + `test/integration.test.js` |
| Operator-controlled values render as text, not markup | Automated-test verified | `test/frontend/featureOnboard.test.js` — HTML, event-handler and quote-breaking payloads; proven to fail when `esc()` or `attr()` is broken |
| Every Feature Onboard store is **registered** for operator recovery | Automated-test verified | `test/integration.test.js` — proven to fail when one store is unregistered. **Verifies routing, not repair**: it calls `restore_backup` on healthy stores and asserts 200. Recovery from `corrupt_no_backup` is untested and currently returns 500 for both resolutions — see `docs/PERSISTENCE_AND_RECOVERY.md` and A-003. |
| Feature Onboard permission values gate agent behavior | **Not verified — nothing gates on them, by design** | **Zero of thirteen.** Established by reading every call site: `budget.assertWithinBudget()` and `src/workers/custom.js` both run unconditionally and never read these values. Three capabilities have a related always-on system control; none of the thirteen toggles gates anything. `test/domainModel.test.js` asserts `gatedByStoredValue === false` for all thirteen as a tripwire against a future overclaim. |
| Every capability is reviewable and configurable by the operator | Automated-test verified | `test/frontend/featureOnboard.test.js` — asserts all 13 backend keys render with their classification and enforcement point; proven to fail when 5 are dropped |
| No permission surface claims enforcement or approval it does not have | Automated-test verified | `test/frontend/featureOnboard.test.js` — checks the onboarding step, the agents tab and Settings against a list of forbidden *claims* (not vocabulary); proven to fail when "require your approval" is reintroduced |
| Permission changes persist per workspace and per agent | Automated-test verified | `test/frontend/featureOnboard.test.js` — two grants and one revocation across a reload; proven to fail when the client posts only the changed key |
| Every backend record type is reachable and usable by an operator | Automated-test verified | `test/frontend/featureOnboard.test.js` — reads the authoritative type list from `workspaceRecordsStore.ALL` and creates each through the real dialog; proven to fail when a tab is removed or a mapping omitted |
| Every API route is either operator-reachable or a documented API-only route | Automated-test verified | `test/routeCoverage.test.js` — collects routes from the real registration function; proven to fail on an unclassified route and on a `ui` route with no call site |
| One tampered store yields one integrity event per request, not one per entity | Automated-test verified | `test/integration.test.js` — 5 workspaces / 4 agents; proven to fail against the pre-fix code (5 and 8 events respectively) |
| A superseded workspace load can never render over the current one | Automated-test verified | `test/frontend/featureOnboard.test.js` — forces the race by delaying one workspace's fetch; proven to fail before the load-token fix |
| Every load-bearing guarantee is defended by a test that provably fails | Automated-test verified | A 20-mutation sweep across all three layers: each mutation is applied, **verified to have actually changed the file**, the layer is run, and the mutation restored. 19/20 caught on the first pass; the survivor exposed a real coverage gap (see below) and is now caught. Mutations covered: all four workspace-scoping terms independently, required-field-on-create, both halves of the date validator, unknown permission keys, `assertEnum`, `null`-vs-`0` progress, tamper re-baselining, recovery registration, both R-006 amplification paths, `esc()`, tab removal, capability rendering, approval-claim copy, both UI error paths, and the A-001 load token. |
| Every state-changing route writes an audit entry | Automated-test verified | `test/integration.test.js` — drives 22 mutating routes against a live server and diffs `events.jsonl`; asserts each returned 2xx first so a broken request cannot masquerade as a missing entry. One documented exception (`PUT /api/onboarding`, wizard autosave). Proven to fail when the Sentinel emit is removed. |
| Frontend status vocabularies match the backend | Automated-test verified | `test/routeCoverage.test.js` — proven to fail in **both** directions, including the silent one (backend gains a value the frontend lacks) |
| Every `src/` module is exercised by at least one test path | Automated-test verified (structural) | 35/35 reachable from the integration suite's real server boot or required directly by a unit test |
| Behaviour under **concurrent** operator actions | **Not verified** | Every test in every layer is strictly sequential. Races are only covered where a test forces one explicitly (the load-token case above). Concurrent permission edits are known-broken — see A-002. |
| A failed record load is shown as an error, never as an empty state | Automated-test verified | `test/frontend/featureOnboard.test.js` — corrupts a store beyond recovery and asserts the UI never renders "No workspaces yet" |
| Optional dates reject objects, arrays, malformed and ambiguous strings | Automated-test verified | `test/workspaceStores.test.js` + `test/integration.test.js` — all three date fields driven from one table; proven to fail against the pre-fix code |
| Accessibility semantics (dialog, tablist, progressbar, focus, Escape) | Automated-test verified (programmatic only) | `test/frontend/featureOnboard.test.js` — asserts roles/aria values/keyboard behavior. This is NOT the same as verification with a real screen reader, which was not done. |
| Mobile layout at 390px and on a short (keyboard-open) viewport | Automated-test verified | `test/frontend/featureOnboard.test.js` — no horizontal overflow, wizard reachable |
| Browser coverage beyond Chromium | Not verified | Firefox and WebKit are not exercised; the suite runs Chromium only |
| Feature Onboard behavior under concurrent multi-process access | Not verified (and not claimed) | Single-process assumption inherited from `instanceLock.js` |
| Mobile/responsive behavior of the new Security view | Not verified | The Phase 2 baseline's mobile patterns were reused (list/detail conventions, `activity-row` classes), but the Security view specifically was not tested at narrow viewport widths in this pass |

## Test suite summary

Every count below was re-derived from `grep -c '^ok - '` on actual command
output after the final code change, not carried forward from prose. Totals in
this repository have drifted twice before; they are regenerated, never edited.

`npm run test:unit` = `test/runsStore.pricing.test.js` (6) +
`test/runsStore.executionSuccess.test.js` (5) +
`test/workstreamsStore.test.js` (15, includes 3 Option B cases) +
`test/effectiveModel.test.js` (11) + `test/progress.test.js` (14) +
`test/domainModel.test.js` (17) + `test/workspaceStores.test.js` (24) +
`test/routeCoverage.test.js` (6) = **98**.

`test/integration.test.js` (**36** cases, spawning real server processes
against throwaway data directories) +
`test/frontend/featureOnboard.test.js` (**41** cases, driving real Chromium
against a real server).

**98 unit + 36 integration + 41 browser = 175 tests, all passing** as of the
final commit on this branch, and verified green in CI on the remote branch
(`.github/workflows/ci.yml`).

(Corrected twice during this work. First: the per-file counts were right while
the summed total carried a stale value forward through several doc updates.
Second: the totals were re-derived after the review pass added 24 cases. Both
are why the counts are now taken from raw output rather than read off a
summary line.)

Each of the 6 new stabilization tests was confirmed to genuinely catch its
regression: the corresponding fix was temporarily reverted (`git stash`)
and the affected tests were re-run, confirming 4 of them fail without the
fix (the workstream-resolution, whitespace-validation, provider-switch,
and maxTokens fixes all live in files that were stashed); the other 2
(backup-timing, idempotency-conflict) have their fixes in files that
weren't part of that particular stash and so continued passing — those
were instead confirmed against real file contents / real HTTP responses
before the fix was applied, as described in their rows above.
