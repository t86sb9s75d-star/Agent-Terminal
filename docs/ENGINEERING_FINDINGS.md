# Engineering findings

An evidence log, not a narrative. Every meaningful defect found while building
and reviewing Feature Onboard, including ones found and fixed during
implementation rather than at review — those are the majority, and omitting
them would make the record look tidier than the work was.

Each entry states what was wrong, how it was reproduced, what the root cause
was (as distinct from the symptom), what now prevents it, and — where a
mutation was run — the exact failure the regression test produces against the
broken version. Where a fix was partial, the remaining risk is named.

Severity is about consequence to the operator, not effort to fix.

**Status key**: `fixed` · `fixed (partial)` · `documented` · `open`

---

## Index

| ID | Phase | Severity | Category | Status | Summary |
|---|---|---|---|---|---|
| F-001 | 6 baseline | Low | process hygiene | fixed | failing tests leaked temp directories |
| F-002 | 6 | High | dependency security | fixed | Playwright < 1.55.1 advisory |
| F-003 | 6 | Medium | vacuous test | fixed | attribute-escaping test passed with escaping disabled |
| F-004 | 7 | Low | documentation | fixed | stale test totals in three documents |
| F-005 | 2c | High | validation | fixed | five record types creatable with no required field |
| F-006 | 2c | Medium | validation | fixed | agent `config` accepted arrays |
| F-007 | 4 | High | API/UI contract | fixed | YC response dropped section items; API tests green, tab empty |
| F-008 | 7 | Medium | verification integrity | fixed | fresh-clone commands ran in the original repository |
| F-009 | 3 | Low | backup semantics | fixed | backup taken of outgoing rather than written content |
| R-001 | review | High | scope completeness | fixed | tasks and experiments unreachable by any operator |
| R-002 | review | High | scope completeness | fixed | no permission review surface existed |
| R-003 | review | Medium | documentation | fixed | three surfaces described a permission UI that did not exist |
| R-004 | review | Medium | operator trust | fixed | onboarding claimed actions "require your approval" |
| R-005 | review | Low | scope completeness | fixed | archive/edit routes with no affordance |
| R-006 | review | High | integrity/observability | fixed | one tampered store produced N events and N findings per request |
| R-007 | review | Low | data contract | fixed | two date fields unvalidated while a third was |
| R-008 | review | Low | test quality | fixed | isolation test name overclaimed; assertions negative-only |
| R-009 | this pass | High | operator trust | fixed | three capabilities labelled "enforced" gated nothing |
| R-010 | this pass | Medium | error handling | fixed | unreadable store rendered as "No workspaces yet" |
| R-011 | this pass | Low | dead code | fixed | `requiresApproval()` named a mechanism that does not exist |
| R-012 | this pass | Low | dead code | fixed | dead export crashed the server; syntax check did not catch it |
| R-013 | this pass | Medium | test quality | fixed | my own permission test passed against a broken client |
| R-014 | this pass | Low | observability | documented | Sentinel findings still grow one per request per tampered store |
| R-015 | this pass | Medium | data contract | fixed | my own date validator accepted 2026-02-31 while claiming to reject it |
| R-016 | this pass | Low | test quality | fixed | my own route contract passed a route with no affordance |
| A-001 | hostile review | High | isolation / state desync | fixed | a superseded load painted another workspace's records over the current one |
| A-002 | hostile review | High | lost update | deferred | concurrent permission edits silently revert each other |
| A-003 | hostile review | High | broken recovery | documented | `corrupt_no_backup` cannot be repaired through the product |
| A-004 | hostile review | Medium | API contract | documented | oversized request body returns 500, not a documented error |
| A-005 | hostile review | Low | dead code | fixed | added a dead export in the same branch that removed one |
| A-006 | hostile review | Low | performance | documented | O(n*m) rendering in the two new tabs |
| A-007 | mutation sweep | Medium | test blind spot | fixed | the detail-load error path was uncovered; only the list-load path was tested |
| A-008 | mutation sweep | Low | process hygiene | documented | the browser harness leaks Chromium and a temp dir when the suite is killed |

---

## F-001 — Failing tests leaked temporary directories

- **Phase / date**: Phase 6 baseline sweep
- **Severity**: Low · **Category**: process hygiene · **Status**: fixed
- **Discovered by**: baseline environment audit before starting Phase 6
- **Files**: `test/workspaceStores.test.js`
- **Symptom**: `/tmp` accumulated `rucker-ws-stores-*` directories.
- **Reproduction**: force any assertion in the file to fail; the process exits
  before the cleanup line at the bottom of the file.
- **Root cause**: cleanup ran only on the happy path — a single `fs.rmSync` at
  the end of the module, unreachable once an assertion throws.
- **Fix**: `process.on('exit')` and `process.on('uncaughtException')` handlers
  so the scratch directory is removed however the process ends.
- **Regression coverage**: none automated (a test that asserts on its own
  cleanup is circular). Verified manually by forcing a failure.
- **Same-pattern search**: every test file that creates a temp directory was
  checked; `test/integration.test.js` already cleaned up in `finally` blocks.
- **Remaining risk**: `SIGKILL` still leaks. Accepted.
- **Generalizes**: yes — cleanup registered on the happy path only is a common
  shape and is invisible while tests pass.

## F-002 — Playwright version carried a high-severity advisory

- **Phase**: 6 · **Severity**: High · **Category**: dependency security · **Status**: fixed
- **Discovered by**: `npm audit` in the new CI workflow
- **Files**: `package.json`, `package-lock.json`, `test/frontend/harness.js`
- **Symptom**: GHSA-7mvr-c777-76hp affects every Playwright release before 1.55.1.
- **Root cause**: the version was chosen when the suite was written and not
  audited before committing.
- **Fix**: upgraded to 1.55.1. That moved the expected bundled Chromium
  revision (1148 → 1193) while the machine had 1194, so `resolveChromium()`
  became a three-tier resolver: `RUCKER_CHROMIUM`, then the playwright-managed
  browser, then a glob under `PLAYWRIGHT_BROWSERS_PATH`.
- **Regression coverage**: `npm audit --audit-level=moderate` runs in CI and
  fails the build.
- **Remaining risk**: an advisory published after a green run is not
  retroactively caught. Inherent to audit-at-build-time.
- **Generalizes**: partially — the interesting part is that a security upgrade
  moved a *runtime* expectation (browser revision), which is easy to miss.

## F-003 — The attribute-escaping test could not fail

- **Phase**: 6 · **Severity**: Medium · **Category**: vacuous test · **Status**: fixed
- **Discovered by**: asking "what broken implementation still passes this?"
- **Files**: `test/frontend/featureOnboard.test.js`
- **Symptom**: a test named for attribute-context escaping passed with
  `attr()` replaced by the identity function.
- **Reproduction**: `const attr = (s) => s;` — suite stayed green.
- **Root cause**: the payload was placed in a goal *title*, which renders in
  text context. Nothing operator-controlled reached an attribute at all, so
  the test never exercised the function it was named for.
- **Fix**: rewritten to deliver the payload through the one value that does
  reach an attribute — a record `id` — injected by tampering the store file on
  disk, which is a delivery path this project's threat model contemplates.
- **Fail-without proof**: with `attr()` disabled the rewritten test fails on
  "a malicious id must not be able to forge an event-handler attribute".
- **Same-pattern search**: every security-relevant test was re-read against the
  same question. R-008 and R-013 came out of that habit later.
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §5.

## F-004 — Documentation totals had drifted

- **Phase**: 7 · **Severity**: Low · **Category**: documentation · **Status**: fixed
- **Files**: `README.md`, `docs/VERIFICATION_MATRIX.md`, `docs/FEATURE_ONBOARD.md`
- **Symptom**: docs claimed 37 unit + 24 integration = 61; actual was 86 + 32 + 29 = 147.
- **Root cause**: prose carried counts forward instead of being re-derived from
  command output.
- **Fix**: re-derived from raw `ok -` counts. A self-caught arithmetic slip
  during the same pass (integration was 32, not 31) is why the counts are now
  taken from `grep -c '^ok - '` rather than read off a summary line.
- **Remaining risk**: still manual. Any change to test counts requires
  regenerating all three documents.
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §6.

## F-005 — Five record types could be created with no required field

- **Phase**: 2c · **Severity**: High · **Category**: validation · **Status**: fixed
- **Files**: `src/workspaceRecordsStore.js`
- **Symptom**: `POST` with no `title`/`statement`/`summary` returned 201 and
  stored `undefined`.
- **Root cause**: the idiom
  `data.x !== undefined ? requireString(data.x) : existing?.x` is correct on
  update and silently wrong on create — with no `existing`, an omitted value
  becomes `undefined` rather than an error.
- **Fix**: a `requiredField(data, existing, key, label)` helper that rejects an
  omitted value on create and preserves it on update.
- **Fail-without proof**: breaking the helper fails "required fields are
  enforced ON CREATE for every record type".
- **Same-pattern search**: all six validators; five were affected.
- **Generalizes**: yes — a create/update-shared validator is a recurring shape,
  and the create branch is the one nobody tests.

## F-006 — Agent `config` accepted arrays

- **Phase**: 2c · **Severity**: Medium · **Category**: validation · **Status**: fixed
- **Files**: `src/workspaceAgentSettingsStore.js`
- **Root cause**: `typeof value === 'object'` is true for arrays and `null`.
- **Fix**: `normalizeConfig()` with an explicit array and null rejection.
- **Regression coverage**: `test/workspaceStores.test.js`.

## F-007 — YC API returned correct scores with no items to render

- **Phase**: 4 · **Severity**: High · **Category**: API/UI contract · **Status**: fixed
- **Files**: `src/ycStore.js`
- **Symptom**: the YC tab rendered zero checkboxes while the API returned four
  sections with correct scores and a correct overall.
- **Reproduction**: open the YC tab; compare against `GET .../yc`.
- **Root cause**: `progress.scoreSection` returns a score breakdown and does
  not carry `items` through. The API test asserted section count and overall
  score — both right — and never rendered anything.
- **Fix**: merge the original items back by position (`scored.sections`
  preserves input order).
- **Regression coverage**: strengthened unit assertion plus a browser case that
  asserts every section renders its checklist items. **The browser test is what
  found this**; no API-level test could have.
- **Generalizes**: yes — this is the origin of `PRODUCT_INSIGHTS.md` §1, and
  the reason a browser layer exists at all.

## F-008 — "Fresh clone" verification ran in the original repository

- **Phase**: 7 · **Severity**: Medium · **Category**: verification integrity · **Status**: fixed
- **Discovered by**: re-reading the command transcript before accepting the result
- **Symptom**: a fresh-clone verification reported a clean install and a full
  green suite. The result was invalid.
- **Reproduction**: `git clone <url> /tmp/x && cd /tmp/x && npm ci && npm test`
  where the clone fails on an authentication prompt. The `cd` fails too, the
  shell continues, and every subsequent command runs in the *original* working
  directory — producing exactly the output a successful fresh clone would.
- **Root cause**: commands chained without failing fast, and a verification
  whose entire value is *where* it runs never confirmed where it was running.
- **Fix**: results discarded and the verification redone against a local clone
  of the committed tree, with `git rev-parse HEAD` and `pwd` asserted inside
  the clone before any other command.
- **Regression coverage**: procedural, not automated — the fresh-clone step now
  prints and checks its directory and HEAD first.
- **Remaining risk**: a human still has to look. Mitigated by making the check
  the first output rather than a footnote.
- **Why this is in the record**: it was caught and corrected within the same
  session, before any conclusion depended on it. It stays here anyway. A
  verification method that can silently produce a false pass is a finding about
  the *process*, and deleting it because it was fixed quickly would remove the
  most transferable lesson in this file.
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §12.

## F-009 — Backups captured the outgoing version, not the written one

- **Phase**: 3 · **Severity**: Low · **Category**: persistence · **Status**: fixed
- **Files**: `src/persistence/versionedStore.js`, `src/persistence/backup.js`
- **Symptom**: corruption immediately after a legitimate write could roll back
  further than the operator expects, because the most recently written state
  was never itself backed up.
- **Fix**: back up the version just written.
- **Regression coverage**: `test/integration.test.js` — two sequential writes,
  corrupt the primary, restore, assert the *second* write comes back.
- **Note**: a later PR review found `backup.js`'s header comment still
  described the pre-fix behaviour. The code was already correct; only the
  comment was wrong. Documentation-vs-implementation mismatches are their own
  category and are easy to mistake for behaviour regressions.

---

## R-001 — Tasks and experiments were unreachable by any operator

- **Phase**: independent PR review · **Severity**: High · **Category**: scope completeness · **Status**: fixed
- **Files**: `public/onboard.js`, `test/frontend/featureOnboard.test.js`
- **Symptom**: two of six workspace-owned record types had stores, validation,
  API routes and recovery registration, and no interface. The Experiment
  Builder is a named deliverable (handoff §6.8).
- **Reproduction**: `POST /api/workspaces/:id/experiments` returns 201 and
  persists. Nothing in the Business view can list or create it.
- **Root cause**: the record-store factory made all six types nearly free on
  the backend; the UI was built tab-by-tab and two tabs were never added.
  Nothing compared the two lists, so nothing failed. `pluralOf()` even carried
  dead `task`/`experiment` branches.
- **Fix**: full Tasks and Experiments surfaces — list, create, edit, delete,
  status lifecycle, empty state, error state, workspace scoping. The
  Experiment Builder uses the real backend schema including both success *and*
  failure thresholds.
- **Regression coverage**: a reachability contract that reads the authoritative
  type list from `workspaceRecordsStore.ALL` and creates each type through the
  real dialog against a real server. Not satisfied by a tab existing.
- **Fail-without proofs**:
  - removing the tasks tab → `record type "tasks" has no Business-view tab`
  - removing a type's UI mapping → `no UI mapping for record type "experiments"`
- **Same-pattern search**: extended repo-wide as R-005 (route-to-affordance).
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §8.

## R-002 — No permission review surface existed

- **Phase**: independent PR review · **Severity**: High · **Category**: scope completeness · **Status**: fixed
- **Files**: `public/onboard.js`, `src/featureOnboardApi.js`
- **Symptom**: handoff §9 requires the operator to be able to review agent
  permissions. Nothing rendered a capability, a toggle, or an enforcement
  status. `state.catalog.capabilities` was fetched and never used; the agents
  tab sent only `{enabled}`.
- **Root cause**: the permission *model* was built correctly and the *surface*
  was deferred, while the wizard kept a `permissions` step containing only
  prose — which made the gap read as complete.
- **Fix**: a per-agent review and configuration surface listing all thirteen
  capabilities with their classification, enforcement point and stored value,
  reading entirely from the backend catalog. The onboarding step now lists them
  read-only.
- **Regression coverage**: asserts all thirteen backend keys render, that both
  classifications appear, and that each system control names its code path.
- **Fail-without proof**: rendering only consequential capabilities →
  `expected all 13 capabilities, got 8`.
- **Note**: building this is what exposed R-009.

## R-003 — Three surfaces described a permission UI that did not exist

- **Phase**: independent PR review · **Severity**: Medium · **Category**: documentation · **Status**: fixed
- **Files**: `docs/SECURITY_MODEL.md`, `docs/FEATURE_ONBOARD.md`, `public/onboard.js`
- **Symptom**: `SECURITY_MODEL.md` stated "The workspace agent-settings UI
  presents a permission list" — it presented a checkbox. `FEATURE_ONBOARD.md`
  said capabilities "must be explicitly granted per workspace", describing an
  interaction available only via curl. The product itself told the operator
  that permissions were "recorded preferences that the interface shows".
- **Root cause**: documentation written from the intended design, then the
  surface deferred, then the prose never re-derived from the shipped UI.
- **Fix**: the surface was built (R-002), then every claim was re-derived from
  the finished UI rather than edited to fit.
- **Remaining risk**: doc-vs-UI drift is still detected by review, not by a
  test — except for the permission claims, which the copy contract covers.
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §6.

## R-004 — Onboarding claimed consequential actions "require your approval"

- **Phase**: independent PR review · **Severity**: Medium · **Category**: operator trust · **Status**: fixed
- **Files**: `public/onboard.js`, `src/permissions.js`
- **Symptom**: the first-run wizard told the operator that spending money,
  contacting people and running commands "are off by default and require your
  approval". No approval mechanism exists; an approvals centre is on the README
  roadmap as *not built*.
- **Root cause**: wizard copy written from the design document before it was
  known which capabilities would have enforcement points — then never revisited.
- **Fix**: the step now names what is true, states plainly that there is no
  approval queue, and lists every capability with its real classification.
- **Regression coverage**: a browser contract test checking the onboarding
  step, the agents tab and Settings against a list of forbidden **claims**. It
  deliberately does not ban vocabulary: "not enforced" and "nothing in the
  runtime reads this value" must stay sayable, because they are the honest
  phrasings.
- **Fail-without proof**: reintroducing the sentence → `contains a claim the
  code does not support: /requires? your approval/i`.
- **Same-pattern search**: repo-wide grep for approval, blocked, protected,
  prevented, disabled, enforced, guaranteed across `.js`, `.md`, `.html`,
  `.css`. Findings fed R-003 and R-009.

## R-005 — Routes with no operator affordance

- **Phase**: independent PR review · **Severity**: Low · **Category**: scope completeness · **Status**: fixed
- **Files**: `public/onboard.js`, `test/routeCoverage.test.js`, `docs/FEATURE_ONBOARD.md`
- **Symptom**: `POST .../archive`, `PUT /api/workspaces/:id`, and record `PUT`
  routes existed and were documented, and the frontend never called any of
  them. The selector rendered "(archived)" while the only way into or out of
  that state was curl. A typo in a goal could only be fixed by deleting the
  record.
- **Fix**: archive/unarchive control, workspace edit, and record editing for
  every type whose backend contract allows it (decisions excepted — immutable
  except status, by design).
- **Regression coverage**: `test/routeCoverage.test.js` collects routes from
  the real registration function against a recording stub — not by parsing
  source — and requires every route to be classified `ui` / `api_only` /
  `internal`, every `ui` route to have a real call site in `public/onboard.js`,
  and every `api_only` route to be disclosed in the docs.
- **Fail-without proofs**:
  - removing the archive call site → `routes claimed as operator-reachable with
    no call site: POST /api/workspaces/:workspaceId/archive`
  - adding an unclassified route → `these routes exist but are not classified`
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §10.

## R-006 — One tampered store produced N events and N findings per request

- **Phase**: independent PR review · **Severity**: High · **Category**: integrity / observability · **Status**: fixed
- **Files**: `src/featureOnboardApi.js`, `src/server.js`, `src/runsStore.js`, `src/workspaceRecordsStore.js`
- **Symptom**: measured on a real server — 6 workspaces, one hand edit to
  `workspace_goals.json`, **one** `GET /api/workspaces` produced 6
  `tamper_detected` audit events and 6 `critical` Sentinel findings. A second
  request made it 12. Growth was unbounded across page loads.
- **Reproduction**: create N workspaces and a goal; edit one title in
  `workspace_goals.json`; issue one list request; count
  `workspace_goals.tamper_detected` in `events.jsonl` and
  `store_integrity_failure` in `/api/security/findings`.
- **Root cause**: two individually correct decisions composing badly.
  `versionedStore.read()` is an integrity checkpoint that re-flags a tampered
  store on *every* read and never auto-rebaselines — correct, and safe while
  each store is read about once per request, which was true of every store
  before this feature. `decorateWorkspace` computed progress per workspace,
  inside a loop. Together: N reads of one file per request.
- **Fix**: read the goals store once per request and group by `workspaceId`.
  Sentinel was deliberately **not** changed — deduplicating there would
  suppress a real signal instead of stopping its manufacture.
- **Contract derivation**: the regression test asserts one event for the first
  request and exactly one *more* for a second request, because a tampered store
  re-flagging on a second read is the documented behaviour
  (`PERSISTENCE_AND_RECOVERY.md`). Asserting zero would have been asserting
  that tamper detection stops working.
- **Same-pattern search**: repo-wide for store reads inside per-entity loops.
  Found a second, **pre-existing and worse** instance: `GET /api/agents` called
  `getAgentRuns()` and `workstreamsStore.get()` inside its map — 2N reads of
  `runs.json` (`listForAgent` plus `summarizeForAgent`) and N of
  `workstreams.json`. Measured 8 events for 4 agents. Fixed the same way.
- **Fail-without proofs**: `must emit exactly 1 tamper event, got 5` and
  `must read runs.json once, got 8 events`.
- **Remaining risk**: see R-014.
- **Generalizes**: yes — see `PRODUCT_INSIGHTS.md` §9.

## R-007 — Two date fields unvalidated while a third was

- **Phase**: independent PR review (also raised by Copilot) · **Severity**: Low · **Category**: data contract · **Status**: fixed
- **Files**: `src/errors.js`, `src/workspacesStore.js`, `src/workspaceRecordsStore.js`
- **Symptom / reproduction**:
  ```
  POST /workspaces/:id/goals       {"targetDate":{"evil":true}} -> 201, stored verbatim
  POST /workspaces/:id/assumptions {"reviewDate":[1,2,3]}       -> 201, stored verbatim
  POST /workspaces                 {"targetDate":"not-a-date"}  -> 400  <- control
  ```
  The object rendered to the operator as `[object Object]` (escaped — a data
  contract defect, not a security one).
- **Root cause**: two implementations of one concept. `workspacesStore` had a
  local `validateTargetDate`; the record validators reached for the generic
  optional-value idiom, which type-checks nothing.
- **Fix**: one `errors.optionalDate()` beside `requireString`/`optionalString`,
  used by all three. Deliberately stricter than the contract it replaced,
  because a bare `Date.parse()` check is not a date validator —
  `Date.parse('garbage 2024')`, `Date.parse('5')` and `Date.parse('0')` all
  succeed. The contract is an ISO-8601 calendar date that is also a real date,
  so `2026-02-31` and `2026-13-45` are rejected by shape *and* by parse.
- **Regression coverage**: four store-level cases driven from one table of all
  three fields, plus an API-level case proving a stable `VALIDATION_ERROR`
  rather than a 500 or a silent accept.
- **Fail-without proof**: `goal.targetDate must reject {"evil":true} with a
  stable VALIDATION_ERROR` — after the workspace case passes, which states the
  inconsistency as an assertion.
- **Same-pattern search**: every date-semantics field in every store. These
  three are the complete set; `createdAt`/`updatedAt` are system-generated.

## R-008 — Isolation test overclaimed its coverage and could pass blank

- **Phase**: independent PR review · **Severity**: Low · **Category**: test quality · **Status**: fixed
- **Files**: `test/frontend/featureOnboard.test.js`
- **Symptom**: a case named "every workspace-owned record type stays scoped in
  the UI" looped over three of six types, and asserted only that the other
  workspace's marker was *absent*.
- **Root cause**: written to the intended six-type model, narrowed to what the
  UI could reach, never renamed. The negative-only assertion is the standard
  shape of an isolation test written without asking what a silent-failure
  implementation would do — a renderer that drew nothing passed it.
- **Fix**: enumerates the backend's own type list and asserts both directions
  for every type — each workspace shows its own record and not the other's.
- **Fail-without proofs**:
  - `renderBusinessPanel` returning `''` → `Alpha must render its own goals`
  - workspace filtering removed → `Alpha must NOT render the other workspace's goals`
  The two mutations fail on opposite assertions, which is the property the
  original test lacked.

---

## R-009 — Three capabilities were labelled "enforced" while gating nothing

- **Phase**: this pass (found while building R-002) · **Severity**: High · **Category**: operator trust · **Status**: fixed
- **Files**: `src/permissions.js`, `test/domainModel.test.js`, `docs/*`
- **Symptom**: `spend_money`, `paid_model_calls` and `use_custom_provider`
  carried `enforcement: 'enforced'` with a named enforcement point, and the
  docs said "only three of those have an enforcement point today". This reads
  as "those three toggles do something". They do not.
- **Reproduction**: `grep -rn "permissions\[" src/ workers/` returns nothing.
  `budget.assertWithinBudget()` is called unconditionally in
  `src/agentManager.js` and reads only the configured daily caps.
  `src/workers/custom.js` applies its boundary to every custom run. Neither
  reads a stored permission value. **Zero of thirteen are gated.**
- **Root cause**: the label conflated two different facts — "a control exists
  for this action" and "this setting controls it". They happened to be
  described by one field.
- **Aggravating factor**: a green test was defending the claim.
  `test/domainModel.test.js` asserted `enforcement === 'enforced'` for those
  three and passed. A misleading claim with passing coverage is harder to find
  than one with none.
- **Fix**: the classification now separates the facts —
  `enforcement: 'system_control' | 'recorded_only'`, `enforcementPoint`, and
  `gatedByStoredValue` (false for all thirteen, per-capability so a future real
  gate flips exactly one). A `RUNTIME_ENFORCEMENT_SUMMARY` sentence is shipped
  to the UI and rendered verbatim, so the interface and the docs cannot drift.
- **Regression coverage**: `no capability claims its stored value gates
  anything` is a tripwire — the day someone sets `gatedByStoredValue: true`
  they must produce a call site first. Plus the browser copy contract.
- **Remaining risk**: the tripwire cannot detect a *correct* future gate being
  added without updating the flag. Accepted; the flag is the reminder.
- **Generalizes**: yes — sharpens `PRODUCT_INSIGHTS.md` §2.

## R-010 — An unreadable store rendered as "No workspaces yet"

- **Phase**: this pass (found while writing the error-state test) · **Severity**: Medium · **Category**: error handling · **Status**: fixed
- **Files**: `public/onboard.js`
- **Symptom**: with `workspace_goals.json` corrupt and no valid backup,
  `GET /api/workspaces` returns 503 `STORE_DEGRADED`. `activate()` caught the
  error, logged it to the console, and rendered with `state.workspaces` empty —
  producing **"No workspaces yet. Create your first business workspace to
  begin."** The UI told the operator their data did not exist when it merely
  could not be read.
- **Reproduction**: corrupt `workspace_goals.json`, delete
  `backups/workspace_goals/`, restart, open Business.
- **Root cause**: an error path that degraded into the empty path. The `catch`
  recorded nothing, so the renderer could not distinguish "nothing" from
  "unknown" — the same class of mistake as returning `0` for an unmeasurable
  progress value, which this project already refuses elsewhere.
- **Fix**: load failures set `state.loadError` and render an announced
  (`role="alert"`) banner, checked *before* the empty case so the two can never
  collapse into each other.
- **Regression coverage**: a browser case that corrupts a store beyond recovery
  and asserts the UI shows an error and never the words "No workspaces yet".
- **Remaining risk**: a corrupt goals store still makes the whole workspace
  list unavailable rather than degrading progress alone. Named in Known
  limitations; changing it would mean inventing a new progress state, which is
  a product decision rather than a bug fix.

## R-011 — `requiresApproval()` named a mechanism that does not exist

- **Phase**: this pass · **Severity**: Low · **Category**: dead code / naming · **Status**: fixed
- **Files**: `src/permissions.js`, `test/domainModel.test.js`
- **Symptom**: an exported helper returning `CONSEQUENTIAL_KEYS` membership,
  documented as "what the UI uses to show the right warning". There was no UI,
  no approval workflow, and no caller outside its own test.
- **Fix**: removed rather than renamed — the concept was the misleading part.
  Callers wanting the underlying fact read `consequential`, which claims only
  what it means. The test now asserts the export is `undefined`.
- **Generalizes**: mildly — a function name is a claim, and dead code keeps
  making it.

## R-012 — A dead export crashed the server; the syntax gate did not catch it

- **Phase**: this pass · **Severity**: Low · **Category**: dead code / CI coverage · **Status**: fixed
- **Files**: `src/featureOnboardApi.js`
- **Symptom**: renaming an internal function left `module.exports = { …,
  computeWorkspaceProgress }` referring to a name that no longer existed. The
  server threw `ReferenceError` at module load; every integration test failed
  with "server did not become ready".
- **Root cause**: an export with no consumer anywhere in `src/`, `test/` or
  `public/` — it survived because nothing used it and nothing checked.
- **Fix**: export removed.
- **Worth recording**: `node --check` passed the file. It validates *syntax*,
  not resolvability, so a module-load `ReferenceError` is invisible to the CI
  syntax gate. Only booting a real server caught it — which the integration
  suite does on every run.
- **Remaining risk**: a module never loaded by the integration suite could
  carry the same defect. All current `src/` modules are loaded by
  `src/server.js`, so the boot covers them today.

## R-013 — My own permission-persistence test passed against a broken client

- **Phase**: this pass · **Severity**: Medium · **Category**: test quality · **Status**: fixed
- **Files**: `test/frontend/featureOnboard.test.js`
- **Symptom**: a mutation that made the client POST only the changed permission
  key — which causes the store to refill every other key from
  `defaultPermissionsFor()` — did **not** fail the test written to catch it.
- **Root cause**: the test asserted `read_workspace_data === true` and
  `spend_money === false` after a change. Both of those *are* the defaults, so
  a full default-refill satisfies them. The test asserted values that could not
  distinguish the two implementations.
- **Fix**: grant two capabilities that start off, one after the other, and
  revoke one that starts on. Under a partial post the second write resets the
  first, and the revocation is refilled — both now detected.
- **Fail-without proof**: partial post → `an earlier grant must not be reset by
  a later write`.
- **Why it is in the record**: this is F-003's lesson recurring in a test
  written *by someone who had just written F-003 up*. Running the mutation is
  what caught it; reading the test would not have.
- **Generalizes**: yes — assertions whose expected values coincide with
  defaults are a specific, common form of vacuous test.

## R-014 — Sentinel findings still grow one per request per tampered store

- **Phase**: this pass · **Severity**: Low · **Category**: observability · **Status**: documented (not fixed)
- **Files**: `src/sentinel.js`
- **Symptom**: after R-006, one request against a tampered store produces one
  audit event and one Sentinel finding — correct per the documented per-read
  contract. But repeated page loads against a store the operator has not yet
  recovered still add one finding each, and `security_events.json` has no size
  cap or retention policy.
- **Root cause**: `evaluateIntegrityEvent()` creates a finding unconditionally;
  there is no dedupe by `(store, reason, unresolved)`. This is pre-existing
  behaviour that was unreachable at scale before Feature Onboard, because no
  store was read many times per request.
- **Why not fixed here**: deduplicating findings and capping retention are
  behaviour decisions about an incident surface, not a defect in this feature.
  Getting them wrong suppresses real signal. R-006 removed the amplification,
  which was the part this branch caused.
- **Consequence if left**: an operator who ignores a tamper flag across many
  page loads accumulates duplicate `critical` findings and an growing event
  log. Both are recoverable by performing the recovery the finding asks for.
- **Named in**: `docs/FEATURE_ONBOARD.md` Known limitations.

## R-015 — The date validator accepted impossible dates while claiming not to

- **Phase**: this pass (found in live-runtime verification) · **Severity**: Medium · **Category**: data contract · **Status**: fixed
- **Files**: `src/errors.js`, `test/workspaceStores.test.js`
- **Symptom**: `POST /api/workspaces/:id/goals` with `targetDate: "2026-02-31"`
  returned **201**. The validator's own comment, the commit message that
  introduced it, and `FEATURE_ONBOARD.md` all said impossible calendar dates
  were rejected.
- **Reproduction**: against a real server —
  ```
  {"evil":true}    -> 400
  [1,2]            -> 400
  "garbage 2024"   -> 400
  "2026-02-31"     -> 201   <- should have been 400
  ```
- **Root cause**: `Date.parse` does not reject impossible ISO dates, it
  **rolls them over**. `2026-02-31` → March 3, `2026-04-31` → May 1,
  `2026-02-29` in a non-leap year → March 1. A shape check plus a parse check
  therefore accepts the string and stores a value meaning a *different day*
  than the one written. This is the second distinct way `Date.parse` is the
  wrong tool for this job, after the too-permissive-shape problem R-007 fixed.
- **Why the R-007 tests missed it**: they tried `2026-13-45`, where the *month*
  is out of range, so `Date.parse` genuinely fails. Every invalid case in that
  set failed for a reason other than the day-of-month rollover. The test suite
  proved the validator rejected malformed strings; it never proved the
  validator understood the calendar.
- **Fix**: a round-trip check — build the date in UTC from the captured Y/M/D
  and require `getUTCFullYear/Month/Date` to come back unchanged. A rollover
  changes the day or the month, so this catches every impossible date without
  maintaining a leap-year table.
- **Regression coverage**: `2026-02-31`, `2026-04-31`, `2026-06-31` and
  `2026-02-29` added to the rejection table; `2024-02-29` (a real leap day) and
  `2026-12-31` added to the acceptance table, so the fix cannot be satisfied by
  rejecting unusual-but-valid dates.
- **Same-pattern search**: all three date fields share one validator, so one
  fix covers them. No other field parses a date string.
- **How it was found**: not by any test — by driving the real API from a fresh
  clone during the final verification pass and reading the status codes against
  what the documentation claimed. This is the case for keeping a live-runtime
  step even when the suite is green.

## R-016 — The route-to-affordance contract passed a route with no affordance

- **Phase**: this pass (final adversarial review of my own diff) · **Severity**: Low · **Category**: test quality · **Status**: fixed
- **Files**: `test/routeCoverage.test.js`, `public/onboard.js`, `docs/FEATURE_ONBOARD.md`
- **Symptom**: `DELETE /api/workspaces/:workspaceId/decisions/:id` was
  classified as operator-reachable and the contract passed. Nothing in the UI
  renders a delete control for decisions.
- **Reproduction**: `grep -c 'data-fo-del="decision"' public/onboard.js` → 0,
  while the route was marked `ui` and the test was green.
- **Root cause**: the contract looked for the string `pluralOf(type)` — the
  SHARED delegated handler that builds the path for all six record types. That
  string is present as soon as any one type renders any one control, so it
  marked all 24 mutation routes reachable on the strength of a single
  affordance existing somewhere. A contract written to catch coarse claims was
  itself making a coarse claim.
- **Fix**: mutation routes are now checked against the PER-TYPE marker each
  renderer emits (`data-fo-del="task"`, `data-fo-edit="goal"`,
  `statusSelect('decision'`), with an `anyOf` for affordances that can
  legitimately take more than one shape. List and create remain proven by the
  browser reachability contract, which drives the real dialog — a stronger
  check than a substring — and the two tests now cross-reference each other so
  neither is assumed to cover the other's ground.
- **Second defect the fix exposed**: decisions rendered their status `<select>`
  inline with a duplicated copy of the status vocabulary rather than through
  the shared `statusSelect()` helper. Unified.
- **Product decision recorded, not silently absent**: decisions deliberately
  have no delete control, because deleting one destroys the revision trail the
  immutability rule exists to preserve. That is now an `api_only`
  classification with a written reason and a row in the docs, rather than an
  unexplained gap.
- **Fail-without proof**: removing `data-fo-del="task"` →
  `DELETE /api/workspaces/:workspaceId/tasks/:id (expected public/onboard.js to
  contain one of ["data-fo-del=\"task\""])`. The coarse version passed that
  same mutation.
- **Why it is in the record**: the third time in this branch that a test
  written to catch a class of defect contained that defect (after F-003 and
  R-013). The common thread is that writing the test is not the check —
  running the mutation is.

## A-001 — A superseded load painted another workspace's records over the current one

- **Phase**: hostile review · **Severity**: High · **Category**: workspace isolation / state desynchronization · **Status**: fixed
- **Files**: `public/onboard.js` (`loadActiveWorkspaceDetail`)
- **Symptom**: with one workspace's fetch delayed, selecting A then immediately
  B left the selector reading **Beta** while the panel rendered **Alpha's**
  records.
- **Reproduction**: delay `GET /api/workspaces/<A>/goals` by 1500ms; select A,
  wait 100ms, select B, wait for A's load to land. Confirmed:
  `selectorSays: Beta, panelShowsAlpha: true, panelShowsBeta: false`.
- **Root cause**: `loadActiveWorkspaceDetail()` captured the workspace id at
  entry but assigned to shared state **unconditionally** on resolve. No
  generation token, no cancellation. A slower earlier load overwrote a faster
  later one, and the losing path did not re-render the selector.
- **Why the tests missed it**: every isolation case waits for the correct data
  before asserting, so a late-landing stale load is unobservable by
  construction. Replacing sleeps with condition waits in an earlier commit made
  this blind spot *worse* — a sleep at least sampled an arbitrary moment.
- **Fix**: a monotonic `detailLoadToken`; on resolve, discard if a newer load
  started or the active workspace changed. The `catch` branch is guarded too,
  so a slow 503 for an abandoned workspace cannot blank the current one.
- **Fail-without proof**: the new regression case fails against the pre-fix code
  with "a superseded load must never paint another workspace's records over the
  current one".
- **Same-pattern search**: the YC PUT handler assigns `state.yc` directly on a
  single mutation — same class, much narrower window, not currently reachable
  as a cross-workspace leak. Noted, not fixed.
- **Generalizes**: yes — shared mutable state plus unsequenced async loads. The
  client has no concurrency model at all, which is the real gap.

## A-002 — Concurrent permission edits silently revert each other

- **Phase**: hostile review · **Severity**: High · **Category**: lost update · **Status**: **deferred by decision** (superseded by Phase 9)
- **Files**: `public/onboard.js` (permission change handler), `src/workspaceAgentSettingsStore.js`
- **Reproduction** (agents refetch delayed 900ms, two clicks 120ms apart):
  ```
  PUT #1 {... edit_files:TRUE,  run_commands:false ...}
  PUT #2 {... edit_files:FALSE, run_commands:TRUE  ...}   <- reverted #1
  final: edit_files=false, run_commands=true
  ```
  A second run with different timing lost **both** grants. Nondeterministic.
  The UI then agrees with the wrong result, so no error is visible.
- **Root cause**: introduced by the R-013 fix. Sending the whole resolved map
  avoids the store's default-refill, and creates a read-modify-write race
  because `next` is computed from client state that refreshes only after the
  handler's own `await`. The API shares the flaw: two concurrent PUTs with
  disjoint maps are last-write-wins. Full replace, no merge, no version.
- **Dangerous direction**: a *revocation* is undone the same way.
- **Why the tests missed it**: the permission test clicks, waits for
  completion, then clicks again — written that way specifically to defeat the
  partial-post mutation, which guaranteed it could never exercise concurrency.
- **Why not fixed**: Phase 9 replaces this model with capability grants as
  versioned transactions (previous version, requested version, reviewer,
  timestamp, audit entry), which removes the race by construction. Patching the
  checkbox path would be discarded work. Deferred deliberately, with the
  consequence stated in Known Limitations rather than left implicit.
- **When it is fixed**, the regression test is: two toggles without awaiting the
  first, assert both land; plus a store test that a partial upsert preserves
  unmentioned keys of an existing row.

## A-003 — A `corrupt_no_backup` store cannot be repaired through the product

- **Phase**: hostile review · **Severity**: High · **Category**: broken recovery · **Status**: documented (pre-existing)
- **Files**: `src/persistence/versionedStore.js`, `src/server.js` (`sendError`)
- **Reproduction**: corrupt a store, delete its backups, restart.
  ```
  degraded: reason "corrupt_no_backup"
  restore_backup -> 500 INTERNAL_ERROR
  accept_current -> 500 INTERNAL_ERROR
  still degraded
  ```
- **Root cause**: `restore_backup` throws a plain `Error` when no valid backup
  exists; `accept_current` calls `JSON.parse` on the malformed content without a
  guard. `sendError` maps `entity.parse.failed` but nothing else, so both become
  an opaque 500. The Security view exposes both as buttons.
- **Second defect, same path**: `accept_current` performs no shape validation —
  `{"schemaVersion":1,"records":"not-an-array"}` returns 200 and is recorded as
  the new known-good baseline.
- **Why the tests missed it**: the existing `accept_current` case tampers a
  store while keeping it valid JSON. The Feature Onboard recovery test calls
  `restore_backup` on **healthy** stores and asserts 200 — it verifies routing
  while its name implies repair. My own new browser case *creates* this exact
  state and asserts the UI errors, then never attempts recovery.
- **Recommended fix**: `AppError(STORE_DEGRADED, …, 409)` instead of a bare
  `Error`; wrap the parse and validate with `isValidEnvelope` before blessing;
  add `entity.too.large` and a generic non-`AppError` mapping to `sendError`.
- **Why not fixed now**: pre-existing, edge case (corrupt *and* no valid
  backup), and the bytes are preserved on disk and repairable by hand. Accepted
  for an internal single-operator release with the claim corrected.

## A-004 — Oversized request bodies return 500 instead of a documented error

- **Phase**: hostile review · **Severity**: Medium · **Category**: API contract · **Status**: documented (pre-existing)
- **Files**: `src/server.js` (`express.json()`, `sendError`)
- **Reproduction**: a 2MB `description`, or 5000 milestones → `500
  INTERNAL_ERROR`. Default 100kb limit → `entity.too.large` → unmapped.
- **Note**: `sendError` special-cases `entity.parse.failed` immediately above,
  which makes the omission conspicuous. `src/errors.js` opens by stating every
  user-facing error is a stable code. Record string fields also have no length
  bound.
- **Fix**: one line in `sendError`, an explicit `express.json({ limit })`, and a
  field length cap.

## A-005 — A dead export was added in the branch that removed one

- **Phase**: hostile review · **Severity**: Low · **Category**: dead code · **Status**: fixed
- **File**: `src/workspaceRecordsStore.js`
- `listAll()` had zero callers anywhere; only `groupByWorkspace()` is used. R-012
  in this same file removed a dead export and drew the lesson that they hide
  until they break the build — and then this branch added another, with a
  comment justifying a use case that did not exist. Removed.

## A-006 — O(n*m) rendering in the two new tabs

- **Phase**: hostile review · **Severity**: Low · **Category**: performance · **Status**: documented
- **File**: `public/onboard.js` — `goals.find()` per task, `assumptions.find()`
  per experiment, i.e. `find()` inside `map()`, re-run on every re-render.
  Irrelevant at realistic counts. Fix is a `Map` built once per render.

## A-007 — Only one of the two UI error paths was covered

- **Phase**: mutation sweep · **Severity**: Medium · **Category**: test blind spot · **Status**: fixed
- **Files**: `public/onboard.js`, `test/frontend/featureOnboard.test.js`
- **Found by**: a 20-mutation sweep. Deleting `state.loadError = err.message`
  from `loadActiveWorkspaceDetail()`'s catch left the entire suite green — the
  only survivor of 20.
- **Root cause of the gap**: there are two distinct failure paths. The existing
  case corrupted `workspace_goals.json`, which `GET /api/workspaces` itself
  reads, so the workspace LIST failed and `activate()`'s catch handled it. The
  detail-load catch was never reached by any test. The mutation removed the
  uncovered one.
- **The uncovered scenario is real**: corrupt a record store the list does not
  read (decisions, tasks, assumptions, experiments, evidence). The list
  succeeds, the workspace renders, and only the detail load fails — which
  previously would have rendered as an empty tab rather than an error.
- **Fix**: a second case corrupting `workspace_decisions.json`, which first
  asserts the list still returns 200 and the record route returns 503 — so it
  cannot silently degenerate into a duplicate of the other path — then asserts
  the error banner appears and neither "No decisions logged" nor "No workspaces
  yet" is rendered. The two cases are now named for the path each covers.
- **Fail-without proof**: with the assignment removed the new case fails; the
  suite goes 41 -> 40 passed, 1 failed.
- **Generalizes**: yes — two code paths that produce the same *symptom* need two
  tests. Coverage of the symptom is not coverage of the paths.

## A-008 — The browser harness leaks a Chromium process when killed

- **Phase**: mutation sweep · **Severity**: Low · **Category**: process hygiene · **Status**: documented
- **File**: `test/frontend/harness.js` / the suite's `check()` wrapper
- **Symptom**: after a sweep run was terminated by a timeout, a headless
  Chromium (and a `/tmp/rucker-fe-*` directory) survived. The resulting CPU
  contention produced **false failures** in two subsequent runs — a different
  test each time, which is the signature of environment rather than defect.
  Both runs went green immediately after killing the orphan.
- **Root cause**: `check()` closes the browser and removes the data directory in
  a `finally`, which covers a normal assertion failure but not process
  termination. Exactly the F-001 shape, one level up: cleanup registered for
  exceptions but not for signals.
- **Why documented rather than fixed**: this affects the test harness under
  abnormal termination, not the product, and the correct fix (signal handlers
  tracking live browsers) is the same change F-001 made for temp directories.
  Recorded so the next flake investigation starts by checking for orphans.
- **Diagnostic worth keeping**: two consecutive runs failing on *different*
  tests is evidence of environment, not of either test. Confirmed by cleaning
  up and re-running twice: 41/41 both times.

---

## Patterns that recur across these findings

Stated once here rather than repeated in every entry.

1. **A green test can defend a wrong claim.** F-003, R-009 and R-013 all had
   passing coverage while being wrong. Running a mutation is the only thing
   that distinguishes a test from a decoration.
2. **Assertions that match the default prove nothing.** R-013 specifically.
3. **The create branch of a shared create/update validator is the untested
   one.** F-005.
4. **Two implementations of one concept diverge.** F-005, R-007, R-003.
5. **An error path that falls through to the empty path lies to the
   operator.** R-010, and the same reasoning behind `null`-not-`0` progress.
6. **A route is not a capability.** R-001, R-002, R-005.
7. **Correct components can compose into an incorrect system.** R-006 — both
   halves were individually right.
8. **A verification's own environment needs verifying.** F-008.
9. **A test suite that is entirely sequential cannot observe a race.** A-001
   and A-002 both required deliberately induced concurrency. Every layer here
   is sequential, and making the browser suite *more* deterministic made it
   *less* able to see these. This is the largest known gap in the strategy.
10. **Fixing one defect can create another of a different family.** A-002 was
   introduced by the fix for R-013. The correct move was not a better patch but
   a different contract — which is what Phase 9 supplies.
11. **A mutation that silently fails to apply is a fake proof.** The sweep
   verifies each edit actually changed the file before running anything; two
   earlier hand-run "proofs" in this project had not been checked that way.
12. **Two code paths with the same symptom need two tests.** A-007: covering
   "the UI shows an error" once left the second path that produces it entirely
   unguarded.
13. **Consecutive runs failing on DIFFERENT tests means environment, not
   defect.** A-008. Check for orphaned processes before touching code.
