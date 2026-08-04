// Stable, structured errors (Phase 8.1). Every user-facing error the API
// returns should be one of these — never a raw JS exception message, which
// can leak internal implementation details (e.g. "data.name.trim is not a
// function") instead of a clean, documented error code.

class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

const Codes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  WORKSTREAM_NOT_FOUND: 'WORKSTREAM_NOT_FOUND',
  WORKSTREAM_ARCHIVED: 'WORKSTREAM_ARCHIVED',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  RUN_ALREADY_ACTIVE: 'RUN_ALREADY_ACTIVE',
  RUN_NOT_ACTIVE: 'RUN_NOT_ACTIVE',
  BUDGET_LIMIT_REACHED: 'BUDGET_LIMIT_REACHED',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
  STORE_CORRUPT: 'STORE_CORRUPT',
  STORE_DEGRADED: 'STORE_DEGRADED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  // Slice 0 — governance actions require owner authentication.
  UNAUTHORIZED: 'UNAUTHORIZED',
  // A governed agent lacks the authoritative context it must have to execute:
  // no workspace binding, no capability grant, or no active Constitution.
  // Distinct from VALIDATION_ERROR because the request is well-formed — it is
  // the authorization context that is absent, and it fails CLOSED.
  GOVERNANCE_CONTEXT_MISSING: 'GOVERNANCE_CONTEXT_MISSING',
  // The requested provider is quarantined from governed execution.
  PROVIDER_QUARANTINED: 'PROVIDER_QUARANTINED',
};

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(Codes.VALIDATION_ERROR, `${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AppError(Codes.VALIDATION_ERROR, `${fieldName} must be a string`);
  }
  return value;
}

// The ONE contract for every optional operator-supplied date in the system
// (workspace targetDate, goal targetDate, assumption reviewDate). It lives
// here beside requireString/optionalString because having two date contracts
// in one repository is exactly how goal.targetDate ended up accepting objects
// while workspace.targetDate rejected them.
//
// Deliberately stricter than a bare Date.parse() check, in TWO ways, because
// Date.parse is wrong here in two different directions:
//
//   1. It is too permissive about shape. Date.parse('garbage 2024') === valid,
//      as are '5' and '0'. So `!Number.isNaN(Date.parse(v))` is not a date
//      validator, it is a "contains something date-ish" validator. Hence the
//      ISO shape check — exactly what <input type="date"> emits.
//
//   2. It SILENTLY ROLLS OVER impossible calendar dates. Date.parse of
//      '2026-02-31' succeeds and yields March 3rd; '2026-04-31' yields May 1st;
//      '2026-02-29' in a non-leap year yields March 1st. Shape plus parse would
//      therefore accept a date and store a string that means a different day
//      than the one written. (Found in live-runtime verification: the API
//      returned 201 for 2026-02-31 while this comment claimed it did not.)
//      Hence the round-trip check below.
//
//   undefined  -> `fallback` (field omitted: keep whatever is already stored)
//   null | ''  -> null       (the two ways the API/UI say "clear this")
//   ISO string -> the original string, stored verbatim so no timezone
//                 re-serialization surprise is introduced
//   anything else -> AppError(VALIDATION_ERROR), never a raw TypeError
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

// Does the calendar agree that this Y-M-D exists? Build the date in UTC and
// require it to come back out unchanged — a rollover changes the day, or the
// month, or both, so this catches every impossible date without a leap-year
// table of our own.
function isRealCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function optionalDate(value, fieldName, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;

  const reject = () => {
    throw new AppError(
      Codes.VALIDATION_ERROR,
      `${fieldName} must be an ISO date (YYYY-MM-DD), an ISO date-time, or null to clear it`
    );
  };

  if (typeof value !== 'string') reject();
  const m = ISO_DATE.exec(value);
  if (!m || Number.isNaN(Date.parse(value))) reject();
  if (!isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) reject();
  return value;
}

module.exports = { AppError, Codes, requireString, optionalString, optionalDate };
