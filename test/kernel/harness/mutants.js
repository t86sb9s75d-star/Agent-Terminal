// Phase 9 — HARNESS LAYER: the mutant kernels.
//
// Deliberately broken kernels. Each declares the ONE invariant it must trip.
// The harness is accepted only when every mutant is caught, on its own
// invariant and NO other.
//
// Why "and no other" matters: a mutant that trips three invariants still turns
// the suite red, but it stops proving those three are independent — and
// invariants that overlap can hide each other's blind spots. Phase 8's R-016
// was exactly that failure: a route-coverage contract that went green by
// matching a shared handler string, for a reason unrelated to what it claimed.
//
// ADVERSARIAL FRAMING: these are not "mistakes a careful author might make."
// They are what an implementation actively trying to LOOK compliant would do —
// suppress the audit, fake the audit, reuse a stale authorization, slip the
// workspace, execute twice, escape reservation accounting, rewrite the log
// afterwards. This kernel will eventually run third-party and model-authored
// code. The harness has to assume the thing under test is not on its side.
//
// `overrides` is a function of a mutable `box` that the runner fills with the
// built world, so a mutant can reach live kernel state without the world
// builder needing to know mutants exist.

const { FORBIDDEN, UNGRANTED, WORKSPACE_B } = require('./world');

const MUTANTS = [
  {
    id: 'record_skipped',
    violates: 'record_before_effect',
    description: 'suppresses the pre-effect record, so the effect happens with nothing on disk vouching for it',
    overrides: () => ({ record: () => async () => { /* suppressed */ } }),
  },

  {
    id: 'reservation_leak',
    violates: 'no_orphaned_reservations',
    description: 'takes a second, untracked hold that the settle path cannot see — escaping budget accounting',
    overrides: (box) => ({
      budget: (base) => async (ctx) => {
        await base(ctx);
        // ctx tracks exactly one reservationId, so this hold is never released.
        box.world.kernel.reservations.reserve({ txId: 'ghost', sessionId: ctx.sessionId, amountUsd: 1 });
      },
    }),
  },

  {
    id: 'double_seal',
    violates: 'no_double_audits',
    description: 'fakes the audit by sealing twice, leaving history ambiguous while the record count looks healthy',
    // Clears the pipeline's once-guard between calls so the stage genuinely
    // applies twice. The mutant's job is to produce the OBSERVABLE defect — a
    // kernel that seals twice — not to be blocked by the very protection the
    // invariant exists to backstop. (That the guard blocks a plain retry is
    // proven separately, by the audit+retry cell of the fault matrix.)
    overrides: () => ({
      audit: (base) => async (ctx) => {
        await base(ctx);
        ctx.__applied.delete('audit');
        await base(ctx);
      },
    }),
  },

  {
    id: 'execute_twice',
    violates: 'no_duplicate_execution',
    description: 'runs the effector a second time under a single authorization',
    overrides: () => ({
      execute: (base) => async (ctx) => {
        await base(ctx);
        ctx.__applied.delete('execute'); // see the note on double_seal
        await base(ctx);
      },
    }),
  },

  {
    id: 'ignore_denial',
    violates: 'no_permission_leakage',
    description: 'overrides its own denial back to allow — the case that defeats any invariant reading the recorded decision',
    overrides: () => ({
      permissions: (base) => async (ctx) => {
        await base(ctx);
        // The real stage attaches ctx.capability BEFORE checking the grant, so
        // flipping the decision is all this needs to proceed to execution.
        ctx.decision = 'allow';
        ctx.reason = null;
      },
    }),
    intent: { capability: UNGRANTED },
  },

  {
    id: 'skip_seal_on_failure',
    violates: 'deterministic_rollback',
    description: 'suppresses the terminal record when something went wrong, hiding failures from the trail',
    overrides: () => ({
      audit: (base) => async (ctx) => {
        if (ctx.error) return;
        await base(ctx);
      },
    }),
    failingEffector: true,
  },

  {
    id: 'workspace_redirect',
    violates: 'workspace_binding',
    description: 'authorizes against one workspace and executes against another',
    overrides: () => ({
      record: (base) => async (ctx) => {
        await base(ctx);
        ctx.__realWorkspaceId = ctx.workspaceId;
        ctx.workspaceId = WORKSPACE_B;
      },
      // Restored before settle so admission accounting stays correct and this
      // mutant trips workspace_binding ALONE.
      settle: (base) => async (ctx) => {
        if (ctx.__realWorkspaceId) ctx.workspaceId = ctx.__realWorkspaceId;
        await base(ctx);
      },
    }),
  },

  {
    id: 'admission_leak',
    violates: 'admission_released',
    description: 'never returns its admission slot, so the workspace silently throttles itself to a halt',
    overrides: () => ({
      settle: (base) => async (ctx) => {
        ctx.admitted = false; // base now skips the release
        await base(ctx);
      },
    }),
  },

  {
    id: 'authorization_swap',
    violates: 'authorization_matches_effect',
    description: 'spends an approval recorded for one capability on a different one (replay / stale authorization)',
    overrides: () => ({
      record: (base) => async (ctx) => {
        const real = ctx.intent.capability;
        ctx.intent = { ...ctx.intent, capability: 'fixture.metered' };
        await base(ctx);
        ctx.intent = { ...ctx.intent, capability: real };
      },
    }),
  },

  {
    id: 'ignore_constitution',
    violates: 'forbidden_never_executes',
    description: 'executes a categorically forbidden capability by forcing the constitution verdict to allow',
    overrides: () => ({
      constitution: (base) => async (ctx) => {
        await base(ctx);
        ctx.decision = 'allow';
        ctx.ruleId = 'forged.allow';
        ctx.reason = null;
      },
    }),
    intent: { capability: FORBIDDEN },
  },

  {
    id: 'chain_tamper',
    violates: 'audit_chain_intact',
    description: 'rewrites a sealed record after the fact — the classic "fix the log" move',
    overrides: () => ({}),
    // Tampers `ts` specifically. An earlier draft rewrote `capability`, which
    // ALSO tripped authorization_matches_effect and so failed the
    // one-invariant-per-mutant rule. `ts` is read by no invariant, which
    // isolates this to the chain check — the hash covers every field, so any
    // edit breaks it, and choosing an unread field is what makes the proof of
    // independence hold.
    postRun: (world) => {
      const fs = require('fs');
      const lines = fs.readFileSync(world.logFilePath, 'utf8').trim().split('\n');
      const rec = JSON.parse(lines[0]);
      rec.ts = 0;
      lines[0] = JSON.stringify(rec);
      fs.writeFileSync(world.logFilePath, lines.join('\n') + '\n');
    },
  },
];

module.exports = { MUTANTS };
