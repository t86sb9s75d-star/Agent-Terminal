// Phase 9 — the capability registry.
//
// A capability is a DECLARATION, not a branch in the kernel. The kernel's
// pipeline contains no capability-specific logic; everything it needs to
// authorize, meter, record and settle an action is read from the entry here.
//
// This is what makes the phase's acceptance criterion reachable: adding a
// capability is one entry plus one effector, and removing a capability is
// deleting one entry. If either required a change inside the kernel, the
// kernel would not be a kernel — it would be a switchboard.

const { AppError, Codes } = require('../errors');

function createRegistry() {
  const capabilities = new Map();
  const effectors = new Map();

  // Effectors are held in this closure and NEVER exported. The only way to
  // reach one is a transaction-bound handle minted by the kernel (see
  // kernel.js mintHandle). Module-private storage is what makes "nothing
  // bypasses the kernel" a structural property rather than a convention:
  // code that does not hold a handle has no reference to call.
  function defineEffector(id, impl) {
    if (typeof impl !== 'function') throw new Error(`effector "${id}" must be a function`);
    if (effectors.has(id)) throw new Error(`effector "${id}" is already defined`);
    effectors.set(id, impl);
  }

  function define(entry) {
    const { id, effector, budgetClass = 'none', consequential = false, maxCostUsd = null, argSchema = null } = entry;
    if (!id || typeof id !== 'string') throw new Error('capability id is required');
    if (capabilities.has(id)) throw new Error(`capability "${id}" is already defined`);
    if (!effector || typeof effector !== 'string') throw new Error(`capability "${id}" must name an effector`);
    if (!['none', 'metered'].includes(budgetClass)) {
      throw new Error(`capability "${id}" has unknown budgetClass "${budgetClass}"`);
    }
    capabilities.set(id, {
      id,
      effector,
      budgetClass,
      consequential: Boolean(consequential),
      // The declared UPPER BOUND on what one invocation may cost, not an
      // estimate. Chaos testing found the difference the hard way: reserving a
      // point estimate while the effector could legitimately return more let
      // committed spend drift past a cap ($5.03 against $5.00). A cap built on
      // an estimate is not a cap.
      //
      // For provider calls this bound is computable pre-flight (max_tokens x
      // price). `null` means the capability cannot be bounded ahead of the
      // call; the kernel reserves zero AND records that fact, so an unbounded
      // capability is visible in the artifact rather than silently free —
      // the same truthful-partial-total philosophy as src/budget.js.
      //
      // An effector that settles ABOVE its declared max has broken its
      // contract. The kernel cannot prevent that, but it detects and records
      // it (see kernel.js settle).
      maxCostUsd,
      argSchema,
    });
  }

  // Removal must be as clean as definition — the directive's second acceptance
  // test. Returning the removed entry (rather than a boolean) lets a caller
  // prove WHAT was removed, and `has()` going false is the observable that the
  // lifecycle test asserts against.
  function remove(id) {
    const entry = capabilities.get(id);
    if (!entry) return null;
    capabilities.delete(id);
    return entry;
  }

  function get(id) {
    return capabilities.get(id) || null;
  }

  function has(id) {
    return capabilities.has(id);
  }

  function list() {
    return [...capabilities.values()];
  }

  function ids() {
    return [...capabilities.keys()];
  }

  // Resolving an effector is deliberately a registry-internal operation. It
  // throws rather than returning null for an unknown effector: a capability
  // pointing at a nonexistent effector is a wiring error that must fail loudly
  // at execution, not degrade into a silent no-op that would look like success
  // in the transaction log.
  function resolveEffector(capabilityId) {
    const cap = capabilities.get(capabilityId);
    if (!cap) throw new AppError(Codes.VALIDATION_ERROR, `unknown capability: ${capabilityId}`);
    const impl = effectors.get(cap.effector);
    if (!impl) throw new Error(`capability "${capabilityId}" names undefined effector "${cap.effector}"`);
    return impl;
  }

  // Referential integrity check, used by the capability-removal test to prove
  // "no orphaned references" without the test itself knowing the internals.
  // Returns capabilities whose effector no longer exists, and effectors no
  // capability points at.
  function danglingReferences() {
    const missingEffectors = [];
    for (const cap of capabilities.values()) {
      if (!effectors.has(cap.effector)) missingEffectors.push({ capability: cap.id, effector: cap.effector });
    }
    const referenced = new Set([...capabilities.values()].map((c) => c.effector));
    const unreferencedEffectors = [...effectors.keys()].filter((e) => !referenced.has(e));
    return { missingEffectors, unreferencedEffectors };
  }

  return { define, remove, get, has, list, ids, defineEffector, resolveEffector, danglingReferences };
}

module.exports = { createRegistry };
