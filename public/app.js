(() => {
  const OPERATOR_NAME = 'Brody';

  const state = {
    agents: [],
    statuses: {},
    summary: null,
    activity: [],
    view: 'command',
    selectedAgentId: null,
    editingId: null,
  };

  const el = {
    systemLine: document.getElementById('system-line'),
    clock: document.getElementById('topbar-clock'),
    railItems: Array.from(document.querySelectorAll('.rail-item[data-view]')),
    newAgentBtn: document.getElementById('new-agent-btn'),
    viewCommand: document.getElementById('view-command'),
    viewAgents: document.getElementById('view-agents'),
    viewActivity: document.getElementById('view-activity'),
    viewDetail: document.getElementById('view-agent-detail'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalCancel: document.getElementById('modal-cancel'),
    modalError: document.getElementById('modal-error'),
    form: document.getElementById('agent-form'),
    providerSelect: document.getElementById('provider-select'),
    modelField: document.getElementById('model-field'),
    systemField: document.getElementById('system-field'),
    taskField: document.getElementById('task-field'),
    commandField: document.getElementById('command-field'),
    tokensField: document.getElementById('tokens-field'),
  };

  // ---------------- Formatting ----------------

  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
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
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
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

  function getAgent(id) {
    return state.agents.find((a) => a.id === id);
  }

  function statusOf(id) {
    return state.statuses[id]?.status || 'idle';
  }

  async function loadAll() {
    const [summary, agents, activity] = await Promise.all([
      api('/api/summary'),
      api('/api/agents'),
      api('/api/activity?limit=60'),
    ]);
    state.summary = summary;
    state.agents = agents;
    state.activity = activity;
    for (const a of agents) state.statuses[a.id] = { status: a.status || 'idle' };
  }

  async function refreshData() {
    const [summary, agents] = await Promise.all([api('/api/summary'), api('/api/agents')]);
    state.summary = summary;
    state.agents = agents;
    for (const a of agents) state.statuses[a.id] = { status: a.status || 'idle' };
    render();
  }

  // ---------------- Nav ----------------

  function showView(name) {
    state.view = name;
    el.railItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name || (name === 'detail' && btn.dataset.view === 'agents')));
    el.viewCommand.classList.toggle('hidden', name !== 'command');
    el.viewAgents.classList.toggle('hidden', name !== 'agents');
    el.viewActivity.classList.toggle('hidden', name !== 'activity');
    el.viewDetail.classList.toggle('hidden', name !== 'detail');
    render();
  }

  el.railItems.forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // ---------------- Render: Command ----------------

  function statusLabel(status) {
    return { idle: 'Idle', running: 'Running', completed: 'Completed', error: 'Failed', cancelled: 'Stopped' }[status] || status;
  }

  function humanizeEvent(evt) {
    const name = evt.details?.agentName || evt.details?.name || 'An agent';
    const map = {
      'run.started': `${name} started a run`,
      'run.completed': `${name} completed a run${evt.details?.costUsd ? ` · ${fmtMoney(evt.details.costUsd)}` : ''}`,
      'run.cancelled': `${name}'s run was stopped`,
      'run.failed': `${name}'s run failed${evt.details?.error ? ` — ${evt.details.error}` : ''}`,
      'run.stop_requested': `Stop requested for ${name}`,
      'agent.created': `${name} was registered`,
      'agent.updated': `${name} was updated`,
      'agent.deleted': `${name} was deleted`,
      'registry.external_modification_detected': 'Agent registry was modified outside the API',
    };
    return map[evt.action] || `${evt.action} — ${name}`;
  }

  function renderCommand() {
    const s = state.summary || {};
    const flagged = state.activity.filter((e) => e.flagged).slice(0, 6);
    const recent = state.activity.slice(0, 7);

    el.viewCommand.innerHTML = `
      <p class="greeting-eyebrow">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1 class="greeting-headline">${greetingWord()}, ${OPERATOR_NAME}</h1>
      <p class="greeting-sub">
        <span class="${s.needsAttention ? 'degraded' : 'healthy'}">${s.needsAttention ? 'System needs attention' : 'System healthy'}</span>
        · ${s.active ?? 0} active · ${s.completedToday ?? 0} completed today${s.needsAttention ? ` · ${s.needsAttention} needs attention` : ''}
      </p>

      <div class="stat-row">
        <div class="stat"><div class="stat-value">${s.active ?? 0}</div><div class="stat-label">Active agents</div></div>
        <div class="stat"><div class="stat-value">${s.completedToday ?? 0}</div><div class="stat-label">Completed today</div></div>
        <div class="stat"><div class="stat-value">${s.needsAttention ?? 0}</div><div class="stat-label">Needs attention</div></div>
        <div class="stat"><div class="stat-value">${fmtMoney(s.costToday)}</div><div class="stat-label">Cost today</div></div>
        <div class="stat"><div class="stat-value ${s.executionSuccessRate == null ? 'na' : ''}">${fmtPercent(s.executionSuccessRate)}</div><div class="stat-label">Execution success</div></div>
      </div>

      <div class="panel-grid">
        <div>
          <p class="section-title">Needs your attention</p>
          ${flagged.length === 0
            ? '<p class="empty-note">Nothing needs your attention right now.</p>'
            : `<ul class="attention-list">${flagged.map((e) => `
                <li class="attention-item">
                  <span class="marker">●</span>
                  <div class="body">
                    <div class="title">${escapeHtml(humanizeEvent(e))}</div>
                    <div class="meta">${fmtTime(e.ts)} · ${escapeHtml(e.flagReason || '')}</div>
                  </div>
                </li>`).join('')}</ul>`}
        </div>
        <div>
          <p class="section-title">Recent activity</p>
          ${recent.length === 0
            ? '<p class="empty-note">No activity yet.</p>'
            : `<ul class="mini-activity">${recent.map((e) => `
                <li class="mini-activity-item">
                  <span class="time">${fmtTime(e.ts)}</span>
                  <span class="desc">${escapeHtml(humanizeEvent(e))}</span>
                </li>`).join('')}</ul>`}
        </div>
      </div>
      <p class="empty-note" style="margin-top:4px;">Task quality is not measured yet — this reflects execution outcomes only, not answer quality.</p>
    `;
  }

  // ---------------- Render: Agents ----------------

  function renderAgents() {
    el.viewAgents.innerHTML = `
      <div class="view-header">
        <h2 class="view-heading">Agents</h2>
      </div>
      <div class="agent-grid" id="agent-grid"></div>
    `;
    const grid = document.getElementById('agent-grid');
    if (state.agents.length === 0) {
      grid.innerHTML = '<p class="empty-note">No agents registered yet. Create one to get started.</p>';
      return;
    }
    for (const agent of state.agents) {
      const status = statusOf(agent.id);
      const card = document.createElement('div');
      card.className = 'agent-card';
      const providerLine = agent.provider === 'custom'
        ? `<span><strong>custom</strong> command</span>`
        : `<span><strong>${escapeHtml(agent.provider)}</strong></span><span>${escapeHtml(agent.model || 'default model')}</span>`;
      card.innerHTML = `
        <div class="agent-card-top">
          <div class="agent-card-name">${escapeHtml(agent.name)}</div>
          <span class="status status-${status}">${statusLabel(status)}</span>
        </div>
        <div class="agent-card-role">${escapeHtml(agent.role || ' ')}</div>
        <div class="agent-card-meta">${providerLine}</div>
        <div class="agent-card-figures">
          <div class="agent-card-figure"><div class="value">${fmtMoney(agent.costToday)}</div><div class="label">Cost today</div></div>
          <div class="agent-card-figure"><div class="value">${fmtPercent(agent.executionSuccessRate)}</div><div class="label">Success</div></div>
          <div class="agent-card-figure"><div class="value">${agent.totalRuns ?? 0}</div><div class="label">Runs</div></div>
        </div>
      `;
      card.addEventListener('click', () => openAgentDetail(agent.id));
      grid.appendChild(card);
    }
  }

  // ---------------- Render: Agent detail ----------------

  let detailRunsCache = { runs: [], summary: {} };

  async function openAgentDetail(id) {
    state.selectedAgentId = id;
    showView('detail');
    try {
      const [runsData, logs] = await Promise.all([
        api(`/api/agents/${id}/runs`),
        api(`/api/agents/${id}/logs`),
      ]);
      detailRunsCache = runsData;
      renderAgentDetail(logs);
    } catch (err) {
      el.viewDetail.innerHTML = `<p class="empty-note">Failed to load agent: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderAgentDetail(logsText) {
    const agent = getAgent(state.selectedAgentId);
    if (!agent) {
      el.viewDetail.innerHTML = '<p class="empty-note">Agent not found.</p>';
      return;
    }
    const status = statusOf(agent.id);
    const summary = detailRunsCache.summary || {};
    const runs = detailRunsCache.runs || [];

    el.viewDetail.innerHTML = `
      <button class="detail-back" id="detail-back">&larr; Back to agents</button>
      <div class="detail-header">
        <div>
          <h2 class="detail-name">${escapeHtml(agent.name)}</h2>
          <div class="detail-role">${escapeHtml(agent.role || 'No role description set')}</div>
        </div>
        <div class="detail-actions">
          <button class="btn" id="start-btn" ${status === 'running' ? 'disabled' : ''}>Start</button>
          <button class="btn" id="stop-btn" ${status !== 'running' ? 'disabled' : ''}>Stop</button>
          <button class="btn" id="edit-btn" ${status === 'running' ? 'disabled' : ''}>Edit</button>
          <button class="btn btn-danger" id="delete-btn" ${status === 'running' ? 'disabled' : ''}>Delete</button>
        </div>
      </div>

      <div class="identity-grid">
        <div class="identity-field"><div class="label">Status</div><div class="value"><span class="status status-${status}">${statusLabel(status)}</span></div></div>
        <div class="identity-field"><div class="label">Provider</div><div class="value">${escapeHtml(agent.provider)}</div></div>
        <div class="identity-field"><div class="label">${agent.provider === 'custom' ? 'Command' : 'Model'}</div><div class="value">${escapeHtml(agent.provider === 'custom' ? agent.command : (agent.model || 'default'))}</div></div>
        <div class="identity-field"><div class="label">Registered</div><div class="value muted">${fmtDateTime(new Date(agent.createdAt).getTime())}</div></div>
        <div class="identity-field"><div class="label">Cost today</div><div class="value">${fmtMoney(summary.costToday)}</div></div>
        <div class="identity-field"><div class="label">Execution success</div><div class="value">${fmtPercent(summary.executionSuccessRate)}</div></div>
        <div class="identity-field"><div class="label">Runs completed</div><div class="value">${summary.runsCompleted ?? 0} of ${summary.totalRuns ?? 0}</div></div>
        <div class="identity-field"><div class="label">Task quality</div><div class="value muted">Not measured</div></div>
      </div>

      <div class="detail-columns">
        <div>
          <p class="section-title">Live output</p>
          <div class="terminal-wrap">
            <div class="terminal-header">stdout</div>
            <pre class="terminal" id="terminal">${escapeHtml(logsText || '(no output yet)')}</pre>
          </div>
        </div>
        <div>
          <p class="section-title">Run history</p>
          ${runs.length === 0 ? '<p class="empty-note">No runs yet.</p>' : `
            <table class="runs-table">
              <thead><tr><th>Started</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Outcome</th></tr></thead>
              <tbody>
                ${runs.map((r) => `
                  <tr>
                    <td>${fmtDateTime(r.startedAt)}</td>
                    <td>${fmtDuration(r.durationMs)}</td>
                    <td>${r.inputTokens != null ? `${fmtTokens(r.inputTokens)} / ${fmtTokens(r.outputTokens)}` : '—'}</td>
                    <td>${fmtMoney(r.costUsd)}</td>
                    <td><span class="status status-${r.status === 'completed' ? 'completed' : r.status === 'cancelled' ? 'cancelled' : r.status === 'running' ? 'running' : 'error'}">${statusLabel(r.status)}</span></td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
        </div>
      </div>
    `;

    document.getElementById('detail-back').addEventListener('click', () => showView('agents'));
    document.getElementById('start-btn').addEventListener('click', () => handleStart(agent.id));
    document.getElementById('stop-btn').addEventListener('click', () => handleStop(agent.id));
    document.getElementById('edit-btn').addEventListener('click', () => openModal(agent));
    document.getElementById('delete-btn').addEventListener('click', () => handleDelete(agent.id));

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

  async function handleDelete(id) {
    if (!confirm('Delete this agent and its history?')) return;
    try {
      await api(`/api/agents/${id}`, { method: 'DELETE' });
      state.agents = state.agents.filter((a) => a.id !== id);
      showView('agents');
      await refreshData();
    } catch (err) {
      alert(`Failed to delete: ${err.message}`);
    }
  }

  // ---------------- Render: Activity ----------------

  function renderActivity() {
    const agentOptions = state.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    el.viewActivity.innerHTML = `
      <div class="view-header">
        <h2 class="view-heading">Activity</h2>
      </div>
      <div class="activity-toolbar">
        <select id="activity-filter">
          <option value="">All agents</option>
          ${agentOptions}
        </select>
      </div>
      <div class="activity-list" id="activity-list"></div>
    `;
    document.getElementById('activity-filter').addEventListener('change', async (e) => {
      const agentId = e.target.value;
      const path = agentId ? `/api/activity?agentId=${agentId}&limit=200` : '/api/activity?limit=200';
      const events = await api(path);
      renderActivityRows(events);
    });
    renderActivityRows(state.activity);
  }

  function renderActivityRows(events) {
    const list = document.getElementById('activity-list');
    if (!list) return;
    if (events.length === 0) {
      list.innerHTML = '<p class="empty-note">No activity recorded yet.</p>';
      return;
    }
    list.innerHTML = events.map((e) => `
      <div class="activity-row ${e.flagged ? 'flagged' : ''}">
        <span class="time">${fmtDateTime(e.ts)}</span>
        <span class="flag-marker"></span>
        <span class="desc"><strong>${escapeHtml(e.actor)}</strong> — ${escapeHtml(humanizeEvent(e))}</span>
      </div>
    `).join('');
  }

  // ---------------- Modal ----------------

  function fieldsForProvider(provider) {
    const isCustom = provider === 'custom';
    el.modelField.classList.toggle('hidden', isCustom);
    el.systemField.classList.toggle('hidden', isCustom);
    el.taskField.classList.toggle('hidden', isCustom);
    el.tokensField.classList.toggle('hidden', isCustom);
    el.commandField.classList.toggle('hidden', !isCustom);
  }

  el.providerSelect.addEventListener('change', () => fieldsForProvider(el.providerSelect.value));

  function openModal(agent) {
    state.editingId = agent ? agent.id : null;
    el.modalTitle.textContent = agent ? `Edit ${agent.name}` : 'New Agent';
    el.modalError.textContent = '';
    el.form.reset();
    if (agent) {
      el.form.name.value = agent.name;
      el.form.role.value = agent.role || '';
      el.form.provider.value = agent.provider;
      el.form.model.value = agent.model || '';
      el.form.systemPrompt.value = agent.systemPrompt || '';
      el.form.task.value = agent.task || '';
      el.form.command.value = agent.command || '';
      el.form.maxTokens.value = agent.maxTokens || 1024;
    } else {
      el.form.provider.value = 'anthropic';
      el.form.maxTokens.value = 1024;
    }
    fieldsForProvider(el.form.provider.value);
    el.modalOverlay.classList.remove('hidden');
  }

  function closeModal() {
    el.modalOverlay.classList.add('hidden');
    state.editingId = null;
  }

  el.newAgentBtn.addEventListener('click', () => openModal(null));
  el.modalCancel.addEventListener('click', closeModal);
  el.modalOverlay.addEventListener('click', (e) => { if (e.target === el.modalOverlay) closeModal(); });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(el.form).entries());
    el.modalError.textContent = '';
    try {
      if (state.editingId) {
        await api(`/api/agents/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal();
      await refreshData();
      if (state.selectedAgentId) await openAgentDetail(state.selectedAgentId);
    } catch (err) {
      el.modalError.textContent = err.message;
    }
  });

  // ---------------- Master render ----------------

  function render() {
    renderSystemLine();
    if (state.view === 'command') renderCommand();
    else if (state.view === 'agents') renderAgents();
    else if (state.view === 'activity') renderActivity();
    // 'detail' view is rendered explicitly by openAgentDetail/renderAgentDetail
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
          if (state.view === 'detail' && state.selectedAgentId === msg.agentId) {
            await openAgentDetail(msg.agentId);
          }
        } else {
          render();
          if (state.view === 'detail' && state.selectedAgentId === msg.agentId) {
            const statusEl = document.querySelector('.detail-header .status');
            if (statusEl) {
              statusEl.className = `status status-${msg.status}`;
              statusEl.textContent = statusLabel(msg.status);
            }
          }
        }
      } else if (msg.type === 'log') {
        if (state.view === 'detail' && state.selectedAgentId === msg.agentId) {
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
        else if (state.view === 'activity') renderActivityRows(state.activity);
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
    el.systemLine.innerHTML = `<span class="${healthy ? 'healthy' : 'degraded'}">${healthy ? 'System healthy' : 'System needs attention'}</span> · <strong>${s.active}</strong> active · ${fmtMoney(s.costToday)} today`;
  }

  setInterval(tickClock, 1000);
  tickClock();

  (async function init() {
    await loadAll();
    render();
    connectWS();
    setInterval(async () => {
      state.summary = await api('/api/summary');
      renderSystemLine();
    }, 30000);
  })();
})();
