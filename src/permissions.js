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

// enforcement values:
//   'enforced'   — a real code path checks this before the action happens.
//   'preference' — stored and displayed, but nothing consults it yet. The UI
//                  must label these as "planned", never "blocked"/"protected".
//
// consequential: actions that should default to requiring approval because
// they spend money, touch the outside world, or are hard to undo. This drives
// the conservative default in defaultPermissionsFor().
const CAPABILITIES = [
  { key: 'read_workspace_data', label: 'Read workspace data', consequential: false, enforcement: 'preference' },
  { key: 'write_workspace_data', label: 'Write workspace data', consequential: false, enforcement: 'preference' },
  { key: 'create_tasks', label: 'Create tasks', consequential: false, enforcement: 'preference' },
  { key: 'modify_tasks', label: 'Modify tasks', consequential: false, enforcement: 'preference' },
  { key: 'read_files', label: 'Read files', consequential: false, enforcement: 'preference' },
  { key: 'edit_files', label: 'Edit files', consequential: true, enforcement: 'preference' },
  { key: 'run_commands', label: 'Run commands', consequential: true, enforcement: 'preference' },
  // The custom-provider trust boundary and the budget caps ARE real code
  // paths today (workers/custom.js + budget.js). These two are the honest
  // 'enforced' entries: an agent's run is actually gated on the spending caps
  // before a paid provider is contacted, and custom commands actually execute
  // through the documented trusted-operator boundary.
  { key: 'use_custom_provider', label: 'Use custom (shell) provider', consequential: true, enforcement: 'enforced' },
  { key: 'access_network', label: 'Access network services', consequential: true, enforcement: 'preference' },
  { key: 'contact_people', label: 'Contact external people', consequential: true, enforcement: 'preference' },
  { key: 'spend_money', label: 'Spend money', consequential: true, enforcement: 'enforced' },
  { key: 'paid_model_calls', label: 'Make paid model calls', consequential: true, enforcement: 'enforced' },
  { key: 'act_without_approval', label: 'Act without approval', consequential: true, enforcement: 'preference' },
];

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

// Whether a capability, if granted, would still require per-action approval
// under the conservative model. Consequential capabilities are "grantable but
// approval-gated by default"; this is what the UI uses to show the right
// warning, and what a future enforcement layer will consult.
function requiresApproval(key) {
  return CONSEQUENTIAL_KEYS.includes(key);
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CONSEQUENTIAL_KEYS,
  isValidCapability,
  defaultPermissionsFor,
  normalizePermissions,
  requiresApproval,
};
