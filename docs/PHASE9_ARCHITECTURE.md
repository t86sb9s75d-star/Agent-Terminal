# Phase 9 — Constitution Runtime Architecture

Status: **design only**. No implementation exists for anything described here.
Every claim below is labelled with a confidence level. Nothing in this document
is evidence that anything works; it is a plan for what to build and, more
importantly, for what must be *provable* once built.

---

## 0. Ground truth — what actually exists today

Established by reading the code, not from memory or documentation.

**F1 [Certain] — There is exactly one execution entry point.**
`agentManager.start()` (`src/agentManager.js:105`) is the only function that
invokes a provider. It is reached from `POST /api/agents/:id/start`
(`src/server.js:414`). The only other caller into the run lifecycle is
Sentinel containment calling `agentManager.stop()` (`src/server.js:473`).
Verified by grepping every `.js` file for worker imports and manager calls.

This is a favourable starting position and it is easy to misread. The
chokepoint already exists *structurally*. What does not exist is a chokepoint
that **evaluates anything coherent**: `start()` performs three unrelated,
unordered, partial checks (workstream-archived, budget, model resolution) and
then executes. Phase 9 is not "introduce a chokepoint." It is "make the
existing chokepoint total, ordered, complete, and provable — and make a second
one impossible to add."

**F2 [Certain] — Execution is single-shot. There are no tool calls, no memory,
no delegation, and no loops.**
All three workers (`anthropic.js`, `openai.js`, `custom.js`) send one request
or spawn one command and return. `runAnthropic` posts a single
`messages.stream` with no `tools` parameter.

The consequence is large and mostly good: **there is no legacy bypass to
migrate, because the systems that would bypass the kernel have not been built
yet.** Tools, memory, delegation, and loops arrive *after* the kernel, which
means they can be born behind it. This is the single most valuable property of
the current position and it is perishable — it is only true until the first
tool is written outside the kernel.

**F3 [Certain] — There are two disjoint "agent" concepts, and the permissions
are attached to the one that cannot execute.**

| | Executable agent (`src/store.js`) | Catalog agent (`src/agentCatalog.js`) |
|---|---|---|
| Has provider/model/task/command | yes | no (a `provider` *hint* only) |
| Can be started | yes | **no** |
| Scoped to | `workstreamId` | `workspaceId` (via settings store) |
| Has permissions | **no** | yes (13 capabilities) |

`agentCatalog.js` says so in its own header: *"Nothing here executes anything.
Wiring 'enable this catalog agent in this workspace' to an actual
store.create() call is a later phase."*

This is the **root cause** of "zero of thirteen capabilities are enforced," and
it is deeper than the missing gate I reported in Phase 8. I previously
characterised it as "nothing reads the stored value." The truer statement is:
*the permission is attached to an entity with no execution path, and the entity
that executes has neither permissions nor a workspace.* Writing a gate into
`agentManager.start()` today would have nothing to read — not because the read
was forgotten, but because the two halves have never been connected.

Correcting my own earlier framing: I described this in `permissions.js` as a
gate that was never written. It is more accurately a **join that was never
made**. That distinction matters here because it means Phase 9's first
structural task is not authorization logic — it is unifying the agent model.

**F4 [Certain] — There is no authentication and no user identity.**
Workspaces have no owner field (`src/workspacesStore.js:101`). The server binds
loopback and has no auth layer. The Capability Transaction field *"Which
user?"* is therefore **not answerable with any assurance today**, and any field
claiming to hold it would be decoration. See §16-B for the concrete attack this
enables and the proposed fix.

**F5 [Certain] — `'scheduler'` is an actor type with no producer.**
`eventLog.js:23` enumerates it; nothing in the codebase can emit it. Nothing is
broken — it is an unfilled slot, and event-driven wake will be its first
producer.

**F6 [Certain] — Single-instance enforcement exists and is acquired before any
store is touched** (`src/server.js:29`). Every guarantee in this document that
depends on "one runtime sees everything" rests on that lock. It is a live PID
check, not a file-existence check.

---

## 1. Overall runtime architecture

```
                        operator (HTTP, loopback)
                                 |
        +------------------------+------------------------+
        |                                                 |
   OPERATOR PLANE                                    AGENT PLANE
   (amend constitution,                         (everything an agent does)
    issue/revoke grants,                                  |
    terminate sessions)                                   v
        |                                    +---------------------------+
        |  requires operator token           |     CONSTITUTION KERNEL   |
        |  (never in agent env)              |                           |
        v                                    |  admit -> resolve ->      |
   +---------------+                         |  evaluate -> reserve ->   |
   | Constitution  |  compiled, hash-id'd    |  record -> effect ->      |
   | (immutable    |------------------------>|  settle -> seal           |
   |  versions)    |                         +-------------+-------------+
   +---------------+                                       |
   +---------------+   append-only chain                   | mints
   | Grant Ledger  |------------------------>              | per-transaction
   +---------------+                                       v handles
                                              +---------------------------+
                                              |        EFFECTORS          |
                                              | provider | tool | memory  |
                                              |  (not importable directly)|
                                              +-------------+-------------+
                                                            |
                                              +---------------------------+
                                              |  TRANSACTION LOG (chained)|
                                              +---------------------------+
```

**Two planes.** The operator plane can change the rules. The agent plane can
only act under them. The planes are separated by an authentication boundary
(§16-B), not by convention.

**One kernel.** A single module exposing essentially one verb:

```js
kernel.execute(intent) -> { decision, result }
```

**Effectors are not importable.** This is the mechanism that makes "nothing
bypasses it" a structural property rather than a promise, and it is the part of
this design I would defend hardest.

Three ways to enforce a chokepoint, in ascending order of trustworthiness:

1. *Convention* — "don't call the workers directly." Unprovable. Rejected.
2. *A static import-graph test* — a test that fails if anything outside the
   kernel imports an effector. **Necessary but insufficient**, and I have
   direct evidence why: in Phase 8 my static source scan reported a route as
   audited when it was not (finding A-009); the scan window ran past the route
   body. A source-text scan is an indirect signal about runtime behaviour.
   Keep this test — it catches mistakes early and cheaply — but never treat it
   as the proof.
3. *Capability injection* — effectors are registered into a module-private
   registry at boot and never exported. The only way to obtain a callable
   effector is to receive a **transaction-bound, single-use invoker** minted by
   the kernel. Code without a handle cannot perform the effect, because it has
   no reference to reach.

We use (3) as the authorization mechanism and (2) as an early-warning tripwire.

**The bypass tripwire.** Each effector additionally asserts, via
`AsyncLocalStorage`, that it is executing inside a live transaction context. The
split of responsibilities is deliberate:

- the **explicit handle** is the authority (deny/allow flows from it);
- **ALS is only a detector** for a handle-less call.

This ordering matters. If ALS ever loses context across an async boundary — a
known hazard with some native callbacks — a design that *authorized* on ALS
would deny legitimate work. Here, legitimate work always carries the handle, so
ALS loss can only affect the detector, and a missing context means "deny and
audit," which is the safe direction. [High Confidence] `AsyncLocalStorage` is a
stable Node API adequate for this; the fail-closed split means an ALS defect
degrades detection, never correctness.

---

## 2. Capability Transaction lifecycle

The user's field list is a flat questionnaire. Implemented flat, it produces a
record that is filled in at different times by different code with no ordering
guarantee — exactly the shape that lets a field be silently absent. The
lifecycle below assigns **every field a phase in which it becomes known and
after which it is frozen**.

```
 ADMITTED -> RESOLVED -> EVALUATED -> RESERVED -> RECORDED -> EFFECTED -> SETTLED -> SEALED
                             |
                             +--> DENIED --> RECORDED --> SEALED
```

| Phase | Becomes known | Frozen after |
|---|---|---|
| ADMITTED | initiator, trigger, parent transaction, delegation source | admission |
| RESOLVED | workspace, agent, constitution hash, grant-chain head | resolve |
| EVALUATED | capabilities requested, decision, reason | evaluate |
| RESERVED | budget hold, loop counters, provider selection + why | reserve |
| RECORDED | transaction written to the chained log **before any effect** | record |
| EFFECTED | tool/provider/memory result, usage | effect |
| SETTLED | actual cost, reservation released | settle |
| SEALED | terminal, hash-chained, immutable | — |

**The single most important rule in this document:**

> A transaction is written to the audit log **before** its effect executes, not
> after. If the log cannot be written, the effect does not happen.

This is the artifact rule stated as a runtime invariant. It inverts today's
behaviour, where `eventLog.record()` for `run.started` happens after the run
row is created but the *effect* can still proceed if logging throws. It is also
directly testable: make the log unwritable, attempt an execution, assert the
effect did not occur. That test is the guarantee.

**Nesting.** Transactions form a tree per wake, not a flat list:

- **Session** — one wake of one agent. Opens with a root transaction.
- **Transaction** — every individually authorizable action within it: each tool
  call, each memory read, each memory write, each provider call, each loop
  iteration, each delegation.
- **Delegation** creates a child session whose root transaction's parent is the
  delegating transaction.

[Certain] Nesting is required, not stylistic: the user's requirement that
memory reads, tool calls, and delegation each be authorized cannot be satisfied
by a per-run record, because a single run performs many differently-authorized
actions. The tree is also what makes loop supervision and cycle detection
derivable from the artifact instead of from a counter variable someone might
forget to increment (§11).

**Fields the system cannot honestly fill.** *Which user?* — see F4. Until an
identity boundary exists, this field holds `local_operator` with an explicit
`assurance: 'none'` marker. It must never be rendered as though it identifies a
person. A field that looks like identity but carries none is worse than an
absent field, because it invites exactly the "configuration label as evidence"
mistake the artifact rule forbids.

---

## 3. Constitution Runtime API

A Constitution is **compiled code with a content hash**, not a document.

```js
constitution.compile(source) -> {
  id,          // sha256 of the canonicalized source — the artifact identity
  version,     // monotonic, assigned by the operator plane
  evaluate(tx) -> { effect: 'allow'|'deny', ruleId, reason }
}
```

**Immutability and pinning.** A session pins the constitution `id` at start and
carries it on every transaction in the tree. Two consequences:

- You can prove, for any past action, exactly which ruleset governed it, and
  that the ruleset was not retroactively edited. That is an artifact-grade
  answer to "was this allowed at the time?"
- An amendment mid-flight does **not** change the rules under a running
  session. [Certain] this is the correct default — rules changing mid-session
  produce an audit trail that cannot be explained. The tradeoff is real and
  must be named honestly: **an emergency tightening does not stop work already
  running.** The answer is a separate, explicitly-named operator action
  ("revoke and terminate running sessions"), not a quiet reinterpretation of
  what "amendment" means.

**"No agent may modify the Constitution" — how to make that true.**

The weak construction is a deny rule. A deny rule lives in the ruleset and is
therefore in scope for amendment. The strong construction is:

> There is **no capability in the registry that grants constitution
> amendment.** An agent cannot request it, because it is not a thing that can
> be requested. Amendment is reachable only from the operator plane, which is
> not reachable from `kernel.execute()`.

[Certain] the strong construction is strictly better: a nonexistent capability
cannot be granted by a misconfiguration, a bug in the fold, or an over-broad
wildcard.

**This is not sufficient today, and §16-B explains why.**

---

## 4. Capability Registry

The registry is what makes the success criterion achievable. A capability is a
**declaration**, not a branch in an `if`:

```js
registry.define({
  id: 'memory.write',
  effector: 'memory',                 // which effector this guards
  scopeSchema: { ... },               // what constraints may narrow it
  budgetClass: 'none' | 'metered',
  auditShape: { ... },                // what the transaction must record
  consequential: true,
});
```

The kernel's evaluate/reserve/record path is **generic over the registry**. It
contains no capability-specific logic.

**The success criterion, in executable form.** Register a synthetic capability
in a test fixture, implement a trivial effector, and assert that without
touching the permission engine, the audit layer, the budget layer, or the
isolation layer, the new capability automatically gets: denial when ungranted,
a transaction record, workspace scoping, budget accounting, and loop counting.
If that test needs any production change outside the registry entry and the
effector, **Phase 9 has failed its own success criterion** — and the test says
so, rather than a person judging it. This test is the primary acceptance gate
for the whole phase.

---

## 5. Permission Engine — grants as an append-only ledger

Per the directive: *"Never checkbox state."*

`capability_grants.jsonl`, hash-chained, reusing the existing
`persistence/chainedLog` (the same primitive already proven for `events.jsonl`).

```js
{ grantId, chainIndex, ts, actor, subject: { agentId, workspaceId },
  capability, constraint, effect: 'grant' | 'revoke',
  reason, priorGrantId, constitutionId }
```

Effective permission = **fold of the chain**. The fold is computed, cached, and
rendered. It is never stored as the truth.

Three properties this buys that the current checkbox store cannot provide:

1. **Provenance.** Every grant has an actor and a stated reason.
2. **Retroactive answerability.** "Was this agent allowed to do X *when it did
   X*?" is answered by replaying the chain to that transaction's grant-chain
   head — which each transaction pins. Today this question is unanswerable in
   principle, because the checkbox has no history.
3. **Tamper evidence**, inherited from the chain.

**Ordering authority is `chainIndex`, not `ts`.** [Certain] This eliminates an
entire class: clock skew, NTP steps, and non-monotonic wall time can never
reorder a fold. Timestamps become advisory metadata. This is a deliberate
lesson from the date-validation defects in Phase 8 — where a value that *looked*
like a valid ordering key (`Date.parse` accepting `'garbage 2024'` and rolling
`2026-02-31` over into March) was trusted for correctness.

**Tradeoff [Certain]:** fold cost is linear in chain length. Mitigation:
periodic **checkpoint** records carrying the hash of the chain prefix they
summarize — a cache with a verifiable link back to the chain, not a second
source of truth. Grant volume is low (operator actions), so this is unlikely to
bind soon; transaction volume is high, which is why transactions do *not* live
in a `createVersionedStore` (§13).

---

## 6. Memory authorization model

Memory is where a fleet of hundreds becomes dangerous, because memory is the
channel through which one agent's output becomes another agent's input.

Address: `(workspaceId, scope, key)` with `scope ∈ { agent_private,
workspace_shared, protected, system }`.

| scope | read | write |
|---|---|---|
| `agent_private` | owning agent only | owning agent only |
| `workspace_shared` | `memory.read` in workspace | `memory.write` in workspace |
| `protected` | `memory.read` in workspace | **operator plane only** |
| `system` | kernel only | kernel only |

`protected` is the user's own worked example: *"Protected memory write denied.
Audit entry recorded."* It is the scope for facts an agent must not be able to
launder — the constitution reference, grant state, workspace identity.

**Two rules that eliminate classes rather than catching instances:**

1. **Authorize at the store boundary, never by post-filtering.** A read that
   fetches and then filters has already brought the data into the agent's
   reach. Additionally, *the set of keys is itself information* — a denied read
   must not leak that the key exists. Denials therefore return the same shape
   for "absent" and "forbidden."
2. **The memory effector takes no `workspaceId` argument.** It is minted bound
   to the transaction's workspace. See §7 — this is the same idea applied
   generally.

---

## 7. Workspace isolation model

The A-001 defect (a stale workspace's records rendering under another
workspace's header) happened because **workspace was a parameter that could be
wrong**. The fix I shipped was a request-generation token — correct, but it
fixes one call site. Phase 9 should eliminate the class.

**Backend rule [Certain]: make the illegal state unrepresentable rather than
checked.** Effector handles are minted bound to a workspace. There is no
API surface that accepts a `workspaceId` argument, so there is no argument to
get wrong, no check to forget, and no test needed for "did we check?" — the
type of the handle is the enforcement.

Tradeoff, stated honestly: this constrains legitimate cross-workspace work
(e.g. a future portfolio-level report). That must go through an explicit,
separately-audited `cross_workspace_read` capability with its own transaction —
which is the correct outcome, since such a read genuinely is a different and
more consequential action.

**UI rule.** The directive says *"The UI must never display stale workspace
data."* Generalizing the A-001 fix into a protocol invariant:

> Every workspace-scoped response carries `workspaceId` and a monotonic
> `generation`. The client discards any response whose `workspaceId` does not
> match the currently-selected workspace, or whose `generation` is older than
> one already applied.

The client-side discard is then one rule in one place rather than a token per
view — and it is testable by forcing response reordering with route delays, the
technique that caught A-001. [High Confidence] this covers the class for
request/response; WebSocket pushes need the same stamp, and that is a distinct
code path which must get its own test rather than an assumption of coverage.

---

## 8. Provider routing model

One router. Inputs: agent preference, constitution constraints (e.g. "this
workspace may only use provider X"), budget state, availability.

The important change is not the routing — it is that **the selection and its
reason are recorded on the transaction**. Today `models.js` resolves the
effective model once and records it, which fixed a real spend-hiding bug, but
*why* a model was chosen is not recorded. Under a constitution that can
constrain providers, "which provider ran, and under which rule" must be an
artifact, or provider constraints become another unfalsifiable claim.

---

## 9. Tool authorization model

Tools do not exist yet (F2), so they can be born behind the kernel.

A tool is registered as `{ id, capability, argSchema, effector }`. Invocation
is a transaction. Three rules:

1. **Arguments are validated against the schema before evaluation**, so the
   constitution evaluates the *actual* arguments, not a promise about them.
2. **A tool cannot invoke another tool directly** — it returns to the kernel,
   which opens the next transaction. This keeps the tree accurate and prevents
   an internal call chain that the audit cannot see.
3. **Tool results are data, never instructions to the kernel.** A tool result
   can never widen a grant, change routing, or alter budget.

Rule 3 is the artifact rule applied to the most likely future attack: an agent
whose tool output is designed to be read as configuration.

---

## 10. Delegation model

Delegation is a capability (`delegate`), constrained by target agent and depth.

**Authority never increases across a delegation boundary [Certain].** The
child's effective grant is the *intersection* of the child agent's grant and
the parent transaction's grant. Union semantics would make delegation a
privilege-escalation primitive: any agent could reach any capability by
delegating to an agent that holds it.

**Cycle and fan-out control.** Depth alone is insufficient — a wide fan-out at
shallow depth is equally damaging. Because transactions form a tree, both are
derivable from the artifact:

- walk ancestors; deny if the same `(agentId, intentHash)` already appears
  (cycle);
- cap total transactions per root session (fan-out).

[High Confidence] both are adequate at the described fleet scale; the fan-out
cap is the one likelier to need tuning, because a legitimate breadth-first task
can look like a runaway.

---

## 11. Loop supervision model

Each session carries a loop budget: max iterations, max wall time, max spend,
max tool calls, max delegation depth.

[Certain] the counters must be **derived from the transaction tree, not held in
variables.** A counter is state that can be forgotten, reset, or bypassed by a
new code path; a count over recorded transactions cannot disagree with what
actually happened. This is the same principle that made the audit-coverage
contract (Phase 8) trustworthy: it diffs the real log rather than reading the
source.

Exceeding any limit → deny → terminate session → audit. Termination reuses the
proven mechanism: `terminateProcessGroup` for shell children, `AbortController`
for provider calls.

---

## 12. Budget enforcement

**A real defect in the current design, found while designing this section.**

`budget.assertWithinBudget()` (`src/budget.js:46`) reads today's total and
compares it to the cap. It is a **read-then-act with no reservation and no
lock**. Two concurrent `POST /start` requests both read the same total, both
pass, and both run. Costs only land at `finishRun`.

- [Certain] on the mechanism: the code reads a total and returns; nothing is
  held between the check and the run.
- [High Confidence] on practical exploitability: overshoot is bounded by
  concurrent starts and requires the runs to be priceable (unpriced models
  already fall outside the check, which the module documents).

This is not urgent at one operator with a handful of agents. At the fleet scale
Phase 9 targets — hundreds of agents, event-driven wake, no human watching — it
becomes the difference between a cap and a suggestion.

**Fix: reservation semantics.** Before a provider call, the transaction
reserves an estimated maximum cost (`max_tokens × price`, computable
pre-flight). The reservation is held against the cap. On settle, actual cost
replaces the estimate and the remainder is released.

Reservations need an owner and a lifetime, or a crashed session leaks budget
forever. Orphaned reservations are released on boot by the recovery path — the
same shape as the existing Phase 3.5 in-flight-run recovery, which is precedent
worth reusing rather than reinventing.

Honest limitation, unchanged by any of this: **actual cost is only knowable
after the call.** A per-call overshoot within a single reservation remains
possible. Reservation converts an unbounded overshoot into one bounded by the
estimate — it does not make the cap exact, and the docs must not say it does.

---

## 13. Audit architecture

Two stores with **different trust properties**, kept distinct:

| | Grant ledger + transaction log | Snapshot stores |
|---|---|---|
| Shape | append-only, hash-chained | versioned JSON + backups |
| Answers | what happened, in order, unaltered | what is true now |
| On corruption | chain break is *detectable* | last-good restore |

Transactions are high-volume. [Certain] they must **not** live in a
`createVersionedStore`: measured in Phase 8, a 10k-record versioned store
writes synchronously in ~92ms, and that cost is paid on *every write* because
the whole file is rewritten. Sequential appends to a chained log measured
~7.6ms. Governance state (low-volume, needs current-value reads) and runtime
state (high-volume, append-only) have opposite write profiles and must not
share a mechanism.

Chained logs need **rotation with chain continuity** — each segment records the
terminal hash of its predecessor, so verification spans segments. This does not
exist yet and is required before transaction volume is real.

**The audit-coverage contract from Phase 8 extends directly.** That contract
drives every mutating route and diffs `events.jsonl`, with an explicit
allowlist. The Phase 9 form: **every registered capability must produce a
transaction record**, verified by driving each capability and diffing the log —
with an allowlist that requires a stated reason. That contract is what makes
"nothing bypasses the kernel" a measured property.

---

## 14. Migration strategy

Mostly favourable, because of F2 — the systems that would need migrating do not
exist. The exception is F3, and it is the hard part.

**Step 1 — Kernel, transaction, audit, tripwire.** No migration; nothing
depends on it yet.

**Step 2 — Route the one existing execution path through the kernel.**
`agentManager.start()` becomes a kernel client. Its ad-hoc checks become
constitution rules: workstream-archived and budget stop being inline `if`s and
become rules with rule IDs that appear in the transaction record. Behaviour
should be *identical* — and the existing 175-test suite is the regression
oracle for that, which is exactly what it was built for.

**Step 3 — Unify the agent model (the hard one).** Executable agents need a
`workspaceId`; catalog agents need to instantiate into executable agents.

Existing agents have a `workstreamId` and no workspace. Two options:

- **(a)** Auto-assign to a system "unassigned" workspace with a minimal grant.
  Zero friction; **invents an authorization context that no operator chose.**
- **(b)** Refuse to run legacy agents until the operator assigns a workspace,
  with a clear prompt naming each agent.

[Certain] **(b) is the more truthful option** and the one I recommend. Option
(a) manufactures the exact kind of unearned authority this phase exists to
eliminate — an agent running under a workspace nobody granted. The cost is real
operator friction at the migration boundary, and that cost is the user's call,
not mine. If (a) is chosen, the synthetic workspace must be visibly marked as
migration-created in the UI and in the grant ledger, never silently normal.

**Step 4 onward — tools, memory, delegation, loops.** Each is new construction
behind the kernel. No migration.

---

## 15. Failure modes

Every one of these must fail **closed**, and each is directly testable.

| # | Failure | Required behaviour | Test |
|---|---|---|---|
| 1 | Constitution fails to compile | **No executions.** A broken constitution means "no execution," never "no rules." | boot with malformed source; assert every execution denied |
| 2 | Audit log unwritable | Deny execution. If it cannot be recorded, it may not happen. | make log read-only; assert effect did not occur |
| 3 | ALS context lost | Handle-less call denied + audited; handle-carrying calls unaffected | invoke effector outside kernel; assert throw + audit |
| 4 | Grant chain broken | Deny all capability evaluation; `systemState.markDegraded`; operator recovery | corrupt a chain record; assert deny + degraded |
| 5 | Reservation leak (crash mid-session) | Orphans released on boot | kill mid-session; assert budget restored |
| 6 | Clock skew / non-monotonic time | No effect — fold orders by `chainIndex` | fold with shuffled timestamps; assert identical result |
| 7 | Amendment during in-flight session | Session keeps pinned constitution; new sessions get the new one | amend mid-session; assert pinned hash on child transactions |
| 8 | Second process | Refused by `instanceLock` | covered today (F6) |
| 9 | Fleet overload | Admission control: bounded concurrency, per-workspace fairness, backpressure — **queue depth is not a control** | saturate; assert bounded concurrency and no unbounded queue |
| 10 | Effector added without registry entry | Import-graph test fails; capability-coverage contract fails | add unregistered effector in fixture; assert both fail |

Failure 9 deserves emphasis because the directive explicitly anticipates
hundreds of agents. An unbounded queue converts an overload into an invisible
latency failure — work is "accepted" and never runs. Admission control must
**reject** when saturated, and the rejection must be a transaction, so the
artifact shows what was refused rather than silently swallowing it.

---

## 16. Two problems this design does not yet solve

### A. Truthfulness of agent claims — unsolved [Unknown]

The directive requires: *"Never 'verified' without verification. Never
'recovered' without recovery."*

The kernel can enforce this **only for actions that pass through it**. If an
agent emits the text "I verified the deployment," no runtime check can
determine whether that sentence is true — it is natural language, not an
action.

What the kernel *can* do: make the claim checkable, by placing the transaction
tree beside the claim. If an agent claims verification and its session contains
no transaction that could constitute verification, the discrepancy is
mechanically detectable. That is a Sentinel rule over transaction trees, and it
is worth building — but it detects *unsupported* claims, not *false* ones.

I want to be exact about the limit rather than let the kernel appear to cover
more than it does: **an agent can still state something false about the world
outside its transactions, and no amount of runtime enforcement fixes that.**
Claiming otherwise would be precisely the overstatement Phase 8 spent a pass
removing.

### B. The loopback authority hole — [Certain], and it blocks a stated guarantee

The Constitution is owner-controlled and no agent may modify it. **That is not
enforceable today**, for a reason that is structural rather than a bug:

- the server binds loopback with **no authentication** (F4);
- `custom` provider agents get a real shell with `PATH` in the environment
  (`src/workers/custom.js:12`);
- therefore an agent can `curl` the admin API of its own host.

The existing env allowlist (a genuinely good control — it stopped agents
reading `ANTHROPIC_API_KEY`) does not help, because the admin API needs no
credential at all.

Every operator-plane guarantee in this document depends on closing this. The
fix is small and testable:

1. Operator-plane mutation routes require a **per-boot operator token**.
2. The token is never in the agent environment — `ALLOWED_ENV_VARS` is already
   an allowlist, so this requires *not adding* it, which is the safe default.
3. Effectors never expose loopback HTTP to agents.

**Proof, as an artifact rather than an assertion:** run a real `custom` agent
whose command attempts to amend the constitution over loopback; assert HTTP 401
**and** an audit entry recording the attempt. That test is the guarantee. Until
it exists and passes, this document should not claim the Constitution is
owner-controlled — it should say the design intends it and the boundary is not
yet built.

[Certain] on the hole: the ingredients are each verified in the code above.
I have not fired the exploit end-to-end, so the label is on the mechanism.
This is Slice 0 — it precedes everything else, because a kernel behind an open
admin API is a kernel with a documented bypass.

---

## 17. Implementation order

Vertical slices, each ending in executable proof. Slice 0 is inserted ahead of
the directive's suggested order for the reason in §16-B.

| Slice | Contents | Proof that ends it |
|---|---|---|
| **0** | Operator/agent plane split; operator token; loopback denial | custom agent attempts amendment → 401 + audit entry |
| **1** | Capability Transaction; kernel; chained transaction log; effector injection + ALS tripwire | log-unwritable → no effect; handle-less call → deny + audit |
| **2** | Constitution compile/pin/evaluate; existing `start()` routed through kernel | 175-test suite unchanged; malformed constitution → all denied |
| **3** | Grant ledger; permission engine; fold + checkpoints | shuffled timestamps → identical fold; retroactive query correct |
| **4** | Agent-model unification (F3); workspace-bound handles | no API accepts `workspaceId`; legacy agents refuse to run |
| **5** | Memory + scopes + authorization | protected write → denied + audit; denied read indistinguishable from absent |
| **6** | Tools + registry generality | **synthetic-capability test (§4)** — the phase's acceptance gate |
| **7** | Delegation (intersection semantics, cycle/fan-out) | escalation attempt denied; cycle denied |
| **8** | Loop supervision; budget reservation | concurrent starts cannot exceed cap; crash releases reservation |
| **9** | Event-driven wake; admission control; fleet harness | saturation → bounded concurrency + rejection transactions |

Every guarantee gets the six-part treatment already established: positive
proof, negative proof, mutation proof (**verify the mutation applied**),
failure proof, false-pass challenge, false-fail challenge.

---

## 18. Confidence summary

| Claim | Confidence |
|---|---|
| One execution entry point exists today | Certain |
| No tools/memory/delegation/loops exist yet | Certain |
| Permissions attach to a non-executable entity (root cause) | Certain |
| No authentication; "which user" unanswerable | Certain |
| Loopback lets an agent reach the admin API (§16-B) | Certain (mechanism); not fired end-to-end |
| Budget check is read-then-act; concurrent overshoot | Certain (mechanism) / High (exploitability) |
| Effector injection makes bypass structural | High |
| ALS adequate as a detector, fail-closed | High |
| Chain-index ordering eliminates clock-skew class | Certain |
| Workspace-bound handles eliminate the isolation class | Certain (backend) / High (UI, WS path untested) |
| Cycle + fan-out control adequate at stated scale | High |
| Registry generality achieves the success criterion | Hypothesis until the §4 test passes |
| Runtime can enforce agent truthfulness | **Unknown — see §16-A; likely not fully achievable** |

---

## 19. Open questions for the operator

1. **Migration option (a) or (b)** (§14 Step 3) — auto-assign legacy agents to
   a synthetic workspace, or refuse to run them until assigned? I recommend
   (b); the friction is real and the call is yours.
2. **Does the fleet share one constitution, or one per workspace?** This design
   assumes constitutions are pinned per session and *can* differ per workspace,
   but a single global constitution is simpler to reason about and to verify.
3. **Is `custom` (shell) provider in or out for governed agents?** §16-B is
   closable with a token, but a shell agent remains the widest blast radius in
   the system. Keeping it is defensible; it should be a decision, not a
   default.
