// Phase 9 — the Constitution Kernel.
//
// One execution path. Every action an agent performs is a Capability
// Transaction that walks the stage list in src/kernel/stages.js, in order,
// with no stage skippable and no effect reachable except through a handle
// this module mints.
//
// SCOPE HONESTY: this is the REFERENCE kernel. The pipeline, the ordering
// guarantees, the reservation semantics, the record-before-effect rule and
// the cross-cutting machinery are real and are what the harness verifies.
// The constitution evaluator and the grant ledger are injected, and the
// effectors are supplied by the caller — in Slice 0/1 those become the real
// ones. Nothing here should be described as governing production agents until
// agentManager is routed through it.

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const { STAGES, stagesBeforeEffect } = require('./stages');
const { createTransactionLog } = require('./transactionLog');
const { createReservationLedger } = require('./reservations');

// The bypass tripwire. This is a DETECTOR, not the authorization mechanism.
// Authorization is the handle: code without a handle has no reference to an
// effector and cannot act. ALS is here to catch the case where someone finds
// a way to hold an effector anyway — it then throws and leaves an artifact.
//
// The split matters. A design that AUTHORIZED on ALS would deny legitimate
// work whenever context is lost across an async boundary (a real hazard with
// some native callbacks). Here, legitimate work always carries the handle, so
// ALS loss can only weaken detection, never break correctness, and a missing
// context means deny — the safe direction.
const transactionContext = new AsyncLocalStorage();

function currentTransaction() {
  return transactionContext.getStore() || null;
}

function assertInTransaction(what = 'effector') {
  const ctx = currentTransaction();
  if (!ctx) {
    const err = new Error(`${what} invoked outside a kernel transaction — refusing`);
    err.code = 'KERNEL_BYPASS';
    throw err;
  }
  return ctx;
}

const ALLOW = 'allow';
const DENY = 'deny';

function createKernel({
  logFilePath,
  registry,
  // (tx) -> { effect: 'allow'|'deny', ruleId, reason }
  constitution = { id: 'null-constitution', evaluate: () => ({ effect: ALLOW, ruleId: 'default_allow', reason: 'no rules configured' }) },
  // (subject) -> { chainHead, capabilities: Set|Array }
  grants = { head: () => 'empty', capabilitiesFor: () => [] },
  capUsd = null,
  maxConcurrentPerWorkspace = 8,
  maxTransactionsPerSession = 64,
  maxDelegationDepth = 4,
  onEvent = () => {},
  // TEST ONLY. Wraps a stage so the harness can inject a fault at it. The
  // production boot path must never pass this; test/kernel/noProductionHooks
  // .test.js asserts that by reading server.js.
  __stageOverrides = null,
} = {}) {
  const log = createTransactionLog({ filePath: logFilePath });
  const opened = log.open();
  const reservations = createReservationLedger({ capUsd });

  const metrics = { executed: 0, denied: 0, failed: 0, byCapability: Object.create(null) };
  const activeByWorkspace = new Map();
  const sessions = new Map(); // sessionId -> { count, transactions: [] }
  // Independent observation surface for the harness: what the EFFECTORS saw,
  // recorded by the kernel at the call boundary rather than by the effector
  // itself, so a lying effector cannot hide a call.
  const effectorCalls = [];
  // Transactions whose terminal seal could not be written. An artifact, not a
  // counter: it is what the deterministic-rollback invariant consults to tell
  // "the log broke and said so" apart from "the kernel skipped sealing".
  const sealFailures = [];

  function bump(name, capability) {
    metrics[name] += 1;
    const perCap = (metrics.byCapability[capability] = metrics.byCapability[capability] || { executed: 0, denied: 0, failed: 0 });
    perCap[name] += 1;
  }

  // ---- stage implementations -------------------------------------------
  // Each is (ctx) => void|Promise<void>. A stage denies by calling ctx.deny().
  // A stage that throws aborts the authorize/effect phases; settle phases
  // still run. No stage may call an effector except `execute`.

  const stageImpls = {
    identity(ctx) {
      const initiator = ctx.intent.initiator || null;
      if (!initiator || !initiator.actorType) {
        ctx.deny('identity.missing', 'no initiator supplied');
        return;
      }
      // There is no authentication in this system (docs/PHASE9_ARCHITECTURE.md
      // F4). `assurance` records that honestly rather than letting a field that
      // looks like identity imply an assurance nothing provides.
      ctx.identity = {
        actorType: initiator.actorType,
        actorId: initiator.actorId ?? null,
        assurance: initiator.assurance || 'none',
      };
    },

    workspace(ctx) {
      const workspaceId = ctx.intent.workspaceId;
      if (!workspaceId) {
        ctx.deny('workspace.missing', 'no workspace supplied');
        return;
      }
      ctx.workspaceId = workspaceId;
      // From here the workspace is BOUND. The handle minted at `execute`
      // closes over this value and exposes no way to change it, so isolation
      // is a shape rather than a check — there is no argument to get wrong.
    },

    constitution(ctx) {
      ctx.constitutionId = constitution.id;
      const verdict = constitution.evaluate({
        capability: ctx.intent.capability,
        workspaceId: ctx.workspaceId,
        identity: ctx.identity,
        args: ctx.intent.args,
      });
      if (!verdict || verdict.effect === DENY) {
        ctx.deny(verdict?.ruleId || 'constitution.deny', verdict?.reason || 'denied by constitution');
        return;
      }
      ctx.ruleId = verdict.ruleId;
    },

    permissions(ctx) {
      const cap = registry.get(ctx.intent.capability);
      if (!cap) {
        // A removed capability must refuse execution. This is the observable
        // the capability-removal acceptance test asserts on.
        ctx.deny('capability.unknown', `capability "${ctx.intent.capability}" is not registered`);
        return;
      }
      ctx.capability = cap;
      ctx.grantChainHead = grants.head({ workspaceId: ctx.workspaceId, agentId: ctx.identity.actorId });
      const granted = grants.capabilitiesFor({ workspaceId: ctx.workspaceId, agentId: ctx.identity.actorId }) || [];
      const set = granted instanceof Set ? granted : new Set(granted);
      if (!set.has(cap.id)) {
        ctx.deny('permission.not_granted', `capability "${cap.id}" is not granted in this workspace`);
      }
    },

    ratelimit(ctx) {
      const active = activeByWorkspace.get(ctx.workspaceId) || 0;
      if (active >= maxConcurrentPerWorkspace) {
        // Admission control REFUSES rather than queues. An unbounded queue
        // turns overload into an invisible latency failure: work is accepted
        // and never runs. A refusal is a recorded transaction, so the artifact
        // shows what was turned away.
        ctx.deny('ratelimit.saturated', `workspace at concurrency limit (${active}/${maxConcurrentPerWorkspace})`);
        return;
      }
      activeByWorkspace.set(ctx.workspaceId, active + 1);
      ctx.admitted = true;
    },

    loop(ctx) {
      const session = sessions.get(ctx.sessionId) || { count: 0, transactions: [] };
      sessions.set(ctx.sessionId, session);
      if (session.count >= maxTransactionsPerSession) {
        ctx.deny('loop.transaction_budget', `session exceeded ${maxTransactionsPerSession} transactions`);
        return;
      }
      if (ctx.depth > maxDelegationDepth) {
        ctx.deny('loop.depth', `delegation depth ${ctx.depth} exceeds ${maxDelegationDepth}`);
        return;
      }
      // Cycle detection walks the ancestor chain rather than consulting a
      // counter — the tree is the artifact, and a counter could disagree with
      // what actually happened.
      const signature = `${ctx.identity.actorId}:${ctx.intent.capability}`;
      let cursor = ctx.parentTxId;
      const byId = new Map(session.transactions.map((t) => [t.txId, t]));
      while (cursor) {
        const ancestor = byId.get(cursor);
        if (!ancestor) break;
        if (ancestor.signature === signature) {
          ctx.deny('loop.cycle', `cycle detected: ${signature} already appears in this ancestry`);
          return;
        }
        cursor = ancestor.parentTxId;
      }
      session.count += 1;
      session.transactions.push({ txId: ctx.txId, parentTxId: ctx.parentTxId, signature });
      ctx.loopIteration = session.count;
    },

    budget(ctx) {
      // `Number(x) || 0` turns NaN and "abc" into 0, which would let a metered
      // capability run as if free while costBounded still read true. Decide
      // usability explicitly instead of coercing.
      const declared = ctx.capability.maxCostUsd;
      const declaredUsable = typeof declared === 'number' && Number.isFinite(declared) && declared >= 0;
      const bound = ctx.capability.budgetClass === 'metered' && declaredUsable ? declared : 0;
      const res = reservations.reserve({ txId: ctx.txId, sessionId: ctx.sessionId, amountUsd: bound });
      if (!res.ok) {
        ctx.deny('budget.cap_reached', res.reason);
        return;
      }
      ctx.reservationId = res.reservationId;
      ctx.reservedUsd = res.amountUsd;
      // An unbounded metered capability reserves zero, but the fact is recorded
      // rather than silently treated as free.
      // A metered capability is "bounded" only when its declared maximum is a
      // usable number. Absent (null) or unusable (NaN, Infinity, a string,
      // negative) both mean the artifact must NOT claim the cost is bounded.
      ctx.costBounded = ctx.capability.budgetClass !== 'metered' ? true : declaredUsable;
    },

    record(ctx) {
      // THE central invariant: the transaction is durable BEFORE the effect.
      // If this throws (a sealed or unwritable log), the loop below aborts and
      // `execute` never runs. If it cannot be recorded, it does not happen.
      const rec = log.append({
        txId: ctx.txId,
        parentTxId: ctx.parentTxId,
        sessionId: ctx.sessionId,
        seq: ctx.seq,
        depth: ctx.depth,
        ts: Date.now(),
        state: 'recorded',
        capability: ctx.intent.capability,
        workspaceId: ctx.workspaceId,
        constitutionId: ctx.constitutionId,
        grantChainHead: ctx.grantChainHead,
        identity: ctx.identity,
        decision: ALLOW,
        ruleId: ctx.ruleId,
        reservationId: ctx.reservationId,
        reservedUsd: ctx.reservedUsd,
        costBounded: ctx.costBounded,
        loopIteration: ctx.loopIteration,
      });
      ctx.recordedHash = rec.recordHash;
    },

    async execute(ctx) {
      const impl = registry.resolveEffector(ctx.capability.id);
      // The handle. It closes over the transaction and the workspace and
      // exposes no way to change either. An effector cannot ask for a
      // different workspace because there is no parameter for one.
      const handle = {
        txId: ctx.txId,
        workspaceId: ctx.workspaceId,
        capability: ctx.capability.id,
        signal: ctx.abortSignal,
      };
      // Recorded by the KERNEL at the call boundary, not by the effector, so
      // an effector cannot conceal that it ran. The log snapshot is read from
      // the log file itself, giving the record-before-effect invariant an
      // observation independent of the kernel's own bookkeeping.
      effectorCalls.push({
        txId: ctx.txId,
        capability: ctx.capability.id,
        workspaceId: ctx.workspaceId,
        at: Date.now(),
        logSnapshotAtCall: log.readAll().map((r) => ({ txId: r.txId, state: r.state })),
      });
      const result = await transactionContext.run(handle, () => impl(ctx.intent.args, handle));
      ctx.result = result === undefined ? null : result;
      ctx.actualCostUsd = (result && typeof result.costUsd === 'number') ? result.costUsd : 0;
    },

    settle(ctx) {
      if (ctx.reservationId) {
        const actual = ctx.actualCostUsd || 0;
        // A settle above the reserved bound means the effector broke its
        // declared contract. The kernel cannot stop that after the fact, but
        // it must never absorb it silently: an under-declaring capability
        // would otherwise erode the cap invisibly, one call at a time.
        const overrun = Math.max(0, actual - (ctx.reservedUsd || 0));
        if (overrun > 0) {
          ctx.costOverrunUsd = overrun;
          onEvent({ type: 'kernel.cost_overrun', txId: ctx.txId, capability: ctx.intent.capability, reservedUsd: ctx.reservedUsd, actualUsd: actual, overrunUsd: overrun });
        }
        reservations.settle(ctx.reservationId, actual);
        ctx.reservationId = null;
      }
      if (ctx.admitted) {
        const active = activeByWorkspace.get(ctx.workspaceId) || 0;
        activeByWorkspace.set(ctx.workspaceId, Math.max(0, active - 1));
        ctx.admitted = false;
      }
    },

    audit(ctx) {
      const state = ctx.decision === DENY ? 'denied' : ctx.error ? 'failed' : 'settled';
      const terminal = {
        txId: ctx.txId,
        parentTxId: ctx.parentTxId,
        sessionId: ctx.sessionId,
        seq: ctx.seq,
        depth: ctx.depth,
        ts: Date.now(),
        state,
        terminal: true,
        capability: ctx.intent.capability,
        workspaceId: ctx.workspaceId ?? null,
        constitutionId: ctx.constitutionId ?? null,
        grantChainHead: ctx.grantChainHead ?? null,
        identity: ctx.identity ?? null,
        decision: ctx.decision,
        ruleId: ctx.ruleId ?? null,
        reason: ctx.reason ?? null,
        reservedUsd: ctx.reservedUsd ?? null,
        actualCostUsd: ctx.actualCostUsd ?? null,
        costOverrunUsd: ctx.costOverrunUsd ?? null,
        costBounded: ctx.costBounded ?? null,
        loopIteration: ctx.loopIteration ?? null,
        error: ctx.error ? String(ctx.error.message || ctx.error) : null,
        stagesReached: ctx.stagesReached,
      };
      try {
        log.append(terminal);
        ctx.sealed = true;
      } catch (err) {
        // The log is unwritable. We cannot seal. Surface it rather than
        // pretending the transaction completed cleanly.
        ctx.sealError = err;
      }
      if (state === 'denied') bump('denied', ctx.intent.capability);
      else if (state === 'failed') bump('failed', ctx.intent.capability);
      else bump('executed', ctx.intent.capability);
      onEvent({ type: 'kernel.transaction', record: terminal });
    },
  };

  // Every stage applies AT MOST ONCE per transaction.
  //
  // Found by fault injection, not by review: injecting a `retry` fault at each
  // stage produced four independent defects — ratelimit took two admission
  // slots and released one, budget took two reservations and settled one,
  // execute invoked the effector twice under a single authorization, and audit
  // wrote two terminal records. Every one of those is a real inconsistency an
  // ordinary retry (a framework re-dispatch, a supervisor replay, a caller's
  // own retry loop) would produce in production.
  //
  // Guarding centrally rather than patching the four stages is deliberate: the
  // property is structural and belongs to the pipeline, so a stage added later
  // inherits it instead of having to remember it. No stage in this design has
  // a legitimate reason to apply twice within one transaction.
  //
  // The override receives the GUARDED base, so a fault that re-invokes a stage
  // exercises the guard — which is what makes the fault matrix the proof that
  // this works.
  function onceGuard(id, impl) {
    return async (ctx) => {
      if (!ctx.__applied) ctx.__applied = new Set();
      if (ctx.__applied.has(id)) return undefined;
      ctx.__applied.add(id);
      return impl(ctx);
    };
  }

  function stageFn(id) {
    const base = onceGuard(id, stageImpls[id]);
    if (!__stageOverrides || !__stageOverrides[id]) return base;
    return __stageOverrides[id](base);
  }

  // ---- the pipeline ------------------------------------------------------

  async function execute(intent, { sessionId = null, parentTxId = null, depth = 0, signal = null } = {}) {
    const ctx = {
      txId: crypto.randomUUID(),
      sessionId: sessionId || crypto.randomUUID(),
      parentTxId,
      depth,
      seq: 0,
      intent,
      abortSignal: signal,
      decision: ALLOW,
      ruleId: null,
      reason: null,
      error: null,
      stagesReached: [],
      admitted: false,
      reservationId: null,
      deny(ruleId, reason) {
        this.decision = DENY;
        this.ruleId = ruleId;
        this.reason = reason;
      },
    };

    const settleStages = STAGES.filter((s) => s.phase === 'settle').map((s) => s.id);
    const forwardStages = STAGES.filter((s) => s.phase !== 'settle').map((s) => s.id);

    try {
      for (const id of forwardStages) {
        if (ctx.decision === DENY) break;
        if (ctx.abortSignal && ctx.abortSignal.aborted) {
          ctx.deny('cancelled', 'transaction cancelled before this stage');
          break;
        }
        ctx.stagesReached.push(id);
        await stageFn(id)(ctx);
      }
    } catch (err) {
      ctx.error = err;
    }

    // Settle stages ALWAYS run, on every path: success, denial, throw,
    // cancellation. Each is individually guarded so a failure in one cannot
    // prevent the other — a settle that throws must not be able to skip the
    // audit seal, which is how orphaned reservations and unsealed transactions
    // are born.
    for (const id of settleStages) {
      ctx.stagesReached.push(id);
      try {
        await stageFn(id)(ctx);
      } catch (err) {
        ctx.settleErrors = ctx.settleErrors || [];
        ctx.settleErrors.push({ stage: id, message: String(err.message || err) });
        // A failed SEAL cannot be silent. Found by fault injection: with the
        // audit stage faulted, a transaction could be recorded and executed and
        // then never sealed, leaving the trail with a permanent hole and no
        // signal anywhere. The kernel cannot force the log to become writable,
        // but it can guarantee the gap is DECLARED — out of band, through the
        // structured-event channel, so an operator surface can show it.
        //
        // This is deliberately not a way to opt out of sealing: it requires an
        // actual throw from the audit stage. A kernel that skips sealing
        // quietly emits nothing and is still caught.
        if (id === 'audit') {
          sealFailures.push({ txId: ctx.txId, reason: String(err.message || err) });
          onEvent({ type: 'kernel.seal_failed', txId: ctx.txId, reason: String(err.message || err) });
        }
        // Best-effort compensation: if `settle` itself failed, the reservation
        // is still held. Release it directly so a stage bug cannot leak budget.
        if (id === 'settle' && ctx.reservationId) {
          reservations.settle(ctx.reservationId, ctx.actualCostUsd || 0);
          ctx.reservationId = null;
        }
        if (id === 'settle' && ctx.admitted) {
          const active = activeByWorkspace.get(ctx.workspaceId) || 0;
          activeByWorkspace.set(ctx.workspaceId, Math.max(0, active - 1));
          ctx.admitted = false;
        }
      }
    }

    return {
      txId: ctx.txId,
      sessionId: ctx.sessionId,
      decision: ctx.decision,
      ruleId: ctx.ruleId,
      reason: ctx.reason,
      result: ctx.result ?? null,
      error: ctx.error ? String(ctx.error.message || ctx.error) : null,
      sealed: Boolean(ctx.sealed),
      stagesReached: ctx.stagesReached,
    };
  }

  return {
    execute,
    // --- observation surfaces for the harness. All of these read real
    // artifacts (the log file, the reservation ledger, the call boundary);
    // none of them report the kernel's belief about itself.
    log,
    reservations,
    metrics,
    effectorCalls,
    sealFailures,
    opened,
    activeCount: (workspaceId) => activeByWorkspace.get(workspaceId) || 0,
    sessionTransactions: (sessionId) => (sessions.get(sessionId) || { transactions: [] }).transactions,
  };
}

module.exports = { createKernel, currentTransaction, assertInTransaction, transactionContext, ALLOW, DENY };
