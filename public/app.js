(() => {
  const OPERATOR_NAME = 'Brody';
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    agents: [],
    statuses: {},
    summary: null,
    activity: [],
    workstreams: [],
    view: 'command',
    selectedAgentId: null,
    selectedWorkstreamId: null,
    editingId: null,
    editingWorkstreamId: null,
    deleteTargetId: null,
    activityFilter: 'all',
    activityGrouped: false,
    agentsWorkstreamFilter: '',
    expandedActivity: new Set(),
    agentsShowingDetail: false, // mobile: list vs detail
    workstreamsShowingDetail: false,
  };

  const el = {
    systemLine: document.getElementById('system-line'),
    clock: document.getElementById('topbar-clock'),
    railItems: Array.from(document.querySelectorAll('.rail-item[data-view]')),
    newAgentBtn: document.getElementById('new-agent-btn'),
    viewCommand: document.getElementById('view-command'),
    viewWorkstreams: document.getElementById('view-workstreams'),
    viewAgents: document.getElementById('view-agents'),
    viewActivity: document.getElementById('view-activity'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalCancel: document.getElementById('modal-cancel'),
    modalError: document.getElementById('modal-error'),
    form: document.getElementById('agent-form'),
    providerSegmented: document.getElementById('provider-segmented'),
    providerInput: document.getElementById('provider-input'),
    workstreamSelect: document.getElementById('workstream-select'),
    modelField: document.getElementById('model-field'),
    systemField: document.getElementById('system-field'),
    taskField: document.getElementById('task-field'),
    commandField: document.getElementById('command-field'),
    tokensField: document.getElementById('tokens-field'),
    confirmOverlay: document.getElementById('confirm-overlay'),
    confirmTitle: document.getElementById('confirm-title'),
    confirmBody: document.getElementById('confirm-body'),
    confirmCancel: document.getElementById('confirm-cancel'),
    confirmOk: document.getElementById('confirm-ok'),
    wsModalOverlay: document.getElementById('workstream-modal-overlay'),
    wsModalTitle: document.getElementById('workstream-modal-title'),
    wsModalCancel: document.getElementById('workstream-modal-cancel'),
    wsModalError: document.getElementById('workstream-modal-error'),
    wsForm: document.getElementById('workstream-form'),
    statusSegmented: document.getElementById('status-segmented'),
    statusOverrideInput: document.getElementById('status-override-input'),
  };

  // ---------------- Formatting ----------------

  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  }

  // Structured cost aggregate -> { compact, full, supporting } display strings.
  // Never collapses "partial" into a bare dollar figure — see runsStore.aggregateCost.
  function fmtCost(cost) {
    if (!cost) return { compact: '—', full: '—', supporting: null };
    const plural = (n) => (n === 1 ? '' : 's');
    switch (cost.pricingStatus) {
      case 'empty':
        return { compact: '$0.00', full: '$0.00', supporting: 'No usage today' };
      case 'complete':
        return { compact: fmtMoney(cost.knownCost), full: fmtMoney(cost.knownCost), supporting: null };
      case 'partial':
        return {
          compact: `${fmtMoney(cost.knownCost)}*`,
          full: `Known cost: ${fmtMoney(cost.knownCost)}`,
          supporting: `${cost.unpricedRunCount} run${plural(cost.unpricedRunCount)} ${cost.unpricedRunCount === 1 ? 'has' : 'have'} unavailable pricing`,
        };
      case 'unavailable':
        return { compact: '—', full: '—', supporting: `Pricing unavailable for ${cost.totalRunCount} run${plural(cost.totalRunCount)}` };
      default:
        return { compact: '—', full: '—', supporting: null };
    }
  }

  function fmtPercent(v) {
    if (v === null || v === undefined) return '—';
    return `${Math.round(v * 10) / 10}%`;
  }

  function fmtTokens(n) {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('en-US');
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  }

  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function greetingWord() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function statusLabel(status) {
    return { idle: 'Idle', running: 'Running', completed: 'Completed', error: 'Failed', cancelled: 'Stopped' }[status] || status;
  }

  // Workstream statuses are already human-readable (Planning/Active/Blocked/
  // Review/Completed/Archived) — this just maps to the lowercase CSS class.
  function workstreamStatusClass(status) {
    return String(status || 'planning').toLowerCase();
  }

  function WorkstreamStatusIndicator(status) {
    return `<span class="status status-${workstreamStatusClass(status)}">${escapeHtml(status)}</span>`;
  }

  // ---------------- API ----------------

  async function api(path, options) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).error || message; } catch {}
      throw new Error(message);
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('application/json') ? res.json() : res.text();
  }

  function getAgent(id) { return state.agents.find((a) => a.id === id); }
  function statusOf(id) { return state.statuses[id]?.status || 'idle'; }

  async function loadAll() {
    const [summary, agents, activity, workstreams] = await Promise.all([
      api('/api/summary'),
      api('/api/agents'),
      api('/api/activity?limit=80'),
      api('/api/workstreams'),
    ]);
    state.summary = summary;
    state.agents = agents;
    state.activity = activity;
    state.workstreams = workstreams;
    for (const a of agents) state.statuses[a.id] = { status: a.status || 'idle' };
    if (!state.selectedAgentId && agents.length) state.selectedAgentId = agents[0].id;
    if (!state.selectedWorkstreamId && workstreams.length) state.selectedWorkstreamId = workstreams[0].id;
    populateWorkstreamSelect();
  }

  async function refreshData() {
    const [summary, agents, workstreams] = await Promise.all([
      api('/api/summary'),
      api('/api/agents'),
      api('/api/workstreams'),
    ]);
    state.summary = summary;
    state.agents = agents;
    state.workstreams = workstreams;
    for (const a of agents) state.statuses[a.id] = { status: a.status || 'idle' };
    if (!state.selectedAgentId && agents.length) state.selectedAgentId = agents[0].id;
    if (!state.selectedWorkstreamId && workstreams.length) state.selectedWorkstreamId = workstreams[0].id;
    populateWorkstreamSelect();
    render();
  }

  // ---------------- Nav ----------------

  function showView(name) {
    state.view = name;
    el.railItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
    el.viewCommand.classList.toggle('hidden', name !== 'command');
    el.viewWorkstreams.classList.toggle('hidden', name !== 'workstreams');
    el.viewAgents.classList.toggle('hidden', name !== 'agents');
    el.viewActivity.classList.toggle('hidden', name !== 'activity');
    render();
  }

  el.railItems.forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

  function animateEnter(elm) {
    if (!elm || prefersReducedMotion) return;
    elm.classList.remove('view-enter');
    void elm.offsetWidth; // restart animation
    elm.classList.add('view-enter');
  }

  // ---------------- Primitives (render helpers) ----------------

  function StatusIndicator(status) {
    return `<span class="status status-${status}">${statusLabel(status)}</span>`;
  }

  function Metric(value, label, opts = {}) {
    const cls = opts.na ? 'value na' : 'value';
    return `<div class="metric"><div class="${cls}">${value}</div><div class="label">${label}</div></div>`;
  }

  function DataRow(k, v, muted) {
    return `<div class="data-row"><span class="k">${escapeHtml(k)}</span><span class="v${muted ? ' muted' : ''}">${v}</span></div>`;
  }

  function EmptyState(message) {
    return `<p class="empty-note">${escapeHtml(message)}</p>`;
  }

  function humanizeEvent(evt) {
    const name = evt.details?.agentName || evt.details?.name || 'An agent';
    const map = {
      'run.started': `${name} started a run`,
      'run.completed': `${name} completed a run`,
      'run.cancelled': `${name}'s run was stopped`,
      'run.failed': `${name}'s run failed`,
      'run.stop_requested': `Stop requested for ${name}`,
      'agent.created': `${name} was registered`,
      'agent.updated': `${name} was updated`,
      'agent.deleted': `${name} was deleted`,
      'registry.external_modification_detected': 'Agent registry was modified outside the API',
    };
    return map[evt.action] || `${evt.action} — ${name}`;
  }

  function eventCategory(action) {
    if (action === 'agent.created' || action === 'agent.updated' || action === 'agent.deleted') return 'changes';
    if (action === 'run.completed') return 'completed';
    if (action === 'run.failed') return 'failed';
    if (action === 'run.cancelled') return 'cancelled';
    if (action === 'registry.external_modification_detected') return 'integrity';
    return 'runs';
  }

  // Groups the same real events used elsewhere (humanizeEvent) into a short,
  // factual per-workstream line — a summary of what actually happened, not
  // an interpretation of intent, blockers, or quality.
  function synthesizeWorkstreamLine(ws) {
    if (ws.agentCount === 0) return 'No agents assigned yet.';
    const relevant = state.activity
      .filter((e) => e.details?.workstreamId === ws.id && ['run.completed', 'run.failed', 'run.cancelled'].includes(e.action))
      .slice(0, 2);
    if (relevant.length === 0) return 'No runs yet.';
    return relevant.map((e) => humanizeEvent(e)).join('. ') + '.';
  }

  // ---------------- Command ----------------

  function renderCommand() {
    const s = state.summary || {};
    const healthy = !s.needsAttention;
    const integrityEvent = state.activity.find((e) => e.action === 'registry.external_modification_detected');
    const activeAgents = state.agents.filter((a) => statusOf(a.id) === 'running');
    const failing = state.activity.filter((e) => e.flagged && e.action !== 'registry.external_modification_detected').slice(0, 5);
    const completed = state.activity.filter((e) => e.action === 'run.completed').slice(0, 5);
    const recent = state.activity.slice(0, 6);

    el.viewCommand.innerHTML = `
      ${integrityEvent ? `
        <div class="banner banner-warning">
          <span class="banner-icon">!</span>
          <div class="banner-body">
            <div class="banner-title">Registry integrity warning</div>
            <div class="banner-detail">agents.json was modified outside the API at ${fmtTime(integrityEvent.ts)} on ${new Date(integrityEvent.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. The system re-baselined after detecting it.</div>
          </div>
        </div>` : ''}

      <p class="greeting-eyebrow">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <div class="condition-block">
        <h1 class="condition-headline">${greetingWord()}, ${OPERATOR_NAME}. <span class="state-word ${healthy ? 'healthy' : 'degraded'}">${healthy ? 'System healthy.' : `${s.needsAttention} needs attention.`}</span></h1>
        <p class="condition-sub"><strong>${s.active ?? 0}</strong> active now · <strong>${s.completedToday ?? 0}</strong> completed today${s.needsAttention ? ` · <strong>${s.needsAttention}</strong> failing` : ''}</p>
      </div>

      <p class="section-title">Active now</p>
      ${activeAgents.length === 0
        ? EmptyState('Nothing running right now.')
        : `<ul class="live-list">${activeAgents.map((a) => `
            <li class="live-item">
              ${StatusIndicator('running')}
              <div class="body">
                <div class="title">${escapeHtml(a.name)}</div>
                <div class="meta">${escapeHtml(a.provider)}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</div>
              </div>
            </li>`).join('')}</ul>`}

      ${state.workstreams.filter((w) => !w.archived).length > 0 ? `
        <p class="section-title" style="margin-top:32px;">Workstreams</p>
        <ul class="attention-list">
          ${state.workstreams.filter((w) => !w.archived).map((ws) => `
            <li class="attention-item" data-workstream-id="${ws.id}" style="cursor:pointer;">
              ${WorkstreamStatusIndicator(ws.status)}
              <div class="body">
                <div class="title">${escapeHtml(ws.name)} — ${escapeHtml(synthesizeWorkstreamLine(ws))}</div>
                <div class="meta">${ws.agentCount} agent${ws.agentCount === 1 ? '' : 's'} · ${ws.runCount} run${ws.runCount === 1 ? '' : 's'}${ws.cost.pricingStatus !== 'empty' ? ` · ${fmtCost(ws.cost).compact}` : ''}</div>
              </div>
            </li>`).join('')}
        </ul>` : ''}

      <div class="command-columns" style="margin-top:32px;">
        <div>
          <p class="section-title">Needs attention</p>
          ${failing.length === 0
            ? EmptyState('Nothing needs your attention right now.')
            : `<ul class="attention-list">${failing.map((e) => `
                <li class="attention-item">
                  <span class="marker">●</span>
                  <div class="body">
                    <div class="title">${escapeHtml(humanizeEvent(e))}</div>
                    <div class="meta">${fmtTime(e.ts)}${e.details?.error ? ` · ${escapeHtml(e.details.error)}` : ''}</div>
                  </div>
                </li>`).join('')}</ul>`}
        </div>
        <div>
          <p class="section-title">Recently completed</p>
          ${completed.length === 0
            ? EmptyState('No completions yet.')
            : `<ul class="attention-list">${completed.map((e) => `
                <li class="attention-item">
                  <span class="marker" style="color:var(--green);">●</span>
                  <div class="body">
                    <div class="title">${escapeHtml(e.details?.agentName || 'Agent')} completed</div>
                    <div class="meta">${fmtTime(e.ts)}${e.details?.costUsd != null ? ` · ${fmtMoney(e.details.costUsd)}` : ''}</div>
                  </div>
                </li>`).join('')}</ul>`}
        </div>
      </div>

      <div class="command-metrics">
        ${Metric(fmtCost(s.cost).compact, 'Cost today')}
        ${Metric(s.runsToday ?? 0, 'Runs today')}
        ${Metric(fmtPercent(s.executionSuccessRate), 'Execution success', { na: s.executionSuccessRate == null })}
      </div>
      ${fmtCost(s.cost).supporting ? `<p class="footnote">${escapeHtml(fmtCost(s.cost).supporting)}</p>` : ''}

      <p class="section-title" style="margin-top:32px;">Recent activity</p>
      ${recent.length === 0
        ? EmptyState('No activity yet.')
        : `<ul class="mini-activity">${recent.map((e) => `
            <li class="mini-activity-item">
              <span class="time">${fmtTime(e.ts)}</span>
              <span class="desc">${escapeHtml(humanizeEvent(e))}</span>
            </li>`).join('')}</ul>`}
      <p class="footnote">Task quality is not measured yet — Execution success reflects whether a run finished without error, not whether its output was good.</p>
    `;
    animateEnter(el.viewCommand);
    el.viewCommand.querySelectorAll('[data-workstream-id]').forEach((li) => {
      li.addEventListener('click', () => {
        state.selectedWorkstreamId = li.dataset.workstreamId;
        state.workstreamsShowingDetail = true;
        showView('workstreams');
      });
    });
  }

  // ---------------- Agents (list + detail split) ----------------

  let detailRunsCache = { runs: [], summary: {} };
  let detailLogsCache = '';

  async function loadAgentDetail(id) {
    const [runsData, logs] = await Promise.all([
      api(`/api/agents/${id}/runs`),
      api(`/api/agents/${id}/logs`),
    ]);
    detailRunsCache = runsData;
    detailLogsCache = logs;
  }

  async function renderAgents() {
    if (state.agents.length === 0) {
      el.viewAgents.innerHTML = `
        <div class="view-header"><h2 class="view-heading">Agents</h2></div>
        ${EmptyState('No agents registered yet. Create one to get started.')}
      `;
      animateEnter(el.viewAgents);
      return;
    }

    if (!state.selectedAgentId || !getAgent(state.selectedAgentId)) {
      state.selectedAgentId = state.agents[0].id;
    }

    const workstreamOptions = state.workstreams
      .map((w) => `<option value="${w.id}" ${state.agentsWorkstreamFilter === w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`)
      .join('');

    el.viewAgents.innerHTML = `
      <div class="view-header">
        <h2 class="view-heading">Agents</h2>
        ${state.workstreams.length > 0 ? `
          <select id="agents-workstream-filter" class="select-input" aria-label="Filter by workstream">
            <option value="">All workstreams</option>
            ${workstreamOptions}
          </select>` : ''}
      </div>
      <div class="agents-split">
        <div class="agent-index${state.agentsShowingDetail ? ' has-detail' : ''}" id="agent-index"></div>
        <div id="agent-detail-panel" class="${state.agentsShowingDetail ? 'showing' : ''}">${loadingSkeleton()}</div>
      </div>
    `;
    animateEnter(el.viewAgents);
    renderAgentIndex();

    const filterEl = document.getElementById('agents-workstream-filter');
    if (filterEl) {
      filterEl.addEventListener('change', () => {
        state.agentsWorkstreamFilter = filterEl.value;
        renderAgentIndex();
      });
    }

    try {
      await loadAgentDetail(state.selectedAgentId);
      renderAgentDetailPanel();
    } catch (err) {
      document.getElementById('agent-detail-panel').innerHTML = `<p class="empty-note">Failed to load agent: ${escapeHtml(err.message)}</p>`;
    }
  }

  function loadingSkeleton() {
    return `<div>${Array.from({ length: 5 }).map(() => '<div class="skeleton-row" style="width:70%;"></div>').join('')}</div>`;
  }

  function renderAgentIndex() {
    const indexEl = document.getElementById('agent-index');
    if (!indexEl) return;
    const visible = state.agentsWorkstreamFilter
      ? state.agents.filter((a) => a.workstreamId === state.agentsWorkstreamFilter)
      : state.agents;
    indexEl.innerHTML = visible.length === 0
      ? EmptyState('No agents in this workstream.')
      : visible.map((agent) => {
        const status = statusOf(agent.id);
        return `
          <div class="agent-row ${agent.id === state.selectedAgentId ? 'active' : ''}" data-id="${agent.id}">
            ${StatusIndicator(status)}
            <div class="info">
              <div class="name">${escapeHtml(agent.name)}</div>
              <div class="role">${escapeHtml(agent.role || agent.provider)}</div>
            </div>
            <div class="cost">${fmtCost(agent.cost).compact}</div>
          </div>`;
      }).join('');
    indexEl.querySelectorAll('.agent-row').forEach((rowEl) => {
      rowEl.addEventListener('click', () => selectAgent(rowEl.dataset.id));
    });
  }

  async function selectAgent(id) {
    const sameAgent = id === state.selectedAgentId;
    state.selectedAgentId = id;
    state.agentsShowingDetail = true;
    document.getElementById('agent-index')?.classList.add('has-detail');
    document.getElementById('agent-detail-panel')?.classList.add('showing');
    renderAgentIndex();
    // Same agent as already loaded (e.g. tapping the default-selected row on
    // mobile just to reveal the detail screen) — nothing new to fetch.
    if (sameAgent) return;
    document.getElementById('agent-detail-panel').innerHTML = loadingSkeleton();
    try {
      await loadAgentDetail(id);
      renderAgentDetailPanel();
    } catch (err) {
      document.getElementById('agent-detail-panel').innerHTML = `<p class="empty-note">Failed to load agent: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderAgentDetailPanel() {
    const agent = getAgent(state.selectedAgentId);
    const panel = document.getElementById('agent-detail-panel');
    if (!agent || !panel) return;
    const status = statusOf(agent.id);
    const summary = detailRunsCache.summary || {};
    const runs = detailRunsCache.runs || [];
    const cost = fmtCost(summary.cost);

    panel.innerHTML = `
      <div class="detail-panel">
        <button class="detail-back" id="detail-back">&larr; All agents</button>
        <div class="detail-header">
          <div>
            <h2 class="detail-name">${escapeHtml(agent.name)}</h2>
            <div class="detail-role">${escapeHtml(agent.role || 'No role description set')}</div>
            <div class="detail-status-row">${StatusIndicator(status)}</div>
          </div>
          <div class="detail-actions">
            <button class="btn" id="start-btn" ${status === 'running' ? 'disabled' : ''}>Start</button>
            <button class="btn" id="stop-btn" ${status !== 'running' ? 'disabled' : ''}>Stop</button>
            <button class="btn" id="edit-btn" ${status === 'running' ? 'disabled' : ''}>Edit</button>
            <button class="btn btn-danger" id="delete-btn" ${status === 'running' ? 'disabled' : ''}>Delete</button>
          </div>
        </div>

        <div class="detail-data">
          ${DataRow('Workstream', agent.workstreamName ? escapeHtml(agent.workstreamName) : 'Unassigned', !agent.workstreamName)}
          ${DataRow('Provider', escapeHtml(agent.provider))}
          ${DataRow(agent.provider === 'custom' ? 'Command' : 'Model', escapeHtml(agent.provider === 'custom' ? agent.command : (agent.model || 'default')))}
          ${DataRow('Registered', fmtDateTime(new Date(agent.createdAt).getTime()), true)}
          ${DataRow('Cost today', cost.full)}
          ${DataRow('Execution success', fmtPercent(summary.executionSuccessRate))}
          ${DataRow('Runs completed', `${summary.runsCompleted ?? 0} of ${summary.totalRuns ?? 0}`)}
          ${DataRow('Task quality', 'Not measured', true)}
        </div>
        ${cost.supporting ? `<p class="footnote" style="margin-top:-20px;margin-bottom:24px;">${escapeHtml(cost.supporting)}</p>` : ''}

        <div class="detail-columns">
          <div>
            <p class="section-title">Live output</p>
            <div class="terminal-wrap">
              <div class="terminal-header">stdout</div>
              <pre class="terminal" id="terminal">${escapeHtml(detailLogsCache || '(no output yet)')}</pre>
            </div>
          </div>
          <div>
            <p class="section-title">Run history</p>
            ${runs.length === 0 ? EmptyState('No runs yet.') : `
              <table class="runs-table">
                <thead><tr><th>Started</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Outcome</th></tr></thead>
                <tbody>
                  ${runs.map((r) => `
                    <tr>
                      <td>${fmtDateTime(r.startedAt)}</td>
                      <td>${fmtDuration(r.durationMs)}</td>
                      <td>${r.inputTokens != null ? `${fmtTokens(r.inputTokens)} / ${fmtTokens(r.outputTokens)}` : '—'}</td>
                      <td>${fmtMoney(r.costUsd)}</td>
                      <td>${StatusIndicator(r.status === 'completed' ? 'completed' : r.status === 'cancelled' ? 'cancelled' : r.status === 'running' ? 'running' : 'error')}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`}
          </div>
        </div>
      </div>
    `;

    document.getElementById('detail-back').addEventListener('click', () => {
      state.agentsShowingDetail = false;
      document.getElementById('agent-index')?.classList.remove('has-detail');
      document.getElementById('agent-detail-panel')?.classList.remove('showing');
    });
    document.getElementById('start-btn').addEventListener('click', () => handleStart(agent.id));
    document.getElementById('stop-btn').addEventListener('click', () => handleStop(agent.id));
    document.getElementById('edit-btn').addEventListener('click', () => openModal(agent));
    document.getElementById('delete-btn').addEventListener('click', () => confirmDelete(agent.id));

    const terminal = document.getElementById('terminal');
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }

  async function handleStart(id) {
    try {
      await api(`/api/agents/${id}/start`, { method: 'POST' });
      const terminal = document.getElementById('terminal');
      if (terminal) terminal.textContent = '';
    } catch (err) {
      alert(`Failed to start: ${err.message}`);
    }
  }

  async function handleStop(id) {
    try {
      await api(`/api/agents/${id}/stop`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to stop: ${err.message}`);
    }
  }

  function confirmDelete(id) {
    const agent = getAgent(id);
    state.deleteTargetId = id;
    el.confirmTitle.textContent = `Delete ${agent?.name || 'this agent'}?`;
    el.confirmBody.textContent = 'This permanently removes the agent and its stored log history. This cannot be undone.';
    el.confirmOverlay.classList.remove('hidden');
  }

  el.confirmCancel.addEventListener('click', () => {
    el.confirmOverlay.classList.add('hidden');
    state.deleteTargetId = null;
  });
  el.confirmOverlay.addEventListener('click', (e) => { if (e.target === el.confirmOverlay) el.confirmCancel.click(); });

  el.confirmOk.addEventListener('click', async () => {
    const id = state.deleteTargetId;
    if (!id) return;
    try {
      await api(`/api/agents/${id}`, { method: 'DELETE' });
      state.agents = state.agents.filter((a) => a.id !== id);
      if (state.selectedAgentId === id) {
        state.selectedAgentId = null;
        state.agentsShowingDetail = false;
      }
      el.confirmOverlay.classList.add('hidden');
      state.deleteTargetId = null;
      await refreshData();
    } catch (err) {
      alert(`Failed to delete: ${err.message}`);
    }
  });

  // ---------------- Workstreams (list + detail split) ----------------

  function getWorkstream(id) { return state.workstreams.find((w) => w.id === id); }

  async function renderWorkstreams() {
    if (state.workstreams.length === 0) {
      el.viewWorkstreams.innerHTML = `
        <div class="view-header">
          <h2 class="view-heading">Workstreams</h2>
          <button class="btn btn-primary" id="new-workstream-btn">+ New Workstream</button>
        </div>
        <p class="empty-note">No workstreams yet. Create your first objective.<br>Agents can later be assigned to it.</p>
      `;
      document.getElementById('new-workstream-btn').addEventListener('click', () => openWorkstreamModal(null));
      animateEnter(el.viewWorkstreams);
      return;
    }

    if (!state.selectedWorkstreamId || !getWorkstream(state.selectedWorkstreamId)) {
      state.selectedWorkstreamId = state.workstreams[0].id;
    }

    el.viewWorkstreams.innerHTML = `
      <div class="view-header">
        <h2 class="view-heading">Workstreams</h2>
        <button class="btn btn-primary" id="new-workstream-btn">+ New Workstream</button>
      </div>
      <div class="workstream-split">
        <div class="workstream-index${state.workstreamsShowingDetail ? ' has-detail' : ''}" id="workstream-index"></div>
        <div id="workstream-detail-panel" class="${state.workstreamsShowingDetail ? 'showing' : ''}"></div>
      </div>
    `;
    animateEnter(el.viewWorkstreams);
    document.getElementById('new-workstream-btn').addEventListener('click', () => openWorkstreamModal(null));
    renderWorkstreamIndex();
    renderWorkstreamDetailPanel();
  }

  function renderWorkstreamIndex() {
    const indexEl = document.getElementById('workstream-index');
    if (!indexEl) return;
    indexEl.innerHTML = state.workstreams.map((ws) => `
      <div class="workstream-row ${ws.id === state.selectedWorkstreamId ? 'active' : ''}" data-id="${ws.id}">
        ${WorkstreamStatusIndicator(ws.status)}
        <div class="info">
          <div class="name">${escapeHtml(ws.name)}</div>
          <div class="meta">${ws.agentCount} agent${ws.agentCount === 1 ? '' : 's'}${ws.archived ? ' · archived' : ''}</div>
        </div>
        <div class="count">${ws.runCount}</div>
      </div>`).join('');
    indexEl.querySelectorAll('.workstream-row').forEach((rowEl) => {
      rowEl.addEventListener('click', () => selectWorkstream(rowEl.dataset.id));
    });
  }

  function selectWorkstream(id) {
    const sameWs = id === state.selectedWorkstreamId;
    state.selectedWorkstreamId = id;
    state.workstreamsShowingDetail = true;
    document.getElementById('workstream-index')?.classList.add('has-detail');
    document.getElementById('workstream-detail-panel')?.classList.add('showing');
    renderWorkstreamIndex();
    if (!sameWs) renderWorkstreamDetailPanel();
  }

  function renderWorkstreamDetailPanel() {
    const ws = getWorkstream(state.selectedWorkstreamId);
    const panel = document.getElementById('workstream-detail-panel');
    if (!ws || !panel) return;

    const memberAgents = state.agents.filter((a) => a.workstreamId === ws.id);
    const relatedActivity = state.activity.filter((e) => e.details?.workstreamId === ws.id).slice(0, 6);
    const cost = fmtCost(ws.cost);

    panel.innerHTML = `
      <div class="detail-panel">
        <button class="detail-back" id="ws-detail-back">&larr; All workstreams</button>
        <div class="detail-header">
          <div>
            <h2 class="detail-name">${escapeHtml(ws.name)}</h2>
            <div class="detail-role">${escapeHtml(ws.description || 'No description set')}</div>
            <div class="detail-status-row">${WorkstreamStatusIndicator(ws.status)}</div>
          </div>
          <div class="detail-actions">
            <button class="btn" id="ws-edit-btn">Edit</button>
            <button class="btn" id="ws-archive-btn">${ws.archived ? 'Unarchive' : 'Archive'}</button>
          </div>
        </div>

        <div class="detail-data">
          ${DataRow('Owner', ws.owner ? escapeHtml(ws.owner) : 'Unassigned', !ws.owner)}
          ${DataRow('Agents', String(ws.agentCount))}
          ${DataRow('Runs', `${ws.runCount} total`)}
          ${DataRow('Completed / failed / cancelled', `${ws.completedRuns} / ${ws.failedRuns} / ${ws.cancelledRuns}`)}
          ${DataRow('Execution success', fmtPercent(ws.executionSuccessRate))}
          ${DataRow('Cost', cost.full)}
          ${DataRow('Progress', 'Progress unavailable', true)}
          ${DataRow('Last activity', ws.lastActivity ? fmtDateTime(ws.lastActivity) : 'No activity yet', !ws.lastActivity)}
        </div>
        ${cost.supporting ? `<p class="footnote" style="margin-top:-20px;margin-bottom:24px;">${escapeHtml(cost.supporting)}</p>` : ''}
        <p class="footnote" style="margin-top:-20px;margin-bottom:24px;">Progress requires a defined scope of planned work, which isn't tracked yet — this reflects run outcomes only.</p>

        <div class="detail-columns">
          <div>
            <p class="section-title">Participating agents</p>
            ${memberAgents.length === 0 ? EmptyState('No agents assigned yet.') : `
              <ul class="attention-list" id="ws-agent-list">${memberAgents.map((a) => `
                <li class="attention-item" data-agent-id="${a.id}" style="cursor:pointer;">
                  ${StatusIndicator(statusOf(a.id))}
                  <div class="body"><div class="title">${escapeHtml(a.name)}</div><div class="meta">${escapeHtml(a.role || a.provider)}</div></div>
                </li>`).join('')}</ul>`}
          </div>
          <div>
            <p class="section-title">Recent activity</p>
            ${relatedActivity.length === 0 ? EmptyState('No activity yet.') : `
              <ul class="mini-activity">${relatedActivity.map((e) => `
                <li class="mini-activity-item">
                  <span class="time">${fmtTime(e.ts)}</span>
                  <span class="desc">${escapeHtml(humanizeEvent(e))}</span>
                </li>`).join('')}</ul>`}
          </div>
        </div>
      </div>
    `;

    document.getElementById('ws-detail-back').addEventListener('click', () => {
      state.workstreamsShowingDetail = false;
      document.getElementById('workstream-index')?.classList.remove('has-detail');
      document.getElementById('workstream-detail-panel')?.classList.remove('showing');
    });
    document.getElementById('ws-edit-btn').addEventListener('click', () => openWorkstreamModal(ws));
    document.getElementById('ws-archive-btn').addEventListener('click', () => toggleArchive(ws));
    panel.querySelectorAll('#ws-agent-list [data-agent-id]').forEach((li) => {
      li.addEventListener('click', () => {
        state.selectedAgentId = li.dataset.agentId;
        state.agentsShowingDetail = true;
        showView('agents');
      });
    });
  }

  async function toggleArchive(ws) {
    try {
      await api(`/api/workstreams/${ws.id}/${ws.archived ? 'unarchive' : 'archive'}`, { method: 'POST' });
      await refreshData();
      renderWorkstreamDetailPanel();
    } catch (err) {
      alert(`Failed to update workstream: ${err.message}`);
    }
  }

  function openWorkstreamModal(ws) {
    state.editingWorkstreamId = ws ? ws.id : null;
    el.wsModalTitle.textContent = ws ? `Edit ${ws.name}` : 'New Workstream';
    el.wsModalError.textContent = '';
    el.wsForm.reset();
    const override = ws ? (ws.statusOverride || '') : '';
    el.statusSegmented.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.status === override));
    el.statusOverrideInput.value = override;
    if (ws) {
      el.wsForm.name.value = ws.name;
      el.wsForm.description.value = ws.description || '';
      el.wsForm.owner.value = ws.owner || '';
    }
    el.wsModalOverlay.classList.remove('hidden');
    setTimeout(() => el.wsForm.name.focus(), 50);
  }

  function closeWorkstreamModal() {
    el.wsModalOverlay.classList.add('hidden');
    state.editingWorkstreamId = null;
  }

  el.statusSegmented.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.statusSegmented.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      el.statusOverrideInput.value = btn.dataset.status;
    });
  });

  el.wsModalCancel.addEventListener('click', closeWorkstreamModal);
  el.wsModalOverlay.addEventListener('click', (e) => { if (e.target === el.wsModalOverlay) closeWorkstreamModal(); });

  el.wsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(el.wsForm).entries());
    el.wsModalError.textContent = '';
    if (!payload.name || !payload.name.trim()) {
      el.wsModalError.textContent = 'Name is required.';
      return;
    }
    try {
      if (state.editingWorkstreamId) {
        await api(`/api/workstreams/${state.editingWorkstreamId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        const created = await api('/api/workstreams', { method: 'POST', body: JSON.stringify(payload) });
        state.selectedWorkstreamId = created.id;
        state.workstreamsShowingDetail = true;
      }
      closeWorkstreamModal();
      await refreshData();
      populateWorkstreamSelect();
    } catch (err) {
      el.wsModalError.textContent = err.message;
    }
  });

  // ---------------- Activity (two-level disclosure) ----------------

  const ACTIVITY_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'runs', label: 'Runs' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'changes', label: 'Agent changes' },
    { key: 'integrity', label: 'Integrity' },
  ];

  function renderActivity() {
    el.viewActivity.innerHTML = `
      <div class="view-header"><h2 class="view-heading">Activity</h2></div>
      <div class="activity-toolbar segmented" id="activity-filter">
        ${ACTIVITY_FILTERS.map((f) => `<button type="button" data-filter="${f.key}" class="${f.key === state.activityFilter ? 'active' : ''}">${f.label}</button>`).join('')}
      </div>
      <div class="activity-toolbar segmented" id="activity-grouping" style="margin-top:-10px;">
        <button type="button" data-grouped="0" class="${!state.activityGrouped ? 'active' : ''}">Flat</button>
        <button type="button" data-grouped="1" class="${state.activityGrouped ? 'active' : ''}">Grouped by workstream</button>
      </div>
      <div id="activity-list"></div>
    `;
    animateEnter(el.viewActivity);

    document.getElementById('activity-filter').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activityFilter = btn.dataset.filter;
        document.querySelectorAll('#activity-filter button').forEach((b) => b.classList.toggle('active', b === btn));
        renderActivityRows();
      });
    });
    document.getElementById('activity-grouping').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activityGrouped = btn.dataset.grouped === '1';
        document.querySelectorAll('#activity-grouping button').forEach((b) => b.classList.toggle('active', b === btn));
        renderActivityRows();
      });
    });
    renderActivityRows();
  }

  function wireActivityRowExpansion(container) {
    container.querySelectorAll('.activity-row-summary').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        const id = rowEl.closest('.activity-row').dataset.id;
        if (state.expandedActivity.has(id)) state.expandedActivity.delete(id);
        else state.expandedActivity.add(id);
        rowEl.closest('.activity-row').classList.toggle('expanded');
      });
    });
  }

  function renderActivityRows() {
    const list = document.getElementById('activity-list');
    if (!list) return;
    const filtered = state.activityFilter === 'all'
      ? state.activity
      : state.activity.filter((e) => eventCategory(e.action) === state.activityFilter);

    if (filtered.length === 0) {
      list.innerHTML = EmptyState('No activity in this filter yet.');
      return;
    }

    if (!state.activityGrouped) {
      list.innerHTML = `<div class="activity-list">${filtered.map((e) => activityRowHtml(e)).join('')}</div>`;
      wireActivityRowExpansion(list);
      return;
    }

    // Grouped: same events, same rows — just organized under the workstream
    // they were snapshotted to when the run happened. Underlying event data
    // is untouched; only presentation changes.
    const groups = new Map(); // workstreamId|'unassigned' -> events[]
    for (const e of filtered) {
      const key = e.details?.workstreamId || 'unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    // Named workstreams first (by most recent event), "Unassigned" last.
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (a === 'unassigned') return 1;
      if (b === 'unassigned') return -1;
      return groups.get(b)[0].ts - groups.get(a)[0].ts;
    });

    list.innerHTML = orderedKeys.map((key) => {
      const events = groups.get(key);
      const name = key === 'unassigned' ? 'Unassigned' : (getWorkstream(key)?.name || 'Unknown workstream');
      return `
        <div class="activity-group">
          <div class="activity-group-header">${escapeHtml(name)} <span class="count">· ${events.length} event${events.length === 1 ? '' : 's'}</span></div>
          <div class="activity-list">${events.map((e) => activityRowHtml(e)).join('')}</div>
        </div>`;
    }).join('');
    wireActivityRowExpansion(list);
  }

  function activityRowHtml(e) {
    const expanded = state.expandedActivity.has(e.id);
    const d = e.details || {};
    return `
      <div class="activity-row${e.flagged ? ' flagged' : ''}${expanded ? ' expanded' : ''}" data-id="${e.id}">
        <div class="activity-row-summary">
          <span class="time">${fmtDateTime(e.ts)}</span>
          <span class="flag-marker"></span>
          <span class="desc"><strong>${escapeHtml(e.actor)}</strong> — ${escapeHtml(humanizeEvent(e))}</span>
          <span class="chevron">›</span>
        </div>
        <div class="activity-row-detail">
          ${DataRow('Event type', escapeHtml(e.action))}
          ${DataRow('Timestamp', new Date(e.ts).toISOString())}
          ${d.runId ? DataRow('Run ID', `<span style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(d.runId.slice(0, 8))}</span>`) : ''}
          ${d.provider ? DataRow('Provider', escapeHtml(d.provider)) : ''}
          ${d.model ? DataRow('Model', escapeHtml(d.model)) : ''}
          ${d.inputTokens != null ? DataRow('Tokens', `${fmtTokens(d.inputTokens)} / ${fmtTokens(d.outputTokens)}`) : ''}
          ${d.costUsd !== undefined ? DataRow('Cost', fmtMoney(d.costUsd)) : ''}
          ${d.error ? DataRow('Error', escapeHtml(d.error)) : ''}
          ${e.flagged ? DataRow('Flag reason', escapeHtml(e.flagReason || '')) : ''}
        </div>
      </div>`;
  }

  // ---------------- Modal / form ----------------

  function fieldsForProvider(provider) {
    const isCustom = provider === 'custom';
    el.modelField.classList.toggle('field-hidden', isCustom);
    el.systemField.classList.toggle('field-hidden', isCustom);
    el.taskField.classList.toggle('field-hidden', isCustom);
    el.tokensField.classList.toggle('field-hidden', isCustom);
    el.commandField.classList.toggle('field-hidden', !isCustom);
    el.providerInput.value = provider;
  }

  el.providerSegmented.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.providerSegmented.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      fieldsForProvider(btn.dataset.provider);
    });
  });

  function populateWorkstreamSelect() {
    if (!el.workstreamSelect) return;
    const current = el.workstreamSelect.value;
    el.workstreamSelect.innerHTML = '<option value="">Unassigned</option>' +
      state.workstreams.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
    if (state.workstreams.some((w) => w.id === current)) el.workstreamSelect.value = current;
  }

  function openModal(agent) {
    state.editingId = agent ? agent.id : null;
    el.modalTitle.textContent = agent ? `Edit ${agent.name}` : 'New Agent';
    el.modalError.textContent = '';
    el.form.reset();
    const provider = agent ? agent.provider : 'anthropic';
    el.providerSegmented.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));
    if (agent) {
      el.form.name.value = agent.name;
      el.form.role.value = agent.role || '';
      el.form.model.value = agent.model || '';
      el.form.systemPrompt.value = agent.systemPrompt || '';
      el.form.task.value = agent.task || '';
      el.form.command.value = agent.command || '';
      el.form.maxTokens.value = agent.maxTokens || 1024;
      el.workstreamSelect.value = agent.workstreamId || '';
    } else {
      el.form.maxTokens.value = 1024;
      el.workstreamSelect.value = '';
    }
    fieldsForProvider(provider);
    el.modalOverlay.classList.remove('hidden');
    setTimeout(() => el.form.name.focus(), 50);
  }

  function closeModal() {
    el.modalOverlay.classList.add('hidden');
    state.editingId = null;
  }

  el.newAgentBtn.addEventListener('click', () => openModal(null));
  el.modalCancel.addEventListener('click', closeModal);
  el.modalOverlay.addEventListener('click', (e) => { if (e.target === el.modalOverlay) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el.modalOverlay.classList.contains('hidden')) closeModal();
      if (!el.confirmOverlay.classList.contains('hidden')) el.confirmCancel.click();
    }
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(el.form).entries());
    el.modalError.textContent = '';
    if (!payload.name || !payload.name.trim()) {
      el.modalError.textContent = 'Name is required.';
      el.form.name.classList.add('invalid');
      el.form.name.focus();
      return;
    }
    el.form.name.classList.remove('invalid');
    try {
      if (state.editingId) {
        await api(`/api/agents/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        const created = await api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
        state.selectedAgentId = created.id;
        state.agentsShowingDetail = true;
      }
      closeModal();
      await refreshData();
      if (state.view === 'agents' && state.selectedAgentId) {
        await loadAgentDetail(state.selectedAgentId);
        renderAgentDetailPanel();
      }
    } catch (err) {
      el.modalError.textContent = err.message;
    }
  });

  // ---------------- Master render ----------------

  function render() {
    renderSystemLine();
    if (state.view === 'command') renderCommand();
    else if (state.view === 'workstreams') renderWorkstreams();
    else if (state.view === 'agents') renderAgents();
    else if (state.view === 'activity') renderActivity();
  }

  // ---------------- WebSocket ----------------

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'hello') {
        state.statuses = msg.statuses;
        render();
      } else if (msg.type === 'status') {
        const prev = state.statuses[msg.agentId]?.status;
        state.statuses[msg.agentId] = { status: msg.status };
        if (prev === 'running' && msg.status !== 'running') {
          await refreshData();
          if (state.view === 'agents' && state.selectedAgentId === msg.agentId) {
            await loadAgentDetail(msg.agentId);
            renderAgentDetailPanel();
          }
        } else {
          render();
          if (state.view === 'agents' && state.selectedAgentId === msg.agentId) {
            const statusEl = document.querySelector('.detail-status-row .status');
            if (statusEl) {
              statusEl.className = `status status-${msg.status} flash`;
              statusEl.textContent = statusLabel(msg.status);
            }
          }
        }
      } else if (msg.type === 'log') {
        if (state.view === 'agents' && state.selectedAgentId === msg.agentId) {
          const terminal = document.getElementById('terminal');
          if (terminal) {
            const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 20;
            terminal.textContent += msg.chunk;
            if (atBottom) terminal.scrollTop = terminal.scrollHeight;
          }
        }
      } else if (msg.type === 'event') {
        state.activity.unshift(msg.event);
        state.activity = state.activity.slice(0, 200);
        if (state.view === 'command') renderCommand();
        else if (state.view === 'activity') {
          renderActivityRows();
          const row = document.querySelector(`.activity-row[data-id="${msg.event.id}"]`);
          if (row && !prefersReducedMotion) row.classList.add('new-event');
        } else if (state.view === 'workstreams' && state.workstreamsShowingDetail) {
          renderWorkstreamDetailPanel();
        }
      }
    });

    ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  }

  // ---------------- Clock / system line ----------------

  function tickClock() {
    el.clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  function renderSystemLine() {
    const s = state.summary;
    if (!s) return;
    const healthy = !s.needsAttention;
    el.systemLine.innerHTML = `<span class="${healthy ? 'healthy' : 'degraded'}">${healthy ? 'System healthy' : 'System needs attention'}</span> · <strong>${s.active}</strong> active · ${fmtCost(s.cost).compact} today`;
  }

  setInterval(tickClock, 1000);
  tickClock();

  (async function init() {
    el.viewCommand.innerHTML = loadingSkeleton();
    await loadAll();
    render();
    connectWS();
    setInterval(async () => {
      state.summary = await api('/api/summary');
      renderSystemLine();
    }, 30000);
  })();
})();
