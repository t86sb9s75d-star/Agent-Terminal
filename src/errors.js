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
// Deliberately stricter than a bare Date.parse() check. Date.parse accepts
// 'garbage 2024', '5' and '0' — so `!Number.isNaN(Date.parse(v))` is not a
// date validator, it is a "contains something date-ish" validator. The
// contract here is an ISO-8601 calendar date (exactly what <input type="date">
// emits), optionally followed by a time component, and it must also be a real
// calendar date — the shape check alone would let 2026-02-31 through.
//
//   undefined  -> `fallback` (field omitted: keep whatever is already stored)
//   null | ''  -> null       (the two ways the API/UI say "clear this")
//   ISO string -> the original string, stored verbatim so no timezone
//                 re-serialization surprise is introduced
//   anything else -> AppError(VALIDATION_ERROR), never a raw TypeError
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function optionalDate(value, fieldName, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AppError(
      Codes.VALIDATION_ERROR,
      `${fieldName} must be an ISO date (YYYY-MM-DD), an ISO date-time, or null to clear it`
    );
  }
  return value;
}

module.exports = { AppError, Codes, requireString, optionalString, optionalDate };
