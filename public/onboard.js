// Feature Onboard — frontend (Business tab, YC tab, Settings, and the
// first-run onboarding wizard). Self-contained and loaded after app.js: it
// owns the #view-business / #view-yc / #view-settings sections and the
// onboarding overlay, and coordinates with app.js only through the shared nav
// rail (the two modules own disjoint view sets, so neither disturbs the other).
//
// SECURITY: every operator-controlled value is escaped before it reaches the
// DOM. There is no raw interpolation of names, titles, notes, or ids into
// innerHTML anywhere in this file — see esc()/attr() and their use at every
// interpolation site. This is the safe-rendering discipline the handoff
// requires for all new UI.
(() => {
  'use strict';

  // ---------- safe rendering + tiny helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  const attr = esc; // attribute context uses the same entity escaping
  const $ = (id) => document.getElementById(id);
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

  async function api(path, options) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json', 'X-Rucker-Client': 'rucker-dashboard' }, ...options });
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).error || message; } catch { /* ignore */ }
      throw new Error(message);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // ---------- state ----------
  const state = {
    view: null, // 'business' | 'yc' | 'settings' when one of ours is active
    stages: [],
    catalog: { agents: [], recommendations: {}, capabilities: [], runtimeEnforcementSummary: '' },
    openPermissions: null, // agent id whose permission list is expanded
    workspaces: [],
    activeWorkspaceId: null,
    records: {}, // { goals: [], tasks: [], decisions: [], assumptions: [], experiments: [], evidence: [] }
    loadError: null, // last workspace-detail load failure, rendered rather than swallowed
    yc: null,
    agents: { agents: [], recommended: [] },
    profile: null,
    onboarding: null,
    businessTab: 'command', // command | goals | decisions | assumptions | evidence | agents
  };

  // Every workspace-owned record type the backend defines must appear here
  // (or on the reviewed backend-only allowlist in the reachability contract —
  // test/frontend/featureOnboard.test.js). Tasks and experiments were absent
  // for a whole release: stores, validation, API routes and recovery
  // registration all existed, and an operator could not see them.
  const RECORD_TABS = [
    { id: 'command', label: 'Command Center' },
    { id: 'goals', label: 'Goals' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'assumptions', label: 'Assumptions & Risks' },
    { id: 'experiments', label: 'Experiments' },
    { id: 'evidence', label: 'Evidence' },
    { id: 'agents', label: 'Agents' },
  ];

  const STAGE_FALLBACK = 'problem_discovery';

  function activeWorkspace() {
    return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null;
  }
  function stageLabel(id) {
    const s = state.stages.find((x) => x.id === id);
    return s ? s.label : id;
  }

  // ---------- data loading ----------
  async function loadReference() {
    const [stages, catalog] = await Promise.all([api('/api/stages'), api('/api/catalog')]);
    state.stages = stages;
    state.catalog = catalog;
  }
  async function loadWorkspaces() {
    state.loadError = null;
    state.workspaces = await api('/api/workspaces');
    if (!state.activeWorkspaceId && state.workspaces.length) state.activeWorkspaceId = state.workspaces[0].id;
    if (state.activeWorkspaceId && !activeWorkspace()) state.activeWorkspaceId = state.workspaces[0]?.id || null;
  }
  // Monotonic token for workspace-detail loads. Without it, a slow load for a
  // workspace the operator has already navigated away from resolves later and
  // overwrites the current one — the selector reads Beta while the panel shows
  // Alpha's records. Eight parallel fetches per load makes that window wide,
  // and every reload path (workspace switch, permission toggle, status change,
  // record edit) goes through here. Capture on entry, discard on resolve if a
  // newer load has started or the operator has moved on.
  let detailLoadToken = 0;

  async function loadActiveWorkspaceDetail() {
    const id = state.activeWorkspaceId;
    const token = ++detailLoadToken;
    const superseded = () => token !== detailLoadToken || state.activeWorkspaceId !== id;
    state.loadError = null;
    if (!id) { state.records = {}; state.yc = null; state.agents = { agents: [], recommended: [] }; return; }
    try {
      const [goals, tasks, decisions, assumptions, experiments, evidence, yc, agents] = await Promise.all([
        api(`/api/workspaces/${id}/goals`),
        api(`/api/workspaces/${id}/tasks`),
        api(`/api/workspaces/${id}/decisions`),
        api(`/api/workspaces/${id}/assumptions`),
        api(`/api/workspaces/${id}/experiments`),
        api(`/api/workspaces/${id}/evidence`),
        api(`/api/workspaces/${id}/yc`),
        api(`/api/workspaces/${id}/agents`),
      ]);
      if (superseded()) return; // a newer load owns the state now
      state.records = { goals, tasks, decisions, assumptions, experiments, evidence };
      state.yc = yc;
      state.agents = agents;
    } catch (err) {
      // A superseded load must not report its failure either — otherwise a
      // slow 503 for an abandoned workspace blanks the workspace the operator
      // is actually looking at.
      if (superseded()) return;
      // A failed load must SAY so. Leaving the panel blank makes a degraded
      // store (503 STORE_DEGRADED) look identical to "you have no records
      // yet" — the operator would read a real integrity problem as an empty
      // workspace. The error state is rendered by errorBanner() below.
      state.loadError = err.message;
      state.records = {};
      state.yc = null;
      state.agents = { agents: [], recommended: [] };
    }
  }

  // ---------- generic UI bits ----------
  function empty(msg) { return `<div class="empty-state">${esc(msg)}</div>`; }

  // Distinct from empty(): "we could not load this" must never be shown as
  // "there is nothing here". role="alert" so it is announced, not just seen.
  function errorBanner(msg) {
    return `<div class="fo-error" role="alert">Could not load this workspace's records: ${esc(msg)}</div>`;
  }
  function pill(text, cls) { return `<span class="fo-pill ${cls || ''}">${esc(text)}</span>`; }

  // Accessible meter: shows a numeric value AND a text label so meaning is
  // never color-only, and exposes aria attributes for screen readers.
  function meter(label, value) {
    const known = value !== null && value !== undefined;
    const w = known ? Math.max(0, Math.min(100, value)) : 0;
    return `
      <div class="fo-meter" role="group" aria-label="${attr(label)}">
        <div class="fo-meter-head"><span>${esc(label)}</span><span class="fo-meter-val">${known ? pct(value) : 'Not measurable yet'}</span></div>
        <div class="fo-meter-track" role="progressbar" aria-valuenow="${known ? w : 0}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${attr(known ? pct(value) : 'not measurable yet')}">
          <div class="fo-meter-fill" style="width:${w}%"></div>
        </div>
      </div>`;
  }

  // =========================================================================
  //  BUSINESS VIEW
  // =========================================================================
  function renderBusiness() {
    const host = $('view-business');
    if (!host) return;
    // Checked BEFORE the empty case on purpose: when a load failed we have no
    // workspaces in state, and "no workspaces" and "could not read them" must
    // never render the same way.
    if (state.loadError) {
      host.innerHTML = `<div class="view-header"><h2 class="view-heading">Business</h2></div>${errorBanner(state.loadError)}`;
      return;
    }
    if (state.workspaces.length === 0) {
      host.innerHTML = `
        <div class="view-header"><h2 class="view-heading">Business</h2></div>
        ${empty('No workspaces yet. Create your first business workspace to begin.')}
        <div style="margin-top:16px;"><button class="btn btn-primary" data-fo="new-workspace">Create workspace</button></div>`;
      return;
    }
    const ws = activeWorkspace();
    const options = state.workspaces.map((w) =>
      `<option value="${attr(w.id)}" ${w.id === state.activeWorkspaceId ? 'selected' : ''}>${esc(w.name)}${w.archived ? ' (archived)' : ''}</option>`
    ).join('');

    const tabs = RECORD_TABS.map((t) =>
      `<button role="tab" aria-selected="${t.id === state.businessTab}" class="fo-tab ${t.id === state.businessTab ? 'active' : ''}" data-fo-tab="${attr(t.id)}">${esc(t.label)}</button>`
    ).join('');

    host.innerHTML = `
      <div class="view-header fo-business-header">
        <h2 class="view-heading">Business</h2>
        <div class="fo-ws-select">
          <label class="fo-inline-label" for="fo-workspace">Workspace</label>
          <select id="fo-workspace" aria-label="Active workspace">${options}</select>
          <button class="btn" data-fo="edit-workspace">Edit</button>
          <button class="btn" data-fo="toggle-archive">${ws && ws.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn" data-fo="new-workspace">+ New</button>
        </div>
      </div>
      ${ws && ws.archived ? `<div class="fo-archived-note" role="status">This workspace is archived. Its records are still readable and editable; archiving is a way to move it out of the way, not a lock.</div>` : ''}
      <div class="fo-tabs" role="tablist" aria-label="Workspace sections">${tabs}</div>
      <div class="fo-tabpanel" id="fo-business-panel" role="tabpanel">${renderBusinessPanel(ws)}</div>`;
  }

  function renderBusinessPanel(ws) {
    if (!ws) return empty('Select a workspace.');
    if (state.loadError) return errorBanner(state.loadError);
    switch (state.businessTab) {
      case 'command': return renderCommandCenter(ws);
      case 'goals': return renderGoals(ws);
      case 'tasks': return renderTasks(ws);
      case 'decisions': return renderDecisions(ws);
      case 'assumptions': return renderAssumptions(ws);
      case 'experiments': return renderExperiments(ws);
      case 'evidence': return renderEvidence(ws);
      case 'agents': return renderAgentsCatalog(ws);
      default: return '';
    }
  }

  function renderCommandCenter(ws) {
    const goals = state.records.goals || [];
    const openGoals = goals.filter((g) => g.status !== 'done' && g.status !== 'abandoned');
    const decisions = state.records.decisions || [];
    const assumptions = state.records.assumptions || [];
    const evidence = state.records.evidence || [];
    const wsProgress = ws.progress ? ws.progress.progress : null;
    const ycOverall = state.yc ? state.yc.overall : null;

    return `
      <div class="fo-cc-grid">
        <div class="fo-card fo-cc-primary">
          <p class="section-title">Active workspace</p>
          <h3 class="fo-cc-name">${esc(ws.name)}</h3>
          <p class="fo-cc-desc">${esc(ws.description || 'No description yet.')}</p>
          <div class="fo-cc-meta">
            ${pill(stageLabel(ws.stage), 'fo-pill-stage')}
            ${ws.primaryGoal ? pill(`Goal: ${ws.primaryGoal}`, '') : ''}
            ${ws.ycEnabled ? pill('YC track', 'fo-pill-yc') : ''}
          </div>
        </div>
        <div class="fo-card">
          ${meter('Business progress', wsProgress)}
          <div style="margin-top:12px;">${meter('YC readiness', ycOverall)}</div>
        </div>
      </div>

      <div class="fo-cc-cols">
        <div class="fo-card">
          <p class="section-title">Open goals (${openGoals.length})</p>
          ${openGoals.length === 0 ? empty('No open goals.') : `<ul class="attention-list">${openGoals.slice(0, 6).map((g) => `
            <li class="attention-item"><div class="body"><div class="title">${esc(g.title)}</div><div class="meta">${esc(g.status)}</div></div></li>`).join('')}</ul>`}
        </div>
        <div class="fo-card">
          <p class="section-title">Recent decisions (${decisions.length})</p>
          ${decisions.length === 0 ? empty('No decisions logged.') : `<ul class="attention-list">${decisions.slice(0, 5).map((d) => `
            <li class="attention-item"><div class="body"><div class="title">${esc(d.decision)}</div><div class="meta">${esc(d.status)}</div></div></li>`).join('')}</ul>`}
        </div>
      </div>

      <div class="fo-cc-counts">
        ${countCard('Goals', goals.length)}
        ${countCard('Decisions', decisions.length)}
        ${countCard('Assumptions & risks', assumptions.length)}
        ${countCard('Evidence', evidence.length)}
      </div>`;
  }
  function countCard(label, n) {
    return `<div class="fo-count"><div class="fo-count-n">${esc(String(n))}</div><div class="fo-count-l">${esc(label)}</div></div>`;
  }

  // ---- record list renderers (create + list; each escapes every field) ----

  function recordListHeader(title, addLabel, addType) {
    return `<div class="fo-list-head"><p class="section-title">${esc(title)}</p><button class="btn" data-fo-add="${attr(addType)}">${esc(addLabel)}</button></div>`;
  }

  function renderGoals(ws) {
    const goals = state.records.goals || [];
    return `${recordListHeader('Goals', '+ Add goal', 'goal')}
      ${goals.length === 0 ? empty('No goals yet.') : `<div class="fo-records">${goals.map((g) => `
        <div class="fo-record">
          <div class="fo-record-main"><span class="fo-record-title">${esc(g.title)}</span> ${pill(g.status, 'fo-pill-status')}</div>
          ${g.description ? `<div class="fo-record-sub">${esc(g.description)}</div>` : ''}
          <div class="fo-record-foot">${(g.milestones || []).length} milestone(s)${g.targetDate ? ` · target ${esc(g.targetDate)}` : ''}
            <button class="fo-edit" data-fo-edit="goal" data-id="${attr(g.id)}" aria-label="Edit goal ${attr(g.title)}">Edit</button>
            <button class="fo-del" data-fo-del="goal" data-id="${attr(g.id)}" aria-label="Delete goal ${attr(g.title)}">Delete</button></div>
        </div>`).join('')}</div>`}`;
  }

  // Reusable status <select>. Backed by a real PUT to the record's route, so
  // the control is not decorative — the lifecycle the backend defines is the
  // lifecycle the operator can actually move a record through.
  function statusSelect(type, id, current, statuses, label) {
    return `<select class="fo-inline-select" data-fo-status="${attr(type)}" data-id="${attr(id)}" aria-label="${attr(label)}">
      ${statuses.map((s) => `<option value="${attr(s)}" ${s === current ? 'selected' : ''}>${esc(s.replace(/_/g, ' '))}</option>`).join('')}
    </select>`;
  }

  // These mirror the vocabularies in src/workspaceRecordsStore.js. They are
  // restated here only because the browser has no import of that module; the
  // server rejects any value outside its own list, so a drift here surfaces as
  // a VALIDATION_ERROR rather than as silently-accepted bad data.
  const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'];
  const DECISION_STATUSES = ['proposed', 'accepted', 'rejected', 'reversed', 'superseded'];
  function renderTasks(ws) {
    const rows = state.records.tasks || [];
    const goals = state.records.goals || [];
    const goalName = (id) => (goals.find((g) => g.id === id) || {}).title;
    return `${recordListHeader('Tasks', '+ Add task', 'task')}
      <p class="fo-hint">Concrete work items. A task may optionally hang off a goal; tasks with no goal are ordinary standalone work, not orphans.</p>
      ${rows.length === 0 ? empty('No tasks yet.') : `<div class="fo-records">${rows.map((t) => `
        <div class="fo-record">
          <div class="fo-record-main"><span class="fo-record-title">${esc(t.title)}</span> ${pill(t.status.replace(/_/g, ' '), 'fo-pill-status')}</div>
          ${t.notes ? `<div class="fo-record-sub">${esc(t.notes)}</div>` : ''}
          <div class="fo-record-foot">
            ${statusSelect('task', t.id, t.status, TASK_STATUSES, `Status for task ${t.title}`)}
            ${t.goalId ? pill(`goal: ${goalName(t.goalId) || 'unknown'}`, '') : ''}
            <button class="fo-edit" data-fo-edit="task" data-id="${attr(t.id)}" aria-label="Edit task ${attr(t.title)}">Edit</button>
            <button class="fo-del" data-fo-del="task" data-id="${attr(t.id)}" aria-label="Delete task ${attr(t.title)}">Delete</button></div>
        </div>`).join('')}</div>`}`;
  }

  // Experiment Builder. The point of an experiment here is to test a named
  // assumption against thresholds decided BEFORE it runs — so the form asks
  // for the success and failure thresholds up front, and the list shows them
  // next to the result. Every field below exists in the backend schema; none
  // is invented, and nothing here schedules, executes or automates anything.
  const EXPERIMENT_STATUSES = ['planned', 'running', 'concluded', 'abandoned'];
  function renderExperiments(ws) {
    const rows = state.records.experiments || [];
    const assumptions = state.records.assumptions || [];
    const assumptionText = (id) => (assumptions.find((a) => a.id === id) || {}).statement;
    const detail = (label, value) => (value ? `<div class="fo-xp-row"><span class="fo-xp-l">${esc(label)}</span><span class="fo-xp-v">${esc(value)}</span></div>` : '');
    return `${recordListHeader('Experiments', '+ Design experiment', 'experiment')}
      <p class="fo-hint">Decide what would count as success <em>and</em> as failure before you run it. An experiment with no failure threshold cannot disconfirm anything.</p>
      ${rows.length === 0 ? empty('No experiments yet. Design one to test an assumption.') : `<div class="fo-records">${rows.map((x) => `
        <div class="fo-record fo-xp">
          <div class="fo-record-main"><span class="fo-record-title">${esc(x.title)}</span> ${pill(x.status, 'fo-pill-status')}</div>
          ${x.researchQuestion ? `<div class="fo-record-sub">${esc(x.researchQuestion)}</div>` : ''}
          <div class="fo-xp-detail">
            ${x.assumptionId ? detail('Tests assumption', assumptionText(x.assumptionId) || 'unknown assumption') : ''}
            ${detail('Method', x.method)}
            ${detail('Who', x.targetParticipant)}
            ${detail('Success if', x.successThreshold)}
            ${detail('Failure if', x.failureThreshold)}
            ${detail('Time limit', x.timeLimit)}
            ${detail('Cost limit', x.costLimit)}
            ${detail('Results', x.results)}
            ${detail('Conclusion', x.conclusion)}
            ${detail('Next decision', x.nextDecision)}
          </div>
          <div class="fo-record-foot">
            ${statusSelect('experiment', x.id, x.status, EXPERIMENT_STATUSES, `Status for experiment ${x.title}`)}
            <button class="fo-edit" data-fo-edit="experiment" data-id="${attr(x.id)}" aria-label="Edit experiment ${attr(x.title)}">Edit</button>
            <button class="fo-del" data-fo-del="experiment" data-id="${attr(x.id)}" aria-label="Delete experiment ${attr(x.title)}">Delete</button></div>
        </div>`).join('')}</div>`}`;
  }

  function renderDecisions(ws) {
    const decisions = state.records.decisions || [];
    return `${recordListHeader('Decision log', '+ Log decision', 'decision')}
      <p class="fo-hint">Decisions are immutable once written — record a new one rather than rewriting history. Only the status can change.</p>
      ${decisions.length === 0 ? empty('No decisions logged.') : `<div class="fo-records">${decisions.map((d) => `
        <div class="fo-record">
          <div class="fo-record-main"><span class="fo-record-title">${esc(d.decision)}</span> ${pill(d.status, 'fo-pill-status')}</div>
          ${d.reasoning ? `<div class="fo-record-sub">${esc(d.reasoning)}</div>` : ''}
          <div class="fo-record-foot">
            ${statusSelect('decision', d.id, d.status, DECISION_STATUSES, `Status for decision ${d.decision}`)}
          </div>
        </div>`).join('')}</div>`}`;
  }

  function renderAssumptions(ws) {
    const rows = state.records.assumptions || [];
    return `${recordListHeader('Assumptions & risks', '+ Add', 'assumption')}
      <p class="fo-hint">Confidence and status are tracked separately — a strongly-held belief can still be untested.</p>
      ${rows.length === 0 ? empty('No assumptions or risks yet.') : `<div class="fo-records">${rows.map((a) => `
        <div class="fo-record">
          <div class="fo-record-main"><span class="fo-record-title">${esc(a.statement)}</span> ${pill(a.kind, a.kind === 'risk' ? 'fo-pill-risk' : '')}</div>
          <div class="fo-record-foot">${pill(`status: ${a.status}`, 'fo-pill-status')} ${pill(`confidence: ${a.confidence}`, '')}
            <button class="fo-edit" data-fo-edit="assumption" data-id="${attr(a.id)}" aria-label="Edit ${attr(a.statement)}">Edit</button>
            <button class="fo-del" data-fo-del="assumption" data-id="${attr(a.id)}" aria-label="Delete ${attr(a.statement)}">Delete</button></div>
        </div>`).join('')}</div>`}`;
  }

  function renderEvidence(ws) {
    const rows = state.records.evidence || [];
    const kindLabel = { founder_belief: 'Founder belief', customer_statement: 'Said', customer_behavior: 'Did', transaction: 'Paid/committed' };
    return `${recordListHeader('Customer evidence', '+ Add evidence', 'evidence')}
      <p class="fo-hint">"Said" vs "Did" is preserved: a stated preference is a weaker signal than an observed behavior or a payment.</p>
      ${rows.length === 0 ? empty('No evidence captured yet.') : `<div class="fo-records">${rows.map((e) => `
        <div class="fo-record">
          <div class="fo-record-main"><span class="fo-record-title">${esc(e.summary)}</span> ${pill(kindLabel[e.evidenceKind] || e.evidenceKind, e.evidenceKind === 'transaction' ? 'fo-pill-strong' : '')}</div>
          <div class="fo-record-foot">${esc(e.sourceType)}${e.contact ? ` · ${esc(e.contact)}` : ''}
            <button class="fo-edit" data-fo-edit="evidence" data-id="${attr(e.id)}" aria-label="Edit ${attr(e.summary)}">Edit</button>
            <button class="fo-del" data-fo-del="evidence" data-id="${attr(e.id)}" aria-label="Delete ${attr(e.summary)}">Delete</button></div>
        </div>`).join('')}</div>`}`;
  }

  // ---- permissions ------------------------------------------------------
  //
  // Every string below that classifies a capability comes from the BACKEND
  // catalog (GET /api/catalog -> capabilities, i.e. src/permissions.js). There
  // is deliberately no second capability list in this file: a hard-coded copy
  // is how a UI ends up describing permissions the code does not have. The
  // reachability contract asserts all 13 backend keys are rendered.
  //
  // Vocabulary rule: a recorded-only capability is never called blocked,
  // protected, prevented, disabled, enforced, approval-gated or guaranteed,
  // because none of those is true of it. It is called recorded.
  function capabilityBadge(cap) {
    return cap.enforcement === 'system_control'
      ? pill('System control', 'fo-pill-strong')
      : pill('Recorded only', '');
  }

  function permissionRows(agentId, perms) {
    const caps = state.catalog.capabilities || [];
    if (caps.length === 0) return empty('Capability catalog unavailable.');
    return `<div class="fo-perms">${caps.map((cap) => `
      <div class="fo-perm">
        <label class="fo-perm-main">
          <input type="checkbox" data-fo-perm="${attr(cap.key)}" data-agent="${attr(agentId)}" ${perms && perms[cap.key] ? 'checked' : ''}/>
          <span class="fo-perm-label">${esc(cap.label)}</span>
        </label>
        <div class="fo-perm-meta">
          ${capabilityBadge(cap)}
          ${cap.enforcementPoint
            ? `<span class="fo-perm-where">Always-on control: ${esc(cap.enforcementPoint)}. It applies to every run and does not read this setting.</span>`
            : '<span class="fo-perm-where">Nothing in the runtime reads this value.</span>'}
        </div>
      </div>`).join('')}</div>`;
  }

  // The honest header, rendered verbatim from the backend so the UI and the
  // docs cannot drift apart on the one claim that matters most.
  function permissionsPreamble() {
    return `<p class="fo-hint fo-note">${esc(state.catalog.runtimeEnforcementSummary || '')}
      Three capabilities have a separate always-on system control, named against each below; that control runs for every agent whether or not the box is ticked.
      There is no approval queue in this system — nothing pauses to ask you before an agent acts.</p>`;
  }

  function renderAgentsCatalog(ws) {
    const { agents, recommended } = state.agents;
    const recSet = new Set(recommended);
    const groups = {};
    for (const a of agents) { (groups[a.group] = groups[a.group] || []).push(a); }
    return `<p class="section-title">Agent catalog — recommended for “${esc(stageLabel(ws.stage))}” are highlighted</p>
      ${permissionsPreamble()}
      ${Object.entries(groups).map(([group, list]) => `
        <div class="fo-agent-group">
          <p class="fo-group-title">${esc(group)}</p>
          <div class="fo-agent-grid">
            ${list.map((a) => {
              const enabled = a.settings ? a.settings.enabled : false;
              const open = state.openPermissions === a.id;
              return `<div class="fo-agent ${recSet.has(a.id) ? 'recommended' : ''}">
                <div class="fo-agent-top"><span class="fo-agent-name">${esc(a.name)}</span>${recSet.has(a.id) ? pill('Recommended', 'fo-pill-rec') : ''}</div>
                <div class="fo-agent-purpose">${esc(a.purpose)}</div>
                <label class="fo-toggle"><input type="checkbox" data-fo-agent="${attr(a.id)}" ${enabled ? 'checked' : ''}/> Enabled in this workspace</label>
                <button class="fo-perm-toggle" data-fo-perms="${attr(a.id)}" aria-expanded="${open}" aria-controls="fo-perms-${attr(a.id)}">
                  ${open ? 'Hide' : 'Review'} permissions (${(state.catalog.capabilities || []).length})
                </button>
                <div id="fo-perms-${attr(a.id)}" data-fo-perm-revision="${attr(String(a.permissionRevision || 0))}" ${open ? '' : 'hidden'}>
                  ${open ? permissionRows(a.id, a.effectivePermissions) : ''}
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}`;
  }

  // =========================================================================
  //  YC VIEW
  // =========================================================================
  function renderYc() {
    const host = $('view-yc');
    if (!host) return;
    const ws = activeWorkspace();
    if (!ws) {
      host.innerHTML = `<div class="view-header"><h2 class="view-heading">YC readiness</h2></div>${empty('Create a business workspace first.')}`;
      return;
    }
    const yc = state.yc;
    const options = state.workspaces.map((w) => `<option value="${attr(w.id)}" ${w.id === state.activeWorkspaceId ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
    host.innerHTML = `
      <div class="view-header fo-business-header">
        <h2 class="view-heading">YC readiness</h2>
        <div class="fo-ws-select"><label class="fo-inline-label" for="fo-yc-workspace">Workspace</label>
          <select id="fo-yc-workspace" aria-label="Active workspace">${options}</select></div>
      </div>
      <div class="fo-card">
        ${meter('Overall YC preparation', yc ? yc.overall : 0)}
        <p class="fo-hint">This is a preparation-checklist score, not a prediction of acceptance. 100 means your configured checklist is complete.</p>
      </div>
      ${(yc ? yc.sections : []).map(renderYcSection).join('')}`;
  }

  function renderYcSection(sec) {
    return `
      <div class="fo-card fo-yc-section">
        <div class="fo-list-head">
          <p class="section-title">${esc(sec.label)}</p>
          <span class="fo-section-score" aria-label="${attr(`${sec.label} score ${sec.score} percent, weight ${sec.weight}`)}">${pct(sec.score)} <span class="fo-weight">· weight ${esc(String(sec.weight))}</span></span>
        </div>
        <div class="fo-checklist">
          ${(sec.items || []).map((it) => `
            <label class="fo-check ${it.done ? 'done' : ''}">
              <input type="checkbox" data-fo-yc="${attr(it.id)}" ${it.done ? 'checked' : ''}/>
              <span>${esc(it.label)}</span>
            </label>`).join('')}
        </div>
        ${sec.missingItems && sec.missingItems.length ? `<div class="fo-missing">Missing: ${sec.missingItems.map((m) => esc(m.label)).join(', ')}</div>` : '<div class="fo-missing done">Section complete</div>'}
      </div>`;
  }

  // =========================================================================
  //  SETTINGS VIEW
  // =========================================================================
  function renderSettings() {
    const host = $('view-settings');
    if (!host) return;
    const p = state.profile;
    host.innerHTML = `
      <div class="view-header"><h2 class="view-heading">Settings</h2></div>
      <div class="fo-card">
        <p class="section-title">Onboarding</p>
        <p class="fo-hint">${state.onboarding && state.onboarding.completed ? 'Onboarding is complete.' : 'Onboarding has not been completed.'}</p>
        <button class="btn btn-primary" data-fo="reopen-onboarding">Reopen onboarding</button>
      </div>
      <div class="fo-card">
        <p class="section-title">Founder profile</p>
        ${p ? `<div class="fo-profile">
          ${profileRow('Name', p.displayName)}
          ${profileRow('Skills', (p.skills || []).join(', '))}
          ${profileRow('Industries', (p.industries || []).join(', '))}
          ${profileRow('Hours / week', p.hoursPerWeek)}
          ${profileRow('Risk tolerance', p.riskTolerance)}
          ${profileRow('Preferred role', p.preferredRole)}
        </div>` : empty('No profile saved yet — set it up in onboarding.')}
      </div>
      <div class="fo-card">
        <p class="section-title">This is a private, single-operator system</p>
        <p class="fo-hint">Workspaces separate your businesses inside your own installation. There are no other users, no public sign-up, and no shared accounts.</p>
      </div>`;
  }
  function profileRow(label, value) {
    const v = (value === undefined || value === null || value === '') ? '—' : value;
    return `<div class="fo-prow"><span class="fo-prow-l">${esc(label)}</span><span class="fo-prow-v">${esc(String(v))}</span></div>`;
  }

  // =========================================================================
  //  RENDER DISPATCH + NAV
  // =========================================================================
  const OUR_VIEWS = ['business', 'yc', 'settings'];

  async function activate(view) {
    state.view = view;
    // ensure data is fresh for the view
    try {
      if (view === 'business' || view === 'yc') {
        if (state.workspaces.length === 0) await loadWorkspaces();
        await loadActiveWorkspaceDetail();
      }
      if (view === 'settings' && state.profile === null) state.profile = await api('/api/profile');
    } catch (err) {
      // This used to only console.error, so a 503 from a degraded store left
      // state.workspaces empty and the view then rendered "No workspaces yet.
      // Create your first business workspace to begin." — telling the operator
      // their data does not exist when in fact it could not be read. A load
      // failure must be reported as a load failure.
      console.error(err);
      state.loadError = err.message;
    }
    renderCurrent();
  }
  function renderCurrent() {
    if (state.view === 'business') renderBusiness();
    else if (state.view === 'yc') renderYc();
    else if (state.view === 'settings') renderSettings();
  }

  function wireNav() {
    document.querySelectorAll('.rail-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view;
        OUR_VIEWS.forEach((ov) => { const s = $(`view-${ov}`); if (s) s.classList.toggle('hidden', ov !== v); });
        if (OUR_VIEWS.includes(v)) activate(v);
        else state.view = null; // app.js owns this view
      });
    });
  }

  // =========================================================================
  //  EVENT DELEGATION (clicks, changes) for our views
  // =========================================================================
  function wireDelegation() {
    document.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-fo],[data-fo-tab],[data-fo-add],[data-fo-edit],[data-fo-del],[data-fo-perms]');
      if (!t) return;
      try {
        if (t.dataset.foPerms) {
          state.openPermissions = state.openPermissions === t.dataset.foPerms ? null : t.dataset.foPerms;
          renderBusiness();
        }
        else if (t.dataset.fo === 'new-workspace') { openWorkspaceDialog(); }
        else if (t.dataset.fo === 'edit-workspace') { openWorkspaceDialog(activeWorkspace()); }
        else if (t.dataset.fo === 'toggle-archive') {
          // Reversible either way, and the button says which direction it
          // goes, so there is nothing ambiguous to confirm. The archived
          // workspace stays selected and readable — archiving is not deletion
          // and must not behave like it.
          const ws = activeWorkspace();
          if (ws) {
            await api(`/api/workspaces/${ws.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !ws.archived }) });
            await loadWorkspaces(); await loadActiveWorkspaceDetail(); renderCurrent();
          }
        }
        else if (t.dataset.fo === 'reopen-onboarding') { await api('/api/onboarding/start', { method: 'POST' }); state.onboarding = await api('/api/onboarding'); openOnboarding(); }
        else if (t.dataset.foTab) { state.businessTab = t.dataset.foTab; renderBusiness(); }
        else if (t.dataset.foAdd) { openRecordDialog(t.dataset.foAdd); }
        else if (t.dataset.foEdit) {
          const type = t.dataset.foEdit;
          const existing = (state.records[pluralOf(type)] || []).find((r) => r.id === t.dataset.id);
          if (existing) openRecordDialog(type, existing);
        }
        else if (t.dataset.foDel) {
          const type = t.dataset.foDel; const id = t.dataset.id;
          await api(`/api/workspaces/${state.activeWorkspaceId}/${pluralOf(type)}/${id}`, { method: 'DELETE' });
          await loadActiveWorkspaceDetail(); renderCurrent();
        }
      } catch (err) { alert(err.message); }
    });

    document.addEventListener('change', async (e) => {
      const el = e.target;
      try {
        if (el.id === 'fo-workspace' || el.id === 'fo-yc-workspace') {
          state.activeWorkspaceId = el.value; await loadActiveWorkspaceDetail(); renderCurrent();
        } else if (el.dataset.foYc) {
          state.yc = await api(`/api/workspaces/${state.activeWorkspaceId}/yc`, { method: 'PUT', body: JSON.stringify({ itemId: el.dataset.foYc, done: el.checked }) });
          renderYc();
        } else if (el.dataset.foAgent) {
          await api(`/api/workspaces/${state.activeWorkspaceId}/agents/${el.dataset.foAgent}`, { method: 'PUT', body: JSON.stringify({ enabled: el.checked }) });
          await loadActiveWorkspaceDetail();
        } else if (el.dataset.foPerm) {
          // A-002. This used to spread the client's snapshot into a whole map
          // and PUT it, so two toggles derived from the same (not-yet-
          // refreshed) snapshot silently erased one another.
          //
          // The map is still sent whole — the store fills a partial map from
          // the least-authority default, so posting one key alone would reset
          // the others — but it now carries the revision it was derived from.
          // A superseded revision is refused with 409 instead of overwriting,
          // and the operator is told to retry rather than being shown a
          // success that quietly discarded someone's change.
          const agentId = el.dataset.agent;
          const agent = (state.agents.agents || []).find((a) => a.id === agentId);
          const next = { ...(agent ? agent.effectivePermissions : {}), [el.dataset.foPerm]: el.checked };
          try {
            await api(`/api/workspaces/${state.activeWorkspaceId}/agents/${agentId}`, {
              method: 'PUT',
              body: JSON.stringify({ permissions: next, expectedRevision: agent ? agent.permissionRevision : 0 }),
            });
          } catch (err) {
            // Re-read so the checkbox reflects what is actually stored, rather
            // than leaving the UI asserting a change the server refused.
            await loadActiveWorkspaceDetail();
            renderBusiness();
            throw err;
          }
          await loadActiveWorkspaceDetail();
          renderBusiness();
        } else if (el.dataset.foStatus) {
          // decisions, tasks and experiments all expose their lifecycle this
          // way; the route is derived from the type rather than hard-coded.
          const type = el.dataset.foStatus;
          await api(`/api/workspaces/${state.activeWorkspaceId}/${pluralOf(type)}/${el.dataset.id}`, { method: 'PUT', body: JSON.stringify({ status: el.value }) });
          await loadActiveWorkspaceDetail(); renderBusiness();
        }
      } catch (err) { alert(err.message); await loadActiveWorkspaceDetail(); renderCurrent(); }
    });
  }
  function pluralOf(type) {
    return { goal: 'goals', decision: 'decisions', assumption: 'assumptions', evidence: 'evidence', task: 'tasks', experiment: 'experiments' }[type] || `${type}s`;
  }

  // =========================================================================
  //  DIALOGS (workspace create, record create) — built as accessible modals
  // =========================================================================
  function modal(titleText, bodyHtml, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', titleText);
    overlay.innerHTML = `<form class="modal fo-modal"><h3>${esc(titleText)}</h3>${bodyHtml}
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
      <p class="modal-error" hidden></p></form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    const errEl = overlay.querySelector('.modal-error');
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await onSubmit(new FormData(form)); close(); }
      catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    });
    const first = form.querySelector('input,select,textarea');
    if (first) first.focus();
    return close;
  }

  // `value` prefills the control, which is what makes one form definition
  // serve both create and edit. Note that a prefilled value is
  // operator-controlled data re-entering the DOM: the input goes through
  // attr() (attribute context) and the textarea through esc() (text context).
  function field(name, label, opts = {}) {
    const { type = 'text', required = false, placeholder = '', textarea = false, options, value } = opts;
    const v = value === undefined || value === null ? '' : String(value);
    if (options) {
      return `<label>${esc(label)}<select name="${attr(name)}">${options.map((o) => `<option value="${attr(o.value)}" ${String(o.value) === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    }
    if (textarea) return `<label>${esc(label)}<textarea name="${attr(name)}" rows="3" placeholder="${attr(placeholder)}">${esc(v)}</textarea></label>`;
    return `<label>${esc(label)}<input type="${attr(type)}" name="${attr(name)}" ${required ? 'required' : ''} placeholder="${attr(placeholder)}" value="${attr(v)}"/></label>`;
  }

  // Create and edit share one dialog, for the same reason the record forms do.
  function openWorkspaceDialog(existing = null) {
    const stageOpts = state.stages.map((s) => ({ value: s.id, label: s.label }));
    const editing = Boolean(existing);
    modal(editing ? 'Edit workspace' : 'New business workspace',
      field('name', 'Name', { required: true, placeholder: 'e.g. Apparel company', value: existing?.name }) +
      field('description', 'Description', { textarea: true, placeholder: 'What is this business?', value: existing?.description }) +
      field('stage', 'Current stage', { options: stageOpts, value: existing?.stage }) +
      field('primaryGoal', 'Primary goal', { placeholder: 'e.g. First 10 paying customers', value: existing?.primaryGoal }) +
      field('targetDate', 'Target date (optional)', { type: 'date', value: existing?.targetDate }) +
      `<label class="fo-checkbox-label"><input type="checkbox" name="ycEnabled" ${existing?.ycEnabled ? 'checked' : ''}/> Preparing for YC</label>`,
      async (fd) => {
        const body = JSON.stringify({
          name: fd.get('name'), description: fd.get('description'), stage: fd.get('stage'),
          primaryGoal: fd.get('primaryGoal'), targetDate: fd.get('targetDate') || null,
          ycEnabled: fd.get('ycEnabled') === 'on',
        });
        const ws = await api(editing ? `/api/workspaces/${existing.id}` : '/api/workspaces', { method: editing ? 'PUT' : 'POST', body });
        await loadWorkspaces();
        state.activeWorkspaceId = ws.id;
        await loadActiveWorkspaceDetail(); renderCurrent();
      });
  }

  // One form definition per record type, used for BOTH create and edit. Two
  // separate definitions would drift; the previous code had create-only forms
  // and no edit at all, which left delete-and-retype as the only way to fix a
  // typo. `editable: false` means the backend genuinely refuses the update —
  // it is not a UI shortcut.
  const RECORD_FORMS = {
    goal: {
      editable: true,
      fields: (r) => field('title', 'Title', { required: true, value: r?.title })
        + field('description', 'Description', { textarea: true, value: r?.description })
        + field('targetDate', 'Target date', { type: 'date', value: r?.targetDate }),
      build: (fd) => ({ title: fd.get('title'), description: fd.get('description'), targetDate: fd.get('targetDate') || null }),
    },
    task: {
      editable: true,
      fields: (r) => field('title', 'Title', { required: true, value: r?.title })
        + field('status', 'Status', { value: r?.status, options: TASK_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })) })
        + field('goalId', 'Belongs to goal (optional)', {
          value: r?.goalId,
          options: [{ value: '', label: '— none —' }].concat((state.records.goals || []).map((g) => ({ value: g.id, label: g.title }))),
        })
        + field('notes', 'Notes', { textarea: true, value: r?.notes }),
      build: (fd) => ({ title: fd.get('title'), status: fd.get('status'), goalId: fd.get('goalId') || null, notes: fd.get('notes') }),
    },
    // Decisions are immutable except status (enforced server-side), so there
    // is no edit form — the status <select> in the list is the only mutation.
    decision: {
      editable: false,
      fields: () => field('decision', 'Decision', { required: true })
        + field('reasoning', 'Reasoning', { textarea: true })
        + field('alternatives', 'Alternatives considered', { textarea: true })
        + field('reconsiderWhen', 'Reconsider when', { placeholder: 'What would make you revisit this?' }),
      build: (fd) => ({ decision: fd.get('decision'), reasoning: fd.get('reasoning'), alternatives: fd.get('alternatives'), reconsiderWhen: fd.get('reconsiderWhen') }),
    },
    assumption: {
      editable: true,
      fields: (r) => field('statement', 'Statement', { required: true, value: r?.statement })
        + field('kind', 'Kind', { value: r?.kind, options: [{ value: 'assumption', label: 'Assumption' }, { value: 'risk', label: 'Risk' }] })
        + field('confidence', 'Confidence', { value: r?.confidence, options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] })
        + field('plannedTest', 'How would you test it?', { value: r?.plannedTest })
        + field('owner', 'Owner (optional)', { value: r?.owner })
        + field('reviewDate', 'Review date (optional)', { type: 'date', value: r?.reviewDate }),
      build: (fd) => ({
        statement: fd.get('statement'), kind: fd.get('kind'), confidence: fd.get('confidence'),
        plannedTest: fd.get('plannedTest'), owner: fd.get('owner'), reviewDate: fd.get('reviewDate') || null,
      }),
    },
    experiment: {
      editable: true,
      fields: (r) => field('title', 'Title', { required: true, value: r?.title })
        + field('assumptionId', 'Assumption being tested (optional)', {
          value: r?.assumptionId,
          options: [{ value: '', label: '— none —' }].concat((state.records.assumptions || []).map((a) => ({ value: a.id, label: a.statement }))),
        })
        + field('researchQuestion', 'Research question', { textarea: true, value: r?.researchQuestion, placeholder: 'What are you actually trying to find out?' })
        + field('method', 'Method', { value: r?.method, placeholder: 'e.g. 10 customer interviews' })
        + field('targetParticipant', 'Who will you test with?', { value: r?.targetParticipant })
        + field('successThreshold', 'Success if…', { value: r?.successThreshold, placeholder: 'Decide before running' })
        + field('failureThreshold', 'Failure if…', { value: r?.failureThreshold, placeholder: 'Decide before running' })
        + field('timeLimit', 'Time limit', { value: r?.timeLimit, placeholder: 'e.g. 2 weeks' })
        + field('costLimit', 'Cost limit', { value: r?.costLimit, placeholder: 'e.g. $200' })
        + field('results', 'Results (once run)', { textarea: true, value: r?.results })
        + field('conclusion', 'Conclusion', { textarea: true, value: r?.conclusion })
        + field('nextDecision', 'What will you do about it?', { value: r?.nextDecision }),
      build: (fd) => ({
        title: fd.get('title'), assumptionId: fd.get('assumptionId') || null,
        researchQuestion: fd.get('researchQuestion'), method: fd.get('method'), targetParticipant: fd.get('targetParticipant'),
        successThreshold: fd.get('successThreshold'), failureThreshold: fd.get('failureThreshold'),
        timeLimit: fd.get('timeLimit'), costLimit: fd.get('costLimit'),
        results: fd.get('results'), conclusion: fd.get('conclusion'), nextDecision: fd.get('nextDecision'),
      }),
    },
    evidence: {
      editable: true,
      fields: (r) => field('summary', 'Summary', { required: true, value: r?.summary })
        + field('evidenceKind', 'What is this?', {
          value: r?.evidenceKind,
          options: [
            { value: 'customer_statement', label: 'A customer SAID something' },
            { value: 'customer_behavior', label: 'A customer DID something' },
            { value: 'transaction', label: 'A payment / commitment' },
            { value: 'founder_belief', label: 'A founder belief' },
          ],
        })
        + field('sourceType', 'Source', {
          value: r?.sourceType,
          options: [
            { value: 'interview', label: 'Interview' }, { value: 'survey', label: 'Survey' }, { value: 'email', label: 'Email' },
            { value: 'call', label: 'Call' }, { value: 'usage', label: 'Usage' }, { value: 'document', label: 'Document' }, { value: 'other', label: 'Other' },
          ],
        })
        + field('contact', 'Contact (optional)', { value: r?.contact })
        + field('rawNotes', 'Raw notes', { textarea: true, value: r?.rawNotes }),
      build: (fd) => ({
        summary: fd.get('summary'), evidenceKind: fd.get('evidenceKind'), sourceType: fd.get('sourceType'),
        contact: fd.get('contact'), rawNotes: fd.get('rawNotes'),
      }),
    },
  };

  function openRecordDialog(type, existing = null) {
    const form = RECORD_FORMS[type];
    if (!form) return;
    const wsId = state.activeWorkspaceId;
    const editing = Boolean(existing);
    modal(editing ? `Edit ${type}` : `New ${type}`, form.fields(existing), async (fd) => {
      const path = `/api/workspaces/${wsId}/${pluralOf(type)}${editing ? `/${existing.id}` : ''}`;
      await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(form.build(fd)) });
      await loadActiveWorkspaceDetail(); renderCurrent();
    });
  }

  // =========================================================================
  //  ONBOARDING WIZARD (first-run; resumable; skippable; reopenable)
  // =========================================================================
  const WIZARD_STEPS = ['welcome', 'profile', 'operating_mode', 'workspace', 'agents', 'permissions', 'yc', 'review', 'done'];
  const wizard = { open: false, step: 'welcome', draft: {}, modes: [], overlay: null };

  function openOnboarding() {
    wizard.open = true;
    wizard.step = (state.onboarding && state.onboarding.currentStep) || 'welcome';
    wizard.draft = (state.onboarding && state.onboarding.draft) || {};
    wizard.modes = (state.onboarding && state.onboarding.operatingModes) || [];
    if (!wizard.overlay) {
      wizard.overlay = document.createElement('div');
      wizard.overlay.className = 'modal-overlay fo-onboard-overlay';
      wizard.overlay.setAttribute('role', 'dialog');
      wizard.overlay.setAttribute('aria-modal', 'true');
      wizard.overlay.setAttribute('aria-label', 'Onboarding');
      document.body.appendChild(wizard.overlay);
    }
    wizard.overlay.classList.remove('hidden');
    renderWizard();
  }
  function closeOnboarding() { wizard.open = false; if (wizard.overlay) wizard.overlay.classList.add('hidden'); }

  async function saveWizard(patch) {
    const body = { currentStep: wizard.step, operatingModes: wizard.modes, draft: wizard.draft, ...patch };
    try { state.onboarding = await api('/api/onboarding', { method: 'PUT', body: JSON.stringify(body) }); } catch (err) { console.error(err); }
  }

  function renderWizard() {
    const stepIndex = WIZARD_STEPS.indexOf(wizard.step);
    const progressPct = Math.round((stepIndex / (WIZARD_STEPS.length - 1)) * 100);
    wizard.overlay.innerHTML = `
      <div class="fo-wizard">
        <div class="fo-wizard-head">
          <span class="fo-wizard-title">Set up Rucker Park</span>
          <button class="fo-wizard-skip" data-wz="skip" aria-label="Skip onboarding">Skip for now</button>
        </div>
        <div class="fo-meter-track" role="progressbar" aria-valuenow="${progressPct}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${attr(`step ${stepIndex + 1} of ${WIZARD_STEPS.length}`)}"><div class="fo-meter-fill" style="width:${progressPct}%"></div></div>
        <div class="fo-wizard-body">${wizardStep()}</div>
      </div>`;
    const focusEl = wizard.overlay.querySelector('input,select,textarea,button[data-wz="next"]');
    if (focusEl) focusEl.focus();
  }

  function wizardStep() {
    switch (wizard.step) {
      case 'welcome':
        return `<h3>Welcome</h3>
          <p class="fo-hint">Rucker Park is a private operating environment for one trusted operator — you. It helps you run several businesses without their information getting mixed together. No accounts, no other users.</p>
          ${wizardNav(null, 'profile', 'Get started')}`;
      case 'profile':
        return `<h3>About you</h3>
          <p class="fo-hint">All optional — you can fill this in later from Settings.</p>
          ${field('displayName', 'What should the dashboard call you?', { placeholder: 'your name' })}
          ${field('skills', 'Skills (comma-separated)', { placeholder: 'sales, design' })}
          ${field('industries', 'Industries you understand', { placeholder: 'apparel, construction' })}
          ${field('hoursPerWeek', 'Hours per week', { type: 'number' })}
          ${field('riskTolerance', 'Risk tolerance', { placeholder: 'low / medium / high' })}
          ${wizardNav('welcome', 'operating_mode', 'Continue')}`;
      case 'operating_mode':
        return `<h3>How are you operating right now?</h3>
          <p class="fo-hint">Pick any that apply.</p>
          <div class="fo-mode-grid">${['explore', 'validate', 'build', 'sell', 'operate', 'fundraise', 'yc'].map((m) =>
            `<label class="fo-mode ${wizard.modes.includes(m) ? 'on' : ''}"><input type="checkbox" data-mode="${attr(m)}" ${wizard.modes.includes(m) ? 'checked' : ''}/> ${esc(m)}</label>`).join('')}</div>
          ${wizardNav('profile', 'workspace', 'Continue')}`;
      case 'workspace':
        return `<h3>Create your first workspace</h3>
          <p class="fo-hint">A workspace is one business or major project.</p>
          ${field('name', 'Workspace name', { required: true, placeholder: 'e.g. Apparel company' })}
          ${field('description', 'Description', { textarea: true })}
          ${field('stage', 'Current stage', { options: state.stages.map((s) => ({ value: s.id, label: s.label })) })}
          ${field('primaryGoal', 'Primary goal', { placeholder: 'e.g. First paying customer' })}
          ${wizardNav('operating_mode', 'agents', 'Continue')}`;
      case 'agents': {
        const stage = wizard.draft.stage || STAGE_FALLBACK;
        const recIds = new Set(state.catalog.recommendations[stage] || []);
        const recs = state.catalog.agents.filter((a) => recIds.has(a.id));
        return `<h3>Recommended agents</h3>
          <p class="fo-hint">For your stage, these are a good starting team. You can change this anytime — recommendations are guidance, not a lock.</p>
          <ul class="attention-list">${(recs.length ? recs : state.catalog.agents.slice(0, 4)).map((a) => `<li class="attention-item"><div class="body"><div class="title">${esc(a.name)}</div><div class="meta">${esc(a.purpose)}</div></div></li>`).join('')}</ul>
          ${wizardNav('workspace', 'permissions', 'Continue')}`;
      }
      case 'permissions': {
        // This step used to be two paragraphs and a Continue button, and one
        // of those paragraphs told the operator that consequential actions
        // "require your approval" — no approval mechanism exists. Every
        // capability is now listed here, read-only, with its real
        // classification, so "review permissions" describes what happens.
        const caps = state.catalog.capabilities || [];
        const defaults = (c) => !c.consequential;
        return `<h3>Agent permissions</h3>
          <p class="fo-hint">These are the ${caps.length} capabilities an agent can be given. Agents start with the least authority that lets them work: everything consequential starts off.</p>
          ${permissionsPreamble()}
          <div class="fo-perms fo-perms-review">${caps.map((c) => `
            <div class="fo-perm">
              <div class="fo-perm-main">
                <span class="fo-perm-state ${defaults(c) ? 'on' : 'off'}">${defaults(c) ? 'on' : 'off'}</span>
                <span class="fo-perm-label">${esc(c.label)}</span>
              </div>
              <div class="fo-perm-meta">
                ${capabilityBadge(c)}
                ${c.enforcementPoint
                  ? `<span class="fo-perm-where">Always-on control: ${esc(c.enforcementPoint)}.</span>`
                  : '<span class="fo-perm-where">Nothing in the runtime reads this value.</span>'}
              </div>
            </div>`).join('')}</div>
          <p class="fo-hint">You can change any of these per agent, per workspace, in Business &rarr; Agents &rarr; Review permissions.</p>
          ${wizardNav('agents', 'yc', 'Continue')}`;
      }
      case 'yc':
        return `<h3>Y Combinator</h3>
          <p class="fo-hint">Is this workspace preparing for YC? You can track a preparation checklist and see a transparent readiness score (not an acceptance prediction).</p>
          <label class="fo-checkbox-label"><input type="checkbox" data-yc-enable ${wizard.draft.ycEnabled ? 'checked' : ''}/> Yes, track YC preparation</label>
          ${wizardNav('permissions', 'review', 'Continue')}`;
      case 'review':
        return `<h3>Review</h3>
          <div class="fo-review">
            ${profileRow('Workspace', wizard.draft.name || '(unnamed)')}
            ${profileRow('Stage', stageLabel(wizard.draft.stage || STAGE_FALLBACK))}
            ${profileRow('Primary goal', wizard.draft.primaryGoal || '—')}
            ${profileRow('Operating modes', wizard.modes.join(', ') || '—')}
            ${profileRow('YC track', wizard.draft.ycEnabled ? 'Yes' : 'No')}
          </div>
          ${wizardNav('yc', 'done', 'Finish setup')}`;
      case 'done':
        return `<h3>You're set up</h3><p class="fo-hint">Your workspace is ready. Landing you in the Command Center.</p>`;
      default: return '';
    }
  }

  function wizardNav(back, next, nextLabel) {
    return `<div class="fo-wizard-nav">
      ${back ? `<button type="button" class="btn" data-wz="back" data-back="${attr(back)}">Back</button>` : '<span></span>'}
      <button type="button" class="btn btn-primary" data-wz="next" data-next="${attr(next)}">${esc(nextLabel)}</button>
    </div>`;
  }

  // capture wizard field values from the current step before moving on
  function captureStep() {
    const q = (sel) => wizard.overlay.querySelector(sel);
    if (wizard.step === 'profile') {
      const skills = q('[name="skills"]').value.trim();
      const industries = q('[name="industries"]').value.trim();
      wizard.draft.profile = {
        displayName: q('[name="displayName"]').value.trim() || undefined,
        skills: skills ? skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
        industries: industries ? industries.split(',').map((s) => s.trim()).filter(Boolean) : [],
        hoursPerWeek: q('[name="hoursPerWeek"]').value || undefined,
        riskTolerance: q('[name="riskTolerance"]').value || undefined,
      };
    } else if (wizard.step === 'workspace') {
      wizard.draft.name = q('[name="name"]').value.trim();
      wizard.draft.description = q('[name="description"]').value;
      wizard.draft.stage = q('[name="stage"]').value;
      wizard.draft.primaryGoal = q('[name="primaryGoal"]').value;
    }
  }

  function wireWizard() {
    document.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-wz]');
      if (!b || !wizard.open) return;
      const action = b.dataset.wz;
      if (action === 'skip') {
        try { await api('/api/onboarding/complete', { method: 'POST', body: JSON.stringify({ skipped: true }) }); } catch { /* ignore */ }
        closeOnboarding();
        return;
      }
      if (action === 'back') { captureStep(); wizard.step = b.dataset.back; await saveWizard(); renderWizard(); return; }
      if (action === 'next') {
        // validation: workspace step needs a name
        if (wizard.step === 'workspace') {
          const nameEl = wizard.overlay.querySelector('[name="name"]');
          if (!nameEl.value.trim()) { nameEl.focus(); nameEl.setAttribute('aria-invalid', 'true'); return; }
        }
        captureStep();
        const next = b.dataset.next;
        if (next === 'done') { await finishOnboarding(); return; }
        wizard.step = next;
        await saveWizard();
        renderWizard();
      }
    });

    document.addEventListener('change', (e) => {
      if (!wizard.open) return;
      if (e.target.dataset.mode) {
        const m = e.target.dataset.mode;
        if (e.target.checked) { if (!wizard.modes.includes(m)) wizard.modes.push(m); }
        else wizard.modes = wizard.modes.filter((x) => x !== m);
      } else if (e.target.hasAttribute('data-yc-enable')) {
        wizard.draft.ycEnabled = e.target.checked;
      }
    });
  }

  async function finishOnboarding() {
    // Persist profile (if any), create the workspace, mark onboarding complete.
    try {
      if (wizard.draft.profile) await api('/api/profile', { method: 'PUT', body: JSON.stringify(wizard.draft.profile) });
      let created = null;
      if (wizard.draft.name) {
        created = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({
          name: wizard.draft.name, description: wizard.draft.description || '', stage: wizard.draft.stage || STAGE_FALLBACK,
          primaryGoal: wizard.draft.primaryGoal || '', ycEnabled: Boolean(wizard.draft.ycEnabled),
        }) });
      }
      await api('/api/onboarding/complete', { method: 'POST', body: JSON.stringify({ skipped: false }) });
      state.onboarding = await api('/api/onboarding');
      await loadWorkspaces();
      if (created) state.activeWorkspaceId = created.id;
      await loadActiveWorkspaceDetail();
    } catch (err) { alert(err.message); }
    closeOnboarding();
    // land in Business/Command Center
    const bizBtn = document.querySelector('.rail-item[data-view="business"]');
    if (bizBtn) bizBtn.click();
  }

  // =========================================================================
  //  BOOT
  // =========================================================================
  async function boot() {
    wireNav();
    wireDelegation();
    wireWizard();
    try {
      await loadReference();
      state.onboarding = await api('/api/onboarding');
      state.profile = await api('/api/profile');
      await loadWorkspaces();
      // First-run detection: no onboarding record, or not completed.
      if (!state.onboarding || !state.onboarding.completed) {
        openOnboarding();
      }
    } catch (err) { console.error('Feature Onboard init failed', err); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
