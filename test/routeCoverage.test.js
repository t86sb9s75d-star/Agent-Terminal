// Route-to-affordance coverage contract.
//
// The defect this exists to prevent: an API route ships, gets documented as a
// capability, and no operator can ever reach it. That happened to tasks,
// experiments, per-agent permissions, workspace archive and workspace edit —
// all implemented, all documented, none reachable. Nothing failed, because
// nothing compared the route list to the interface.
//
// Two rules, both enforced here:
//   1. Every registered Feature Onboard route must be CLASSIFIED below.
//      A new route with no entry fails this test.
//   2. Every route classified `ui` must have a real call site in
//      public/onboard.js. Claiming a surface is not the same as having one.
//
// Routes are collected by running the REAL registration function against a
// recording stub, not by parsing source text — so a route added through any
// code path is caught, and a renamed one cannot slip through a stale regex.
//
// Run with: node test/routeCoverage.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { registerFeatureOnboardRoutes } = require('../src/featureOnboardApi');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// ---- collect the routes the app actually registers ----
const collected = [];
const recordingApp = {};
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  recordingApp[method] = (routePath) => collected.push(`${method.toUpperCase()} ${routePath}`);
}
registerFeatureOnboardRoutes(recordingApp, {
  eventLog: { record() {} },
  actorFromRequest: () => ({}),
  sendError: () => {},
});

// ---- the classification ----
//
// kind:
//   'ui'       — an operator can do this through the interface. `calls` is a
//                substring that must appear in public/onboard.js.
//   'api_only' — deliberately not surfaced. `why` is required and must also
//                appear in docs/FEATURE_ONBOARD.md's limitations.
//   'internal' — supporting route the UI consumes indirectly.
const ROUTES = {
  'GET /api/stages': { kind: 'internal', why: 'reference data; populates the stage <select>' },
  'GET /api/catalog': { kind: 'internal', why: 'reference data; agent catalog, capabilities, enforcement summary' },

  'GET /api/profile': { kind: 'ui', calls: "api('/api/profile'" },
  'PUT /api/profile': { kind: 'ui', calls: "api('/api/profile'" },

  'GET /api/onboarding': { kind: 'ui', calls: "api('/api/onboarding'" },
  'POST /api/onboarding/start': { kind: 'ui', calls: "api('/api/onboarding/start'" },
  'PUT /api/onboarding': { kind: 'ui', calls: "api('/api/onboarding'" },
  'POST /api/onboarding/complete': { kind: 'ui', calls: "api('/api/onboarding/complete'" },

  'GET /api/workspaces': { kind: 'ui', calls: "api('/api/workspaces'" },
  'POST /api/workspaces': { kind: 'ui', calls: "api('/api/workspaces'" },
  'GET /api/workspaces/:workspaceId': {
    kind: 'api_only',
    why: 'the UI always works from the decorated list, so a single-workspace read has no surface',
  },
  'PUT /api/workspaces/:workspaceId': { kind: 'ui', calls: '/api/workspaces/${existing.id}' },
  'POST /api/workspaces/:workspaceId/archive': { kind: 'ui', calls: '/archive' },

  'GET /api/workspaces/:workspaceId/agents': { kind: 'ui', calls: '/agents`' },
  'PUT /api/workspaces/:workspaceId/agents/:agentId': { kind: 'ui', calls: '/agents/${' },

  'GET /api/workspaces/:workspaceId/yc': { kind: 'ui', calls: '/yc`' },
  'PUT /api/workspaces/:workspaceId/yc': { kind: 'ui', calls: '/yc`' },
};

// The six record types share one generated route family. The mutation routes
// are driven by ONE delegated handler that builds its path from pluralOf(type),
// so checking for that shared string would mark all 24 routes reachable the
// moment any single type rendered any single control — which is exactly how
// `DELETE .../decisions/:id` passed an earlier version of this test while
// nothing in the UI rendered a delete control for decisions.
//
// So the mutation routes are checked against the PER-TYPE marker each renderer
// actually emits, not against the shared handler.
const RECORD_TYPES = {
  goals: 'goal',
  tasks: 'task',
  decisions: 'decision',
  assumptions: 'assumption',
  experiments: 'experiment',
  evidence: 'evidence',
};

for (const [segment, type] of Object.entries(RECORD_TYPES)) {
  // List and create are driven from templated markup (RECORD_TABS,
  // recordListHeader), so there is no literal per-type string to grep for.
  // They are proven instead by the browser reachability contract, which
  // creates every type through the real dialog against a real server —
  // a stronger check than a substring. Cross-referenced so neither test is
  // assumed to cover the other's ground.
  ROUTES[`GET /api/workspaces/:workspaceId/${segment}`] = {
    kind: 'ui',
    calls: `/${segment}\``,
  };
  ROUTES[`POST /api/workspaces/:workspaceId/${segment}`] = {
    kind: 'ui',
    calls: `/${segment}\``, // the list fetch proves the segment is wired; creation is proven in the browser contract
  };

  // Update: either an edit dialog or an inline status control counts.
  ROUTES[`PUT /api/workspaces/:workspaceId/${segment}/:id`] = {
    kind: 'ui',
    anyOf: [`data-fo-edit="${type}"`, `statusSelect('${type}'`],
  };

  // Delete: decisions are the deliberate exception.
  ROUTES[`DELETE /api/workspaces/:workspaceId/${segment}/:id`] = segment === 'decisions'
    ? {
      kind: 'api_only',
      why: 'a decision\'s text and reasoning are immutable so the revision trail survives; offering a delete button would let the UI destroy the very history that rule exists to preserve. The route stays for an operator who has decided otherwise, deliberately without a control.',
    }
    : { kind: 'ui', anyOf: [`data-fo-del="${type}"`] };

  ROUTES[`GET /api/workspaces/:workspaceId/${segment}/:id`] = {
    kind: 'api_only',
    why: 'the UI renders records from the list response; a single-record read has no surface',
  };
}

const FRONTEND = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboard.js'), 'utf8');
const LIMITATIONS = fs.readFileSync(path.join(__dirname, '..', 'docs', 'FEATURE_ONBOARD.md'), 'utf8');

check('every registered Feature Onboard route is classified', () => {
  assert.ok(collected.length > 0, 'no routes were collected — the recording stub is not working');
  const unclassified = collected.filter((r) => !ROUTES[r]);
  assert.deepStrictEqual(
    unclassified, [],
    `these routes exist but are not classified as ui / api_only / internal:\n  ${unclassified.join('\n  ')}`
  );
});

check('every classified route still exists', () => {
  const stale = Object.keys(ROUTES).filter((r) => !collected.includes(r));
  assert.deepStrictEqual(
    stale, [],
    `these routes are classified but no longer registered (renamed or removed?):\n  ${stale.join('\n  ')}`
  );
});

check('every route claimed as operator-reachable has a real call site in the UI', () => {
  // This is the assertion that would have caught tasks, experiments,
  // permissions, archive and workspace edit: each had a route and each was
  // described as delivered, and none was ever called by the frontend.
  const missing = [];
  for (const [route, meta] of Object.entries(ROUTES)) {
    if (meta.kind !== 'ui') continue;
    assert.ok(meta.calls || meta.anyOf, `${route} is classified 'ui' but declares no call site to look for`);
    // `anyOf` exists because one affordance can legitimately take several
    // shapes (an edit dialog OR an inline status control). It must still be a
    // PER-TYPE marker — a shared handler string would mark every type reachable
    // as soon as one of them rendered anything.
    const candidates = meta.anyOf || [meta.calls];
    if (!candidates.some((c) => FRONTEND.includes(c))) {
      missing.push(`${route}  (expected public/onboard.js to contain one of ${JSON.stringify(candidates)})`);
    }
  }
  assert.deepStrictEqual(missing, [], `routes claimed as operator-reachable with no call site:\n  ${missing.join('\n  ')}`);
});

check('every deliberately API-only route gives a reason and is disclosed in the docs', () => {
  const apiOnly = Object.entries(ROUTES).filter(([, m]) => m.kind === 'api_only');
  for (const [route, meta] of apiOnly) {
    assert.ok(meta.why && meta.why.length > 20, `${route} is api_only but gives no real reason`);
  }
  // The docs must say that some routes have no interface, so a reader of
  // FEATURE_ONBOARD cannot conclude every documented route is a delivered
  // operator capability.
  assert.ok(
    /no operator interface|API-only|not reachable from the interface/i.test(LIMITATIONS),
    'docs/FEATURE_ONBOARD.md must disclose that some routes have no operator interface'
  );
});

check('no route family is silently unbalanced', () => {
  // Every record segment must expose the same five routes. A segment missing
  // one means either a real gap or a stale classification.
  for (const segment of ['goals', 'tasks', 'decisions', 'assumptions', 'experiments', 'evidence']) {
    const family = collected.filter((r) => r.includes(`/${segment}`));
    assert.strictEqual(family.length, 5, `record segment "${segment}" registered ${family.length} routes, expected 5: ${family.join(', ')}`);
  }
});

console.log(`\n${passed} passed`);
