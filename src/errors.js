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

module.exports = { AppError, Codes, requireString, optionalString };
