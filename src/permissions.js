// Feature Onboard — agent capability/permission vocabulary.
//
// This module defines WHAT permissions exist, their safe defaults, and — most
// importantly — an honest statement of whether each one is actually enforced
// in code today versus merely stored as a preference for later enforcement.
//
// The hard rule (from the Feature Onboard handoff): never describe a
// permission as "blocked" or "protected" unless it is enforced in code. Most
// of these are, in Phase 1, STORED PREFERENCES ONLY — recorded per workspace,
// surfaced in the UI, and available to future enforcement, but not yet
// gating anything. The `enforcement` field below is the single source of
// truth for that distinction, and the UI/docs must read it rather than
// assuming.

// THE MOST IMPORTANT FACT ON THIS SCREEN, established by reading every call
// site rather than by assuming: NO stored permission value on any agent, in
// any workspace, is consulted by the runtime today. Not one of the thirteen.
//
// That is stronger than the earlier framing of "three are enforced". What is
// true is that three capabilities have a RELATED SYSTEM-LEVEL CONTROL which
// runs regardless of this setting:
//
//   budget.assertWithinBudget() is called unconditionally before every run
//   (src/agentManager.js) and reads the configured daily caps — it never
//   looks at spend_money or paid_model_calls for this agent or workspace.
//
//   src/workers/custom.js applies its trusted-operator boundary and
//   minimalEnv() to every custom run — it never looks at use_custom_provider.
//
// So turning any of the thirteen off changes what is RECORDED, and nothing
// else, for all thirteen. Saying "three are enforced" invites the operator to
// believe those three toggles do something. They do not.
//
// enforcement values — read by the UI and the docs, never restated by them:
//   'system_control' — a real, always-on control governs this action. Named
//                      in enforcementPoint. It is NOT gated on this setting.
//   'recorded_only'  — nothing anywhere consults it.
//
// gatedByStoredValue is deliberately present, deliberately false everywhere,
// and deliberately per-capability: the day a real gate is written for one
// capability, this flips for that one alone and the UI changes with it.
//
// consequential: actions that spend money, touch the outside world, or are
// hard to undo. It drives the least-authority default below. It does NOT mean
// "approval-gated" — no approval mechanism exists anywhere in this system.
const CAPABILITIES = [
  { key: 'read_workspace_data', label: 'Read workspace data', consequential: false, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'write_workspace_data', label: 'Write workspace data', consequential: false, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'create_tasks', label: 'Create tasks', consequential: false, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'modify_tasks', label: 'Modify tasks', consequential: false, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'read_files', label: 'Read files', consequential: false, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'edit_files', label: 'Edit files', consequential: true, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'run_commands', label: 'Run commands', consequential: true, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  {
    key: 'use_custom_provider',
    label: 'Use custom (shell) provider',
    consequential: true,
    enforcement: 'system_control',
    enforcementPoint: 'src/workers/custom.js — trusted-operator boundary and minimalEnv(), applied to every custom run',
    gatedByStoredValue: false,
  },
  { key: 'access_network', label: 'Access network services', consequential: true, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  { key: 'contact_people', label: 'Contact external people', consequential: true, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
  {
    key: 'spend_money',
    label: 'Spend money',
    consequential: true,
    enforcement: 'system_control',
    enforcementPoint: 'src/budget.js — daily spending caps, checked before every paid run',
    gatedByStoredValue: false,
  },
  {
    key: 'paid_model_calls',
    label: 'Make paid model calls',
    consequential: true,
    enforcement: 'system_control',
    enforcementPoint: 'src/budget.js — daily spending caps, checked before every paid run',
    gatedByStoredValue: false,
  },
  { key: 'act_without_approval', label: 'Act without approval', consequential: true, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },
];

// One sentence the UI and docs both render verbatim, so the claim cannot
// drift between them. If a real gate is ever written, this must change with it.
const RUNTIME_ENFORCEMENT_SUMMARY =
  'No setting on this screen is consulted by the runtime. Changing one changes what is recorded, not what an agent can do.';

const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key);
const CONSEQUENTIAL_KEYS = CAPABILITIES.filter((c) => c.consequential).map((c) => c.key);

function isValidCapability(key) {
  return CAPABILITY_KEYS.includes(key);
}

// Least-authority default: every consequential capability is OFF, every
// non-consequential one is ON. An operator can widen this per agent, but the
// out-of-the-box posture never grants a money-spending or outside-world
// action without an explicit opt-in.
function defaultPermissionsFor() {
  const perms = {};
  for (const cap of CAPABILITIES) {
    perms[cap.key] = cap.consequential ? false : true;
  }
  return perms;
}

// Validate and normalize an operator-supplied permission map: unknown keys are
// rejected (so a typo can't silently create a permission that looks granted),
// missing keys fall back to the conservative default, and values are coerced
// to strict booleans.
function normalizePermissions(input) {
  const { AppError, Codes } = require('./errors');
  const out = defaultPermissionsFor();
  if (input === undefined || input === null) return out;
  if (typeof input !== 'object') {
    throw new AppError(Codes.VALIDATION_ERROR, 'permissions must be an object of capability -> boolean');
  }
  for (const [key, value] of Object.entries(input)) {
    if (!isValidCapability(key)) {
      throw new AppError(Codes.VALIDATION_ERROR, `unknown permission capability: ${key}`);
    }
    out[key] = Boolean(value);
  }
  return out;
}

// requiresApproval() used to live here. It returned CONSEQUENTIAL_KEYS
// membership under a name asserting an approval workflow, and its comment
// claimed "this is what the UI uses to show the right warning". Neither was
// true: it had no caller outside its own test, and no approval mechanism
// exists anywhere in this system. Removed rather than renamed — the concept
// itself is the thing that was misleading. Callers that want the underlying
// fact should read `consequential`, which only claims what it means.

function isConsequential(key) {
  return CONSEQUENTIAL_KEYS.includes(key);
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CONSEQUENTIAL_KEYS,
  RUNTIME_ENFORCEMENT_SUMMARY,
  isValidCapability,
  defaultPermissionsFor,
  normalizePermissions,
  isConsequential,
};
