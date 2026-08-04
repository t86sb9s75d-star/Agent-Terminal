# Product insights

Generalized engineering patterns observed while building Rucker Park. Each was
triggered by a real defect in this repository — the evidence is in
`docs/ENGINEERING_FINDINGS.md` — but each is written here in a form that does
not depend on this codebase.

> **These are hypotheses, not validated market claims.** One repository is one
> data point. A defect recurring here is evidence that a pattern is *possible*,
> not that anyone would pay to prevent it. Every entry below carries an
> explicit **no-build-until-validated** status and a statement of what would
> disprove it, because the failure mode for a document like this is producing
> confident-sounding opportunities out of internal frustration.
>
> Nothing here contains credentials, personal data, private identifiers,
> machine details, or exploit instructions.

Each entry has the same eleven fields, so they can be compared rather than
admired:

**Observed incident · Generalized pattern · Who feels it · Consequence ·
Existing workaround · Why the workaround is weak · Product hypothesis ·
What would disprove it · Outside evidence still needed · Status ·
Cheapest next validation**

---

## 1. API tests pass while the browser contract is broken

**Observed incident.** (F-007) A YC checklist endpoint returned four sections
with correct scores and a correct overall. The API test asserted section count
and overall score — both right. A scoring helper had dropped each section's
`items` array, so the UI had nothing to draw. The tab was empty. Only a browser
test caught it.

**Generalized pattern.** A server returns a structurally valid response the
consumer cannot use. Tests assert on the fields they happen to check and stay
green, because they never render anything.

**Who feels it.** Teams with a separate frontend and backend in one repository
and thin or no end-to-end coverage.

**Consequence.** A shipped feature that looks healthy on every dashboard and is
visibly broken to the user. Usually caught by manual QA, at the cost of a
round trip.

**Existing workaround.** Consumer-driven contract testing (Pact and similar),
or end-to-end tests.

**Why it is weak.** Contract tooling validates *schema conformance* — does the
field exist, is it the right type — rather than *sufficiency*: is this enough
for the consumer to do its job. A field legitimately absent looks identical to
one accidentally dropped. End-to-end suites are the real answer and are
expensive enough that many teams skip them.

**Product hypothesis.** A checker that derives the required response shape from
what the frontend actually *reads* — closer to "which fields does this
component touch" than to OpenAPI validation — and fails when the server stops
providing one.

**What would disprove it.** Finding that existing consumer-driven contract
tooling already covers sufficiency adequately for single-repo frontends; or
that teams who hit this simply add one end-to-end test and never hit it again,
making a dedicated tool unnecessary.

**Outside evidence still needed.** How often API-green/UI-broken regressions
reach production. Whether teams recognise this as a distinct category or just
as "we needed E2E tests".

**Status.** No build until validated.

**Cheapest next validation.** Read post-incident write-ups from teams with
public engineering blogs and count how many trace to this shape. Zero cost.

---

## 2. Permission interfaces that overstate what a toggle does

**Observed incident.** (R-002, R-004, R-009) A thirteen-capability agent
permission model. Three capabilities were labelled `enforced` with a named
enforcement point. Reading every call site showed that **no** stored value was
consulted by the runtime — the two real controls (spending caps, a
custom-provider boundary) run unconditionally and never read the settings. The
UI, meanwhile, did not render the capabilities at all, while three documents
said it did, and the first-run wizard told the operator that consequential
actions "require your approval" when no approval mechanism existed.

**Generalized pattern.** A settings screen lists consequential capabilities and
the operator reasonably concludes the toggles do something. Enforcement lives
in scattered runtime checks; the list lives in UI configuration; nothing links
them. The gap widens silently, and the *documentation* tends to describe the
intent rather than the code.

**Who feels it.** Anyone shipping an agent or automation platform with
consequential capabilities — especially where a permission screen is shown to a
customer, an auditor, or a security reviewer as evidence of control.

**Consequence.** An operator makes a safety decision based on a control that
does not exist. Where the screen backs a compliance claim, the claim is false.

**Existing workaround.** Code review, and a convention of not using words like
"blocked" without justification.

**Why it is weak.** It relies on a reviewer holding the whole system in their
head at the moment the copy is written. In this repository it failed three
times in one feature, including once with a passing test defending the wrong
claim.

**Product hypothesis.** A permission registry where each capability must
declare its enforcement point, plus a check that fails when a capability marked
enforced has no reachable code path referencing it — and a linked copy rule so
UI text cannot claim more than the registry does.

**What would disprove it.** Finding that in most products the permission list
and the enforcement checks are already generated from one source (a policy
engine, a framework's authorization layer), making drift structurally
impossible; or that teams hit this only during early prototyping, when nobody
would buy a tool.

**Outside evidence still needed.** Whether teams building agent platforms
actually ship permission UIs ahead of enforcement, or whether this is specific
to fast-moving AI products where the interface outruns the backend.

**Status.** No build until validated. **Highest-conviction entry here**, on the
strength of it recurring three times in one feature — which is still one
repository.

**Cheapest next validation.** Audit the permission screens of three or four
publicly available agent products against their own documentation and look for
the same gap. Low cost, no interviews needed.

---

## 3. AI cost accounting that hides default-model spend

**Observed incident.** Agents left without an explicit model ran against a real
provider default and were recorded with `model: null`, `costUsd: null`. Daily
spending caps compared against the sum of *priceable* runs, so ordinary
default-model spend counted as zero against the caps.

**Generalized pattern.** A parameter defaulted in the execution layer and read
raw in the accounting layer. Both layers are individually correct; the bug is
that they independently decide the same fact.

**Who feels it.** Teams with per-customer or per-agent AI spend limits.

**Consequence.** Direct financial: real billable usage escapes a control
intended to bound it. Where the cap is a contractual commitment, a breach that
the system reports as compliant.

**Existing workaround.** Reconciling against the provider's own billing.

**Why it is weak.** Reconciliation is after the fact and periodic; a cap is
supposed to act before spend happens.

**Product hypothesis.** A "resolved-parameters" audit for LLM applications:
flag any parameter defaulted in one layer and read raw in another, especially
where the second feeds billing or a budget control.

**What would disprove it.** Finding that mainstream SDKs already resolve
defaults server-side and return the effective model in the response, so the
application layer never has the chance to disagree with itself. This is
plausible and would remove most of the surface.

**Outside evidence still needed.** How common blank-model defaults are in
production LLM apps, and how many of those also implement spend caps.

**Status.** No build until validated. Check the SDK-return-value question
first — it could close this entirely.

**Cheapest next validation.** Read the response schemas of the two or three
major provider SDKs and check whether the effective model is always returned.
An afternoon.

---

## 4. Recovery systems that do not cover newly added stores

**Observed incident.** Eleven new persistence stores were added to a system
with a solid corruption/tamper recovery mechanism. They were correctly
registered — but nothing *proved* it, so a documentation claim was stronger
than its evidence until a test was added that asserts every store is reachable
through the recovery endpoint and fails when one is removed.

**Generalized pattern.** A lifecycle registry (recovery, backup, migration,
health check) is hand-maintained data. Omission is not a compile error and not
a runtime error. It surfaces during an incident.

**Who feels it.** Anyone with hand-maintained lifecycle registries — most
systems that grew organically.

**Consequence.** Low day-to-day, very high at exactly the wrong moment: the one
store an operator cannot repair, discovered while trying to repair it.

**Existing workaround.** A checklist, or remembering.

**Why it is weak.** Both fail silently and neither leaves a trace.

**Product hypothesis.** Less a product than a test pattern worth naming:
enumerate the implementations of an interface and assert each is present in
every lifecycle map. Cheap to write, almost never written.

**What would disprove it.** It is largely disproven as a *product* already —
this is a five-line test, not something anyone would buy. It stays here as a
pattern, and the honest conclusion is that its value is in being *named*, not
sold.

**Outside evidence still needed.** None worth gathering for a build decision.

**Status.** No build. Retained as a practice, not an opportunity.

**Cheapest next validation.** Not applicable — write the test, do not build the
product.

---

## 5. Tests that cannot fail

**Observed incident.** (F-003, and then R-013) An attribute-escaping browser
test placed a quote-breaking payload in a record's *title*. Titles render in
text context; nothing operator-controlled reached an attribute at all, so the
test passed with attribute escaping entirely disabled. Later, in the same
project and after that lesson had been written up, a permission-persistence
test asserted values that happened to equal the defaults — so a client posting
only the changed key, which silently resets everything else, still passed it.

**Generalized pattern.** A test written for a real risk, passing, counted as
coverage, and structurally unable to exercise what it names. Coverage tools
count it. It protects nothing.

**Who feels it.** Everyone; acutely, teams whose test suite is a compliance
artifact.

**Consequence.** False confidence, discovered late — usually by the incident
the test was supposed to prevent.

**Existing workaround.** Mutation testing.

**Why it is weak.** Whole-codebase mutation testing is slow enough that most
teams try it once and abandon it. Coverage percentage, the metric teams
actually track, cannot distinguish a vacuous test from a strong one.

**Product hypothesis.** Mutation testing scoped only to security- and
correctness-critical functions — escaping, authorization, scoping filters,
validators — rather than the whole codebase. Fast enough to run per-PR.

**What would disprove it.** Finding that existing mutation tools already
support targeted scoping well enough and adoption is limited by something else
entirely (setup cost, language support, CI minutes) — in which case the
bottleneck is not what this hypothesis assumes.

**Outside evidence still needed.** What fraction of security-relevant tests in
real repositories survive mutation of the function they nominally protect. That
number is the entire case, and it is measurable without talking to anyone.

**Status.** No build until validated.

**Cheapest next validation.** Run an existing mutation tool against the
escaping and authorization functions of five open-source projects and count
survivors.

---

## 6. Documentation drifting upward in confidence

**Observed incident.** (R-003) Documentation described a permission interface
that did not exist, in three places, including a security document. Separately,
workspace separation had to be repeatedly re-qualified as organizational rather
than tenant isolation, because the shorter word was always the tempting one.

**Generalized pattern.** Words like "isolated", "protected", "validated",
"enforced", "secure" get added when a feature feels finished, and are never
re-checked against what the code does. Documentation is written from intent,
and intent is usually ahead of implementation.

**Who feels it.** Regulated or safety-adjacent teams whose docs become external
commitments; anyone whose README is read by a buyer.

**Consequence.** A reader makes a deployment or purchasing decision on a
guarantee that does not exist.

**Existing workaround.** Documentation review by someone who knows the code.

**Why it is weak.** Strong words read as *reassuring* rather than as *claims
requiring evidence*, so a reviewer skims past exactly the sentences that need
checking.

**Product hypothesis.** A documentation lint over a fixed vocabulary of strong
claims, requiring each occurrence to cite a test or code path — "claims need
citations" for engineering docs.

**What would disprove it.** A false-positive rate high enough that teams
disable it within a week. This is the likeliest outcome and should be tested
before anything is built. Prose is not code, and a linter that cries wolf on
every "secure" gets removed.

**Outside evidence still needed.** Whether teams tolerate the friction, and
whether the rule can be tuned narrowly enough to survive.

**Status.** No build until validated.

**Cheapest next validation.** Run the vocabulary list over the docs of a few
projects and hand-classify hits as real overclaims or noise. If noise
dominates, the hypothesis is dead cheaply.

---

## 7. Progress indicators invented rather than derived

**Observed incident.** Two deliberate refusals: workstream progress is always
`null` because no planned-work baseline exists, and workspace progress returns
`null` — not `0` — when there are no milestones. A test proves the code does
not collapse them.

**Generalized pattern.** A UI needs a progress number. No real baseline exists,
so a plausible proxy is substituted — a success ratio, a count of created
items, a stage index — and displayed under the label "progress".

**Who feels it.** Teams shipping analytics surfaces quickly, especially
AI-generated ones, which overproduce confident-looking dashboards.

**Consequence.** Users make decisions on a number that measures something else.
Reputational rather than technical: trust does not recover well from a metric
discovered to be fabricated.

**Existing workaround.** Design review.

**Why it is weak.** It is not a bug in any test's eyes. The number renders, the
arithmetic is correct. Only domain reasoning reveals it answers the wrong
question.

**Product hypothesis.** A design rule rather than a product: every displayed
metric names its denominator, and a metric without one renders as unavailable
rather than zero. Plausibly a review-checklist item for AI-generated
applications.

**What would disprove it.** Evidence that users do not notice or do not care —
which would make this an aesthetic preference rather than a trust issue.
Genuinely unknown, and the entry is weak without it.

**Outside evidence still needed.** Whether users actually lose trust in a
product after discovering a fabricated metric, or simply never find out.

**Status.** No build. Retained as a design rule.

**Cheapest next validation.** None cheap and honest. This is the entry with the
least evidence behind it and should be treated accordingly.

---

## 8. Backend capability with no operator affordance

**Observed incident.** (R-001, R-002, R-005) Two of six record types, the
entire per-agent permission model, workspace archive, workspace edit and record
editing all had stores, validation, API routes and recovery registration — and
no interface. Every one was documented as a delivered capability. `curl` could
reach all of them; an operator could reach none.

**Generalized pattern.** API-first development produces routes faster than
surfaces. Route lists, documentation and roadmaps all track the API, so the
gap is invisible from every artifact a team looks at. A route existing gets
mistaken for a capability delivered — including by the people who wrote it.

**Who feels it.** Teams where the same people write both layers under time
pressure, and any team whose "done" definition is satisfied by a passing API
test.

**Consequence.** Shipped-and-invisible features: work paid for, documented as
available, never used. Users conclude the product cannot do something it can.

**Existing workaround.** Manual QA, or a designer noticing.

**Why it is weak.** Both are people-dependent and neither runs in CI. Nothing
in a normal test suite compares the route table to the interface, because they
are usually tested by different suites with no shared list.

**Product hypothesis.** A route-to-affordance coverage check: enumerate
registered routes, require each to be classified as user-reachable or
deliberately API-only, and verify that "user-reachable" ones have a real client
call site.

**What would disprove it.** Finding that typed API clients already make this
visible — an unused generated client method is dead code a linter can see — in
which case the tooling exists and the gap is only in untyped codebases.
Worth checking before anything else, because it might already be solved for
most teams.

**Outside evidence still needed.** How often shipped routes go unreferenced by
any client in real codebases. Measurable on open-source repositories without
asking anyone.

**Status.** No build until validated. The typed-client question comes first.

**Cheapest next validation.** Script the check against several open-source
full-stack repositories and count orphaned routes. If the number is near zero,
this entry is over.

---

## 9. Repeated integrity checks amplifying incident noise

**Observed incident.** (R-006) Every store read performed an integrity check
that emitted an audit event and created a security finding when the file had
been tampered with — correct, and safe while each store was read about once per
request. A new list endpoint computed a per-entity value inside a loop. One
hand edit to one file then produced N critical findings per page load, growing
without bound. A second, older instance did the same thing 2N times.

**Generalized pattern.** A per-read side effect that is proportionate at one
call rate becomes noise at another. Neither the checkpoint nor the loop is
wrong; the composition is. The amplification appears only when the rare
condition (tampering, degradation, an error state) actually occurs — so it is
absent from every normal test run.

**Who feels it.** Anyone whose data layer emits telemetry, audit events or
alerts per operation — increasingly common as audit logging becomes a
compliance requirement.

**Consequence.** The incident surface is loudest exactly when it needs to be
readable. Duplicate criticals bury the single real event; append-only logs grow
during the incident.

**Existing workaround.** Alert deduplication downstream.

**Why it is weak.** It suppresses the symptom and leaves the cause: the events
are still generated, still written, still stored. It also risks deduplicating
genuinely distinct events.

**Product hypothesis.** A lint or trace-based check that flags a side-effecting
read inside a per-entity loop within one request — the N+1 detector that
existing tools already do for queries, extended to *emissions* rather than
latency.

**What would disprove it.** Finding that existing APM N+1 detection already
catches these, since the repeated read shows up as repeated I/O whether or not
anyone notices the event amplification. Plausible — the detection may exist and
only the framing is new, which is not a product.

**Outside evidence still needed.** Whether teams experience event-storm
incidents traceable to this shape, distinct from ordinary N+1 latency.

**Status.** No build until validated.

**Cheapest next validation.** Check whether mainstream APM N+1 detectors would
have flagged the two instances in this repository. If yes, the tool exists.

---

## 10. Tests whose names overclaim their coverage

**Observed incident.** (R-008) A case named "every workspace-owned record type
stays scoped in the UI" covered three of six types and asserted only absence,
so a renderer drawing nothing passed it. The name became the summary everyone
trusted, including in a verification matrix.

**Generalized pattern.** A test name is a claim, and it is the claim people
read when deciding whether something is covered. Names are written when a test
is created and rarely revisited when its body narrows.

**Who feels it.** Teams that use test names as coverage evidence — anyone with
a traceability matrix mapping requirements to test names.

**Consequence.** A coverage claim stronger than the coverage. Compounding,
because the name gets copied into documents that are then trusted.

**Existing workaround.** Review.

**Why it is weak.** Reviewers read the name and the diff of the body, not the
gap between them.

**Product hypothesis.** Weak. Possibly a check that a test naming a set
("every", "all", "each") iterates a list of that size derived from source.
Narrow and easy to fool.

**What would disprove it.** That the check is too easily satisfied by
restructuring, or fires mostly on tests that are fine. Both likely.

**Outside evidence still needed.** Whether name-vs-body drift causes real
downstream harm, or is just untidy.

**Status.** No build. Weakest product case in this document; retained because
the *practice* — enumerate from an authoritative list rather than a literal —
is what actually fixed it here.

**Cheapest next validation.** Not worth running.

---

## 11. A verification's own environment needs verifying

**Observed incident.** (F-008) A fresh-clone verification reported a clean
install and a fully green suite. The clone had failed on an authentication
prompt, the subsequent `cd` failed too, the shell continued, and every command
ran in the original repository — producing exactly the output a successful
fresh clone would produce. Caught by re-reading the transcript rather than by
anything failing.

**Generalized pattern.** A verification whose entire value is *where* it runs,
that never confirms where it ran. Chained shell commands continue past a failed
`cd`; the output is indistinguishable from success; and the failure mode is a
false pass, which is the worst kind.

**Who feels it.** Anyone running reproducibility, clean-room, fresh-install or
air-gapped verification — and every agent or script doing it unattended, where
no human reads the intermediate output at all.

**Consequence.** A false pass on precisely the check meant to catch
environment-dependent breakage. Worse than not running it, because it
manufactures confidence.

**Existing workaround.** `set -e`, `set -o pipefail`, `&&` chaining.

**Why it is weak.** They are conventions people forget under time pressure, and
they do not address the deeper issue: the check never asserts its own
preconditions. `set -e` would have helped here; a directory assertion would
have been decisive.

**Product hypothesis.** Barely a product — a discipline: any verification that
depends on its environment must assert that environment (path, HEAD, absence of
prior state) as its first output, not as a footnote. Possibly a small harness
for CI that pins and prints the facts a result depends on.

**What would disprove it.** That `set -euo pipefail` plus normal CI isolation
already covers it in practice for anyone competent, making this a story about
one careless session rather than a pattern.

**Outside evidence still needed.** How often unattended verification produces
false passes through environment confusion. Increasingly relevant as more
verification is run by agents with no human watching the intermediate output —
which is the one genuinely new thing about this entry.

**Status.** No build until validated. Kept because the agent-run angle is the
only part of this document that is arguably new rather than merely observed.

**Cheapest next validation.** Ask a handful of people running automated
verification whether they have seen a false pass from a wrong working
directory. Conversational, no build.
