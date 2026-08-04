// Slice 0 — the operator plane, over HTTP.
//
// These are the ONLY routes that can alter governance state, and every one of
// them requires owner authentication. That is what closes the loopback hole:
// a shell agent on this host can still reach the port, but it has no token,
// so it cannot amend the Constitution or bind an agent to a workspace.
//
// Every route audits. Refusals audit too — an unauthenticated probe that left
// no trace would make an attacker invisible, which is exactly the property an
// attacker wants.

const ownerAuth = require('./ownerAuth');
const constitution = require('./constitution');
const agentBindingStore = require('./agentBindingStore');
const governedExecution = require('./governedExecution');
const { ownerActor, actorFromRequest } = require('./actor');
const { AppError, Codes } = require('./errors');

function registerGovernanceRoutes(app, { eventLog, sendError, store }) {
  // Wraps a handler so owner authentication is proven BEFORE the handler runs,
  // and so a refusal is audited with the unauthenticated caller's own actor —
  // which is the record that shows who was probing.
  const ownerOnly = (action, handler) => (req, res) => {
    try {
      ownerAuth.assertOwner(req);
    } catch (err) {
      eventLog.record({
        actor: actorFromRequest(req),
        action: 'governance.unauthorized_attempt',
        entityType: 'governance',
        entityId: null,
        details: { attemptedAction: action, path: req.originalUrl, method: req.method },
        flagged: true,
        flagReason: `unauthenticated attempt at owner-only action: ${action}`,
      });
      return sendError(res, err, req);
    }
    try {
      return handler(req, res, ownerActor(req));
    } catch (err) {
      return sendError(res, err, req);
    }
  };

  // ---- Constitution ----------------------------------------------------

  // Readable without a token on purpose: the rules governing agents are not a
  // secret, and an operator (or a reviewer) being able to see what is enforced
  // without holding the amendment credential is the desirable direction.
  // Amendment is the privileged act, not inspection.
  app.get('/api/governance/constitution', (req, res) => {
    try {
      const activeConstitution = constitution.active();
      const compiled = constitution.compile(activeConstitution);
      res.json({
        version: activeConstitution.version,
        id: activeConstitution.id,
        genesis: activeConstitution.genesis,
        rules: activeConstitution.rules,
        amendedBy: activeConstitution.amendedBy,
        amendedAt: activeConstitution.amendedAt,
        quarantinedProviders: [...compiled.quarantinedProviders],
        workspaceRequired: compiled.workspaceRequired,
        integrity: constitution.verifyIntegrity(),
        // Said in the payload itself so no client can render this as more than
        // it is. Slice 1 is what makes production execution governed.
        enforcementScope: 'governed execution admission only — agentManager.start() is NOT yet routed through the kernel, so no production agent run is governed by this Constitution today',
      });
    } catch (err) {
      sendError(res, err, req);
    }
  });

  app.get('/api/governance/constitution/history', (req, res) => {
    try {
      res.json({ history: constitution.history(), integrity: constitution.verifyIntegrity() });
    } catch (err) {
      sendError(res, err, req);
    }
  });

  app.post('/api/governance/constitution/amend', ownerOnly('constitution.amend', (req, res, actor) => {
    const { rules, reason, expectedPriorId } = req.body || {};
    const result = constitution.amend({ rules, actor, reason: reason || null, expectedPriorId });
    res.status(201).json(result);
  }));

  // ---- Executable-agent bindings ---------------------------------------

  app.get('/api/governance/bindings', (req, res) => {
    try {
      // ORPHAN DETECTION. A binding whose agent has been deleted must never be
      // invisible: the binding store and the executable-agent registry are two
      // stores, and two stores drift. Admission already fails closed for a
      // missing agent (the route 404s before admit() runs), but "fails closed"
      // and "the operator can see the inconsistency" are different properties,
      // and only the second lets it be cleaned up.
      const bindings = agentBindingStore.list().map((b) => ({
        ...b,
        orphaned: store.get(b.agentId) === null || store.get(b.agentId) === undefined,
      }));
      res.json({ bindings, orphanedCount: bindings.filter((b) => b.orphaned).length });
    } catch (err) {
      sendError(res, err, req);
    }
  });

  app.post('/api/governance/agents/:id/binding', ownerOnly('agent.bind', (req, res, actor) => {
    const agent = store.get(req.params.id);
    if (!agent) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
    const { workspaceId, capabilities } = req.body || {};
    const row = agentBindingStore.bind(req.params.id, { workspaceId, capabilities: capabilities || [], actor });
    eventLog.record({
      actor,
      action: 'governance.agent_bound',
      entityType: 'agent',
      entityId: req.params.id,
      details: { workspaceId: row.workspaceId, capabilities: row.capabilities },
    });
    res.status(201).json(row);
  }));

  app.delete('/api/governance/agents/:id/binding', ownerOnly('agent.unbind', (req, res, actor) => {
    const removed = agentBindingStore.unbind(req.params.id, { actor });
    if (!removed) throw new AppError(Codes.NOT_FOUND, 'no binding for that agent', 404);
    eventLog.record({
      actor,
      action: 'governance.agent_unbound',
      entityType: 'agent',
      entityId: req.params.id,
      details: { workspaceId: removed.workspaceId },
    });
    res.json({ unbound: removed });
  }));

  // ---- Governed-execution admission check ------------------------------
  //
  // Readable without a token: it reports whether an agent WOULD be admitted.
  // It executes nothing. Every refusal is audited, so a caller probing which
  // agents are runnable leaves a trail.
  app.get('/api/governance/agents/:id/admission', (req, res) => {
    try {
      const agent = store.get(req.params.id);
      if (!agent) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
      const decision = governedExecution.admit({ agent });
      if (!decision.ok) {
        eventLog.record({
          actor: actorFromRequest(req),
          action: 'governance.admission_denied',
          entityType: 'agent',
          entityId: agent.id,
          details: { code: decision.code, ruleId: decision.ruleId, reason: decision.reason, provider: agent.provider },
          flagged: true,
          flagReason: `governed execution refused: ${decision.ruleId}`,
        });
      }
      res.json({
        agentId: agent.id,
        provider: agent.provider,
        ...decision,
        note: 'admission decision only — this endpoint never executes anything, and agentManager.start() does not consult it yet (Slice 1)',
      });
    } catch (err) {
      sendError(res, err, req);
    }
  });
}

module.exports = { registerGovernanceRoutes };
