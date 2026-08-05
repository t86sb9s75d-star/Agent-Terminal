// Phase 9 kernel harness — fault injection.
//
// A CRITICAL DISTINCTION, and getting it backwards would make the whole
// harness meaningless:
//
//   FAULT INJECTION models the ENVIRONMENT failing. A stage times out, throws,
//   receives corrupted input, is cancelled, is retried, or races another
//   transaction. The kernel must SURVIVE these and every invariant must still
//   hold afterwards. A failing invariant here is a real kernel defect.
//
//   MUTATION (see mutants.js) models the KERNEL ITSELF being wrong. Every
//   invariant must FAIL. A passing invariant there means the invariant is
//   vacuous.
//
// Both are needed. Fault injection proves the kernel is robust; mutation
// proves the harness can tell. Neither alone is evidence.
//
// Each fault is a stage-override factory: (base) => wrapped. They are applied
// through the kernel's __stageOverrides seam, which is test-only — asserted by
// test/kernel/noProductionHooks.test.js.

const FAULT_IDS = ['exception', 'timeout', 'corrupted_input', 'partial_state', 'cancellation', 'retry', 'concurrent'];

// The stage throws before doing anything.
function exception() {
  return () => async () => {
    const err = new Error('injected: stage threw');
    err.injected = true;
    throw err;
  };
}

// The stage stalls and then fails the way a timed-out dependency would.
function timeout({ delayMs = 5 } = {}) {
  return () => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    const err = new Error(`injected: stage timed out after ${delayMs}ms`);
    err.injected = true;
    err.code = 'ETIMEDOUT';
    throw err;
  };
}

// The stage receives a mangled context. Models upstream corruption: a field
// the stage depends on is absent or the wrong type. The kernel must not turn
// this into an execution.
function corruptedInput() {
  return (base) => async (ctx) => {
    ctx.intent = { ...ctx.intent, capability: null, workspaceId: undefined, args: Symbol('not-serializable') };
    ctx.identity = undefined;
    ctx.capability = undefined;
    return base(ctx);
  };
}

// The stage's work COMPLETES and then the stage fails — the write landed but
// the acknowledgement was lost. This is the fault most likely to produce an
// inconsistent kernel, because naive compensation assumes failure means
// nothing happened.
function partialState() {
  return (base) => async (ctx) => {
    await base(ctx);
    const err = new Error('injected: stage completed its work then failed');
    err.injected = true;
    err.partial = true;
    throw err;
  };
}

// The caller's abort signal fires exactly when this stage is reached.
function cancellation({ controller }) {
  return (base) => async (ctx) => {
    controller.abort();
    return base(ctx);
  };
}

// The stage runs its base implementation twice — an internal retry that is not
// idempotent. Catches stages whose second invocation double-counts, double-
// reserves, or double-records.
function retry() {
  return (base) => async (ctx) => {
    await base(ctx);
    return base(ctx);
  };
}

// Deterministic race forcing: every transaction blocks AT THIS STAGE until all
// participants have arrived, then all proceed together. This guarantees the
// interleaving happens at exactly the point under test rather than wherever the
// scheduler happens to switch — same principle as the Playwright route delay
// that made the A-001 race reproducible. A race you cannot reproduce on demand
// is a race you cannot prove fixed.
function concurrent({ barrier }) {
  return (base) => async (ctx) => {
    await barrier.arrive();
    return base(ctx);
  };
}

// An N-party barrier. Releases only once N arrivals have occurred, so a test
// running N concurrent transactions is guaranteed real overlap at the stage.
// `timeoutMs` prevents a miscounted barrier from hanging the suite forever —
// a hung test is a test that reports nothing.
function makeBarrier(n, { timeoutMs = 2000 } = {}) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const timer = setTimeout(() => release(), timeoutMs);
  if (timer.unref) timer.unref();
  return {
    arrive() {
      arrived += 1;
      if (arrived >= n) {
        clearTimeout(timer);
        release();
      }
      return gate;
    },
    arrivals: () => arrived,
  };
}

// Builds the override map for one (stage, fault) pair.
function inject(stageId, faultId, opts = {}) {
  const factories = {
    exception,
    timeout,
    corrupted_input: corruptedInput,
    partial_state: partialState,
    cancellation,
    retry,
    concurrent,
  };
  const factory = factories[faultId];
  if (!factory) throw new Error(`unknown fault: ${faultId}`);
  return { [stageId]: factory(opts) };
}

module.exports = { FAULT_IDS, inject, makeBarrier };
