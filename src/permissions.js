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

// THE CANONICAL EFFECTIVE-AUTHORITY RULE. One operation answers "given the
// current vocabulary and a persisted row, what authority is actually in
// effect?", and both the read path (GET .../agents) and the write path use it.
//
// There used to be two incompatible rules for the same question:
//   READ  an existing row -> the raw stored map, whatever keys it happened to have
//   WRITE an omitted key  -> defaultPermissionsFor()
// which is why a capability added to the vocabulary after a row was stored read
// as OFF, rendered unchecked, and then became ON the first time anything else
// was written. The operator saw one value and an unrelated write materialised
// another. That is the split this function exists to remove.
//
//   effective = defaults for the CURRENT vocabulary
//               overlaid with persisted values for keys still in the vocabulary
//
// Two consequences, both deliberate:
//   - a key the vocabulary no longer defines is IGNORED. It cannot linger as
//     ghost authority, and it cannot leak back out of a read and be echoed into
//     a write. (Measured before this: removing a capability made every
//     subsequent permission write fail 400, because the client faithfully sent
//     back the unknown key it had just been given.)
//   - a persisted value that is not a literal boolean falls back to the
//     capability's default rather than being coerced. Only a tampered store can
//     produce one; guessing permissively there is the same mistake as coercing
//     at the API boundary.
function resolveEffectivePermissions(stored) {
  const out = defaultPermissionsFor();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const cap of CAPABILITIES) {
    const v = stored[cap.key];
    if (v === true || v === false) out[cap.key] = v;
  }
  return out;
}

// Apply an operator-supplied permission PATCH to the current effective
// authority, validating every supplied value.
//
// PATCH, NOT REPLACEMENT — and this is the load-bearing decision. Under the
// previous full-replacement rule, any key the caller omitted was refilled from
// defaultPermissionsFor(). Five capabilities default to ON, so "omitted" did
// not mean "unchanged" and did not even mean "off": measured through the HTTP
// API at the CURRENT revision, sending { spend_money: true } alone flipped
// read_workspace_data from a deliberate false back to true (widening) and
// dropped a granted edit_files back to false (narrowing), with HTTP 200. The
// revision check could not help — that caller was not stale, it was complete
// and current. Omission now changes nothing.
//
// VALUES MUST BE LITERAL BOOLEANS. This used to be `Boolean(value)`, and a
// permission boundary is the wrong place for JavaScript truthiness. Measured
// before that changed, every one of these was stored as a GRANT of a
// consequential capability that defaults to false:
//
//   "false" -> true      "0" -> true       [] -> true        {} -> true
//   [false] -> true      " " -> true       -1 -> true        1.5 -> true
//
// A caller trying to REVOKE by sending the string "false" GRANTED instead.
//
// `null` is REFUSED rather than treated as "no opinion". A caller that wants to
// change nothing omits the field entirely (or sends {}); a caller that sends an
// explicit null has produced it by accident — from an unset variable or a
// serialiser — and before this it silently reset the whole map to defaults.
// Those two intents are not the same and must not share a code path.
function applyPermissionPatch(patch, currentEffective) {
  const { AppError, Codes } = require('./errors');
  const out = { ...resolveEffectivePermissions(currentEffective) };
  if (patch === null) {
    throw new AppError(
      Codes.VALIDATION_ERROR,
      'permissions must not be null. Omit the field to leave permissions unchanged, or send {} for an ' +
      'explicit no-op — a null used to reset every capability to its default, which silently granted ' +
      'the five that default to on.'
    );
  }
  if (patch === undefined) return out;
  // Arrays are objects; without this an array's indices become "keys" and the
  // caller is told `unknown permission capability: 0`, which describes the
  // symptom rather than the mistake.
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'permissions must be an object of capability -> boolean');
  }
  for (const [key, value] of Object.entries(patch)) {
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

// The authority delta between two EFFECTIVE permission maps.
//
// This exists so an audit record can say what actually changed. Before it, a
// permission write recorded only `{ enabled }` — measured on a real transition
// that granted edit_files, the audit evidence was `{"enabled":false}`, which
// names neither the capability nor its direction. An independent reviewer could
// not reconstruct the authority transition from the trail at all.
//
// GRANTED means false -> true and REVOKED means true -> false, so the direction
// is explicit rather than implied by a value the reader has to interpret.
// Together with the revision transition recorded alongside it, that is enough to
// replay the change without also duplicating the unchanged capabilities.
//
// Both sides are compared over the CURRENT vocabulary via
// resolveEffectivePermissions, so a key the vocabulary no longer defines cannot
// appear as a spurious revocation, and a newly added capability cannot appear as
// a spurious grant merely because an old row predates it.
//
// Order is sorted, so the same transition always serialises identically — a
// consumer diffing two records is comparing semantics, not key insertion order.
function diffPermissions(before, after) {
  const b = resolveEffectivePermissions(before);
  const a = resolveEffectivePermissions(after);
  const granted = [];
  const revoked = [];
  for (const cap of CAPABILITIES) {
    if (b[cap.key] === false && a[cap.key] === true) granted.push(cap.key);
    else if (b[cap.key] === true && a[cap.key] === false) revoked.push(cap.key);
  }
  granted.sort();
  revoked.sort();
  return { granted, revoked, changed: granted.length > 0 || revoked.length > 0 };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CONSEQUENTIAL_KEYS,
  RUNTIME_ENFORCEMENT_SUMMARY,
  isValidCapability,
  defaultPermissionsFor,
  resolveEffectivePermissions,
  applyPermissionPatch,
  diffPermissions,
  isConsequential,
};
