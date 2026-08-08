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

// Render an offending value briefly enough for an error message, and without
// letting a huge or exotic payload dominate the response.
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const t = typeof value;
  if (t === 'object') return 'an object';
  if (t === 'string') {
    const shown = value.length > 20 ? `${value.slice(0, 20)}…` : value;
    return `the string "${shown}"`;
  }
  if (t === 'number' || t === 'bigint' || t === 'boolean') return `the ${t} ${String(value)}`;
  return `a ${t}`;
}

// Validate and normalize an operator-supplied permission map.
//
// VALUES MUST BE LITERAL BOOLEANS. This used to be `Boolean(value)`, and a
// permission boundary is the wrong place for JavaScript truthiness. Measured
// through the HTTP API before this was changed, every one of these was stored
// as a GRANT of a consequential capability that defaults to false:
//
//   "false" -> true      "0" -> true       [] -> true        {} -> true
//   [false] -> true      " " -> true       -1 -> true        1.5 -> true
//
// The direction of failure is what makes it unacceptable: a caller trying to
// REVOKE by sending the string "false" GRANTED instead. Coercion cannot
// distinguish "the client serialised a boolean as a string" from "the client
// sent garbage", and guessing in the permissive direction on an authority
// boundary is the wrong default. Malformed values now fail closed.
//
// No stored permission is consulted by the runtime today (see the note at the
// top of this file), so this was not a live authorization bypass — it was a
// boundary that would have become one the moment these values started
// governing execution.
//
// Unknown keys are still rejected, so a typo cannot silently create something
// that looks granted, and missing keys still fall back to the conservative
// default — see the FULL-REPLACEMENT note in workspaceAgentSettingsStore.
function normalizePermissions(input) {
  const { AppError, Codes } = require('./errors');
  const out = defaultPermissionsFor();
  if (input === undefined || input === null) return out;
  // Arrays are objects; without this an array's indices become "keys" and the
  // caller is told `unknown permission capability: 0`, which describes the
  // symptom rather than the mistake.
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'permissions must be an object of capability -> boolean');
  }
  for (const [key, value] of Object.entries(input)) {
    if (!isValidCapability(key)) {
      throw new AppError(Codes.VALIDATION_ERROR, `unknown permission capability: ${key}`);
    }
    if (value !== true && value !== false) {
      throw new AppError(
        Codes.VALIDATION_ERROR,
        `permission "${key}" must be true or false, not ${describeValue(value)}. ` +
        'Permission values are not coerced: "false", "0", [] and {} are all truthy in JavaScript, ' +
        'so accepting them would silently grant authority a caller may have meant to withhold.'
      );
    }
    out[key] = value;
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
