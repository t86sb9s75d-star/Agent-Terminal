# Product insights

Generalized engineering lessons collected while building Rucker Park. Each was
triggered by a real defect found in this repository, but the pattern is written
here in a form that does not depend on this codebase.

**These are hypotheses, not validated market claims.** Every one would need
outside evidence before anyone spent money on it. Nothing here contains
credentials, personal data, private identifiers, or exploit instructions.

---

## 1. API tests pass while the browser contract is broken

**Problem pattern.** A server endpoint returns a structurally valid response
that the frontend cannot actually use. Integration tests assert on the fields
they happen to check (a count, a total) and stay green, because they never
render anything.

**Concrete instance.** A YC checklist endpoint returned its four sections with
correct scores, and the API test asserted section count and overall score — both
right. But the per-section *items* array had been dropped by a scoring helper,
so the UI had nothing to draw. The API test passed; the tab was empty. Only a
browser test caught it.

**Why current tools miss it.** Contract testing usually validates *schema
conformance* (does the field exist, is it the right type) rather than *sufficiency*
(is this enough for the consumer to do its job). A field that is legitimately
absent looks identical to a field that was accidentally dropped.

**Possible product.** A consumer-driven contract checker that derives the
required response shape from what the frontend actually reads, and fails when
the server stops providing it — closer to "which fields does this component
touch" than to OpenAPI validation.

**Evidence needed.** How often teams ship API-green/UI-broken regressions; and
whether existing consumer-driven contract tooling already covers this in
practice for single-repo frontends.

**Potential buyer.** Teams with a separate frontend and backend in one repo and
no end-to-end coverage.

**Urgency.** Low–moderate. Painful but usually caught by manual QA.

---

## 2. Permission interfaces that overstate enforcement

**Problem pattern.** A settings screen lists capabilities with toggles —
"spend money", "run commands", "contact people" — and the operator reasonably
concludes those toggles *do something*. In fact some are enforced and some are
only recorded, and the interface does not distinguish them.

**Concrete instance.** A per-workspace agent permission model where three of
thirteen capabilities had a real enforcement point and ten were stored
preferences. The fix was not to enforce all thirteen (that would have been a
much larger change) but to make the enforcement status a first-class field in
the permission definition, and to forbid the words "blocked" and "protected"
in any surface describing an unenforced one.

**Why current tools miss it.** Enforcement lives in scattered runtime checks
while the permission list lives in UI configuration. Nothing links them, so
drift is invisible and silent.

**Possible product.** A permission-registry pattern (or lint rule) where each
capability must declare its enforcement point, and a check fails if a
capability marked "enforced" has no reachable code path referencing it.

**Evidence needed.** Whether teams building agent/automation tools actually hit
this, or whether it is specific to fast-moving AI products where the UI outruns
the backend.

**Potential buyer.** Anyone shipping agent platforms with consequential
capabilities, especially where a compliance claim is attached.

**Urgency.** Moderate–high where a permission screen is used to justify a
safety claim to a customer or auditor.

---

## 3. AI cost accounting that hides default-model spend

**Problem pattern.** A system lets the user leave "model" blank and fills in a
provider default at execution time — but records and prices the *unresolved*
(empty) value. Real, billable usage is then recorded as unpriced and silently
excluded from any spending total or cap built on "known cost".

**Concrete instance.** Blank-model agents ran against a real default model and
were stored with `model: null`, `costUsd: null`. Because the daily spending caps
compared against the sum of *priceable* runs, ordinary default-model spend
counted as zero against the caps. The fix was to resolve the effective model
exactly once, before execution, and use that one value for invocation, the run
record, the audit event, and pricing.

**Why current tools miss it.** The defaulting happens in the execution layer
and the accounting happens in the bookkeeping layer. Both are individually
correct; the bug is that they independently decide the same fact.

**Possible product.** A "resolved-parameters" audit for LLM applications: flag
any parameter that is defaulted in one layer and read raw in another,
particularly where the second layer feeds billing or a budget control.

**Evidence needed.** How widespread blank-model defaults are in production LLM
apps, and how many of those also implement spend caps.

**Potential buyer.** Teams with per-customer or per-agent AI spend limits, where
under-counting is a direct financial risk.

**Urgency.** High where budget caps are a contractual or safety commitment.

---

## 4. Recovery systems that do not include newly added stores

**Problem pattern.** A codebase has a solid corruption/tamper recovery
mechanism covering "the stores". A feature adds several new stores. Recovery
silently does not cover them, because the mapping is a hand-maintained list and
nothing fails when it is incomplete.

**Concrete instance.** Eleven new persistence stores were added. They were
correctly registered — but nothing *proved* it, so the documentation claim was
stronger than the evidence until a test was added that asserts every new store
is reachable through the recovery endpoint and fails when one is removed.

**Why current tools miss it.** The registry is data, not a type. Omission is
not a compile error and not a runtime error — it only surfaces during an
incident, which is the worst possible moment.

**Possible product.** A capability-coverage test pattern: enumerate the
implementations of an interface and assert each is registered in every
lifecycle map (recovery, backup, migration, health check). Cheap to write,
almost never written.

**Evidence needed.** How often incident-time gaps trace back to an incomplete
registry versus a genuine logic bug.

**Potential buyer.** Anyone with hand-maintained lifecycle registries — which is
most systems that grew organically.

**Urgency.** Low day-to-day, very high during an incident.

---

## 5. Tests that cannot fail (vacuous coverage)

**Problem pattern.** A test is written for a real risk, passes, and is counted
as coverage — but the scenario it constructs cannot exercise the code path it
claims to guard. Coverage metrics count it. It protects nothing.

**Concrete instance.** An "attribute-context escaping" browser test placed a
quote-breaking payload in a record's *title*. The title renders in text
context; nothing user-controlled reached an attribute at all. The test passed
even with attribute escaping completely disabled. It only became real when
rewritten to deliver the payload through the one value that genuinely reaches
an attribute (a record id, via a tampered store file).

**Why current tools miss it.** Coverage tools measure whether a line executed,
not whether the assertion could ever have been false. A vacuous test looks
identical to a strong one in every dashboard.

**Possible product.** Routine mutation testing scoped to security-relevant
functions only (escaping, authorization checks, scoping filters) rather than
whole-codebase mutation testing, which is usually too slow to adopt.

**Evidence needed.** What fraction of security-relevant tests in real
repositories survive mutation of the function they nominally protect.

**Potential buyer.** Teams whose test suite is a compliance artifact.

**Urgency.** Moderate. The damage is false confidence, which surfaces late.

---

## 6. Documentation claiming guarantees the code does not make

**Problem pattern.** Documentation drifts *upward* in confidence over time.
Words like "isolated", "protected", "validated", "secure" get added when a
feature feels finished, and are never re-checked against what the code enforces.

**Concrete instance.** Workspace separation in a single-operator tool is real
and tested — and is emphatically not tenant isolation, because the system has no
authentication at all. Calling it "isolation" without that qualifier would
invite exactly the wrong deployment decision later.

**Why current tools miss it.** Documentation review is a human reading prose,
and strong words read as *reassuring* rather than as *claims requiring
evidence*.

**Possible product.** A documentation lint that flags a fixed vocabulary of
strong claims and requires each occurrence to carry a link to the test or code
path that substantiates it — a "claims need citations" rule for engineering docs.

**Evidence needed.** Whether teams would tolerate the friction, and whether the
false-positive rate is low enough to survive.

**Potential buyer.** Regulated or safety-adjacent teams whose docs become
external commitments.

**Urgency.** Moderate, rising sharply once documentation is shown to customers.

---

## 7. Progress indicators invented rather than derived

**Problem pattern.** A UI needs a progress number. No real baseline of planned
work exists, so a plausible-looking proxy gets substituted — a success ratio, a
count of created items, a stage index — and is displayed under the label
"progress". Users then make decisions on a number that measures something else.

**Concrete instance.** Two deliberate refusals: workstream progress is always
`null` because no planned-work baseline exists, and workspace progress returns
`null` (not `0`) when there are no milestones. "Not measurable yet" and "0%
complete" are different statements, and a test proves the code does not
collapse them.

**Why current tools miss it.** It is not a bug in any test's eyes — the number
renders, the arithmetic is right. Only domain reasoning reveals it answers the
wrong question.

**Possible product.** Less a product than a design rule worth writing down:
every displayed metric should name its denominator, and metrics without a
denominator should render as unavailable rather than zero. Plausibly a
lint/design-review checklist item for AI-generated applications, which
overproduce confident-looking dashboards.

**Evidence needed.** Whether users actually mistrust products after discovering
a fabricated metric, or simply never notice.

**Potential buyer.** Teams shipping analytics surfaces quickly, especially
AI-generated ones.

**Urgency.** Low technically, high reputationally.
