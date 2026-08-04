// Slice 0 — the governed-execution admission gate.
//
// SCOPE HONESTY, and this is the most important sentence in the file:
// agentManager.start() is NOT routed through this yet. Nothing an operator
// starts today passes through here. This gate exists, is enforced, and is
// tested — but it governs the GOVERNED path, and Slice 1 is what makes the
// production path use it. Until then, no production agent is runtime-governed,
// and no document, PR, or report may say otherwise.
//
// What this DOES provide now: a single function that answers "may this agent
// execute under governance, and with what authority?" — fail-closed on every
// missing piece, auditing every refusal, and refusing the shell provider
// outright.

const { Codes } = require('./errors');
const constitution = require('./constitution');
const agentBindingStore = require('./agentBindingStore');

// Providers a governed agent may select. `custom` is deliberately ABSENT.
//
// Decision 3: a real shell has filesystem, process and network access and can
// operate outside an in-process Node kernel entirely. No in-process guard makes
// that safe, and this file must never be described as making shell bypass
// impossible — it makes shell SELECTION refused, which is a different and much
// smaller claim. The shell returns to governed scope only behind OS-level
// isolation, restricted filesystem and network access, scoped credentials,
// quotas, process-tree termination, complete transaction-bound auditing,
// escape tests, and explicit owner authorization.
//
// The quarantine is ALSO expressed as a Constitution rule (GENESIS_RULES), so
// it is enforced twice by independent mechanisms: this allowlist, and the
// compiled root Constitution. Removing either alone still leaves the provider
// refused, and a test proves each one independently.
const GOVERNED_PROVIDERS = ['anthropic', 'openai'];

function isGovernedProvider(provider) {
  return GOVERNED_PROVIDERS.includes(provider);
}

// Decide whether an agent may execute under governance.
//
// Returns { ok, ... } rather than throwing so the caller can audit the refusal
// with its specific reason before responding. Every refusal names WHY, because
// "denied" with no reason is an operator support ticket rather than an answer.
function admit({ agent, compiledConstitution = null }) {
  const compiled = compiledConstitution || constitution.compile();

  if (!agent || !agent.id) {
    return { ok: false, code: Codes.GOVERNANCE_CONTEXT_MISSING, ruleId: 'governance.no_agent', reason: 'no agent supplied' };
  }

  // 1. Provider quarantine — checked FIRST, before any binding lookup, so a
  //    quarantined provider is refused even for a perfectly bound agent.
  if (!isGovernedProvider(agent.provider)) {
    return {
      ok: false,
      code: Codes.PROVIDER_QUARANTINED,
      ruleId: 'governance.provider_not_governed',
      reason: `provider "${agent.provider}" is not available to governed agents (governed providers: ${GOVERNED_PROVIDERS.join(', ')})`,
    };
  }

  // 2. Binding — fail closed. No synthetic workspace, no inference from
  //    workstreamId, no silent migration.
  const context = agentBindingStore.resolveContext(agent.id);
  if (!context.ok) {
    return { ok: false, code: context.code, ruleId: 'governance.unbound_agent', reason: context.reason, migrationPath: context.migrationPath };
  }

  // 3. The root Constitution, evaluated at runtime.
  const verdict = compiled.evaluate({
    capability: 'agent.run',
    workspaceId: context.workspaceId,
    provider: agent.provider,
  });
  if (verdict.effect === 'deny') {
    return { ok: false, code: Codes.POLICY_BLOCKED, ruleId: verdict.ruleId, reason: verdict.reason };
  }

  return {
    ok: true,
    workspaceId: context.workspaceId,
    capabilities: context.capabilities,
    constitutionId: compiled.id,
    constitutionVersion: compiled.version,
  };
}

module.exports = { admit, isGovernedProvider, GOVERNED_PROVIDERS };
