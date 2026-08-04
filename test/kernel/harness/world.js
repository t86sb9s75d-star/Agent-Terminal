// Phase 9 — HARNESS LAYER: the world builder.
//
// Builds a kernel over a throwaway data directory with a fixture registry,
// constitution and grant source. Every knob a scenario needs is a parameter,
// so a test never reaches inside the kernel to set something up — reaching
// inside is how a test ends up asserting what the implementation happens to
// do instead of what it must do.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createKernel, assertInTransaction } = require('../../../src/kernel/kernel');
const { createRegistry } = require('../../../src/kernel/registry');
const { observe } = require('./adapter');

// Every world ever built, so none can leak. A test that fails mid-scenario
// never reaches its own cleanup() call, and the temp dirs pile up in /tmp —
// the same class of harness hygiene failure as Phase 8's A-008, where an
// orphaned headless browser produced false failures in later runs. Registering
// an exit hook makes cleanup unconditional instead of dependent on the happy
// path, exactly as the mutation harness there ended up doing.
const LIVE_WORLDS = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const sweep = () => {
    for (const dir of LIVE_WORLDS) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    LIVE_WORLDS.clear();
  };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { sweep(); process.exit(1); });
  }
}

const WORKSPACE_A = 'ws-alpha';
const WORKSPACE_B = 'ws-beta';
const ALL_WORKSPACES = [WORKSPACE_A, WORKSPACE_B];

const AGENT = { actorType: 'agent', actorId: 'agent-1', assurance: 'none' };
const OPERATOR = { actorType: 'human_operator', actorId: 'operator-1', assurance: 'none' };

// The negative capability. Registered so it is fully reachable through the
// normal path — an UNregistered capability would prove nothing, since lookup
// would refuse it before authorization ever ran.
//
// Deliberately GRANTED, and denied by the constitution instead. Making it
// merely ungranted would have meant every kernel that executed it also tripped
// no_permission_leakage, so the two invariants could never be falsified
// independently. Denying it at the constitution layer — the layer a grant
// cannot widen — makes this a sharp probe of constitution enforcement
// specifically. If it ever executes, the kernel has failed; no further
// analysis is required.
const FORBIDDEN = 'fixture.forbidden';

// Registered but never granted, so the permission layer has something to
// refuse that is not the negative capability.
const UNGRANTED = 'fixture.ungranted';

const DEFAULT_CAPABILITIES = [
  { id: 'fixture.act', effector: 'fixture', budgetClass: 'none' },
  { id: 'fixture.metered', effector: 'fixture', budgetClass: 'metered', maxCostUsd: 0.25 },
  { id: FORBIDDEN, effector: 'fixture', budgetClass: 'none', consequential: true },
  { id: UNGRANTED, effector: 'fixture', budgetClass: 'none', consequential: true },
];

function buildWorld({
  capabilities = DEFAULT_CAPABILITIES,
  effectorBehavior = null,
  // Default grant deliberately EXCLUDES the forbidden capability.
  grantedCapabilities = null,
  constitutionVerdict = null,
  capUsd = null,
  maxConcurrentPerWorkspace = 8,
  maxTransactionsPerSession = 64,
  maxDelegationDepth = 4,
  __stageOverrides = null,
} = {}) {
  installExitHook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-kernel-'));
  LIVE_WORLDS.add(dir);
  const registry = createRegistry();

  registry.defineEffector('fixture', async (args, handle) => {
    // The bypass tripwire, exercised the way a real effector must use it: a
    // call that arrives without a live transaction context is refused and
    // leaves an error naming the reason. Authorization is still the handle —
    // this catches the case where someone obtains an effector anyway.
    assertInTransaction('fixture effector');
    if (effectorBehavior) return effectorBehavior(args, handle);
    return { ok: true, costUsd: 0 };
  });

  for (const cap of capabilities) registry.define(cap);

  // FORBIDDEN is granted on purpose (see above); UNGRANTED is not.
  const granted = grantedCapabilities === null
    ? capabilities.map((c) => c.id).filter((id) => id !== UNGRANTED)
    : grantedCapabilities;

  const events = [];
  const kernel = createKernel({
    logFilePath: path.join(dir, 'transactions.jsonl'),
    registry,
    constitution: {
      id: 'fixture-constitution-v1',
      evaluate: (tx) => {
        // The negative capability is denied here, at the constitution, and
        // this rule is unconditional — no grant, argument, or caller can widen
        // past it.
        if (tx.capability === FORBIDDEN) {
          return { effect: 'deny', ruleId: 'fixture.forbidden_always', reason: 'this capability is categorically forbidden' };
        }
        return constitutionVerdict
          ? constitutionVerdict(tx)
          : { effect: 'allow', ruleId: 'fixture.allow', reason: 'fixture allows all' };
      },
    },
    grants: { head: () => 'fixture-grant-head-1', capabilitiesFor: () => granted },
    capUsd,
    maxConcurrentPerWorkspace,
    maxTransactionsPerSession,
    maxDelegationDepth,
    onEvent: (e) => events.push(e),
    __stageOverrides,
  });

  return {
    dir,
    kernel,
    registry,
    events,
    granted,
    logFilePath: path.join(dir, 'transactions.jsonl'),
    cleanup: () => { LIVE_WORLDS.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); },
    intent: (over = {}) => ({
      capability: 'fixture.act',
      workspaceId: WORKSPACE_A,
      initiator: AGENT,
      args: { hello: 'world' },
      ...over,
    }),
    // Produce the ObservationBundle the specification consumes.
    observe: () => observe(kernel, {
      workspaces: ALL_WORKSPACES,
      grantedCapabilities: granted,
      forbiddenCapabilities: [FORBIDDEN],
    }),
  };
}

module.exports = { buildWorld, WORKSPACE_A, WORKSPACE_B, ALL_WORKSPACES, AGENT, OPERATOR, FORBIDDEN, UNGRANTED, DEFAULT_CAPABILITIES };
