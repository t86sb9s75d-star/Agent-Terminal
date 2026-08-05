// Phase 9 — the kernel pipeline, expressed as DATA.
//
// Stages are a list, not a call chain, for one reason that governs the whole
// verification harness: a harness can only inject a fault at every stage if it
// can ENUMERATE every stage. A pipeline written as nested function calls has
// stages that exist only in the shape of the code, which means the fault
// matrix would be a hand-maintained list that silently drifts from reality —
// exactly the "documentation as evidence" failure this phase exists to remove.
//
// The rule that follows from this: adding a stage to the kernel means adding
// an entry here, and the fault matrix test derives its cases from this list.
// A new stage is therefore fault-injected the moment it exists, without anyone
// remembering to write a test for it.

// phase groups exist so invariants can talk about "before the effect" and
// "after the effect" without hardcoding stage names.
const STAGES = [
  // --- authorize: nothing has happened yet; any denial here is free ---
  { id: 'identity', phase: 'authorize', description: 'resolve who initiated this and with what assurance' },
  { id: 'workspace', phase: 'authorize', description: 'resolve and BIND the workspace; mints workspace-bound handles' },
  { id: 'constitution', phase: 'authorize', description: 'pin the constitution hash and evaluate its rules' },
  { id: 'permissions', phase: 'authorize', description: 'fold the grant ledger and check the requested capability' },
  { id: 'ratelimit', phase: 'authorize', description: 'admission control: per-workspace concurrency and rate' },
  { id: 'loop', phase: 'authorize', description: 'loop accounting: iteration, depth, fan-out, cycle detection' },
  { id: 'budget', phase: 'authorize', description: 'reserve estimated maximum cost against the cap' },

  // --- commit: the point of no return, and it is a WRITE, not the effect ---
  { id: 'record', phase: 'commit', description: 'write the transaction to the log BEFORE any effect occurs' },

  // --- effect: the only stage permitted to touch an effector ---
  { id: 'execute', phase: 'effect', description: 'invoke the effector through a transaction-bound handle' },

  // --- settle: always runs, on success and on failure alike ---
  { id: 'settle', phase: 'settle', description: 'settle actual cost, release the reservation, release admission' },
  { id: 'audit', phase: 'settle', description: 'seal the transaction with its terminal record' },
];

const STAGE_IDS = STAGES.map((s) => s.id);

// The cross-cutting behaviors a capability must inherit WITHOUT manual wiring.
// This list is the acceptance contract from the Phase 9 directive. It is
// enumerated here so the acceptance test can drive it rather than restate it —
// a restated list is a second source of truth and would drift.
//
// `provenStage` names the stage that delivers the concern, so the acceptance
// test can assert the concern is not merely claimed but produced by a stage
// that actually ran and left an artifact.
const PLATFORM_CONCERNS = [
  { id: 'authorization', provenStage: 'permissions', description: 'ungranted capability is denied' },
  { id: 'workspace_isolation', provenStage: 'workspace', description: 'effector is bound to one workspace and cannot be redirected' },
  { id: 'constitution', provenStage: 'constitution', description: 'the pinned ruleset governs and is recorded' },
  { id: 'budget', provenStage: 'budget', description: 'cost is reserved before the effect and settled after' },
  { id: 'rate_limiting', provenStage: 'ratelimit', description: 'admission is bounded and refusal is a recorded transaction' },
  { id: 'loop_accounting', provenStage: 'loop', description: 'iteration/depth/fan-out are counted from the transaction tree' },
  { id: 'audit', provenStage: 'record', description: 'a transaction record exists before the effect' },
  { id: 'tracing', provenStage: 'record', description: 'sessionId/parentTxId/seq make the causal tree reconstructible' },
  { id: 'metrics', provenStage: 'audit', description: 'counters are derived from sealed transactions' },
  { id: 'cancellation', provenStage: 'execute', description: 'an abort signal reaches the effector and terminates it' },
  { id: 'structured_events', provenStage: 'audit', description: 'a structured event is emitted for the operator surface' },
];

const PLATFORM_CONCERN_IDS = PLATFORM_CONCERNS.map((c) => c.id);

function stage(id) {
  const found = STAGES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown kernel stage: ${id}`);
  return found;
}

// Stages strictly before the effect. Used by the record-before-effect
// invariant so it does not hardcode an index that a reordering would break.
function stagesBeforeEffect() {
  const effectIndex = STAGE_IDS.indexOf('execute');
  return STAGE_IDS.slice(0, effectIndex);
}

module.exports = { STAGES, STAGE_IDS, PLATFORM_CONCERNS, PLATFORM_CONCERN_IDS, stage, stagesBeforeEffect };
