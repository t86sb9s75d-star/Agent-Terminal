(() => {
  const state = {
    agents: [],
    statuses: {},
    selectedId: null,
    editingId: null,
  };

  const el = {
    providerBadges: document.getElementById('provider-badges'),
    agentList: document.getElementById('agent-list'),
    emptyState: document.getElementById('empty-state'),
    agentPanel: document.getElementById('agent-panel'),
    agentName: document.getElementById('agent-name'),
    agentProvider: document.getElementById('agent-provider'),
    agentStatus: document.getElementById('agent-status'),
    terminal: document.getElementById('terminal'),
    startBtn: document.getElementById('start-btn'),
    stopBtn: document.getElementById('stop-btn'),
    editBtn: document.getElementById('edit-btn'),
    deleteBtn: document.getElementById('delete-btn'),
    newAgentBtn: document.getElementById('new-agent-btn'),
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

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error || message;
      } catch {}
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

  async function loadProviders() {
    const providers = await api('/api/providers');
    el.providerBadges.innerHTML = '';
    for (const [name, ok] of Object.entries(providers)) {
      const span = document.createElement('span');
      span.className = 'provider-badge' + (ok ? ' ok' : '');
      span.textContent = `${name}${ok ? '' : ' (unset)'}`;
      el.providerBadges.appendChild(span);
    }
  }

  async function loadAgents() {
    const agents = await api('/api/agents');
    state.agents = agents;
    for (const a of agents) {
      state.statuses[a.id] = { status: a.status || 'idle' };
    }
    renderSidebar();
  }

  function renderSidebar() {
    el.agentList.innerHTML = '';
    for (const agent of state.agents) {
      const item = document.createElement('div');
      item.className = 'agent-item' + (agent.id === state.selectedId ? ' active' : '');
      item.dataset.id = agent.id;

      const dot = document.createElement('span');
      dot.className = `dot ${statusOf(agent.id)}`;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = agent.name;
      const provider = document.createElement('div');
      provider.className = 'provider';
      provider.textContent = agent.provider;
      meta.append(name, provider);

      item.append(dot, meta);
      item.addEventListener('click', () => selectAgent(agent.id));
      el.agentList.appendChild(item);
    }
  }

  async function selectAgent(id) {
    state.selectedId = id;
    renderSidebar();
    const agent = getAgent(id);
    if (!agent) return;

    el.emptyState.classList.add('hidden');
    el.agentPanel.classList.remove('hidden');
    el.agentName.textContent = agent.name;
    el.agentProvider.textContent = agent.provider;
    updateStatusUI(id);

    el.terminal.textContent = 'loading logs...';
    try {
      const logs = await api(`/api/agents/${id}/logs`);
      el.terminal.textContent = logs || '(no output yet)';
      el.terminal.scrollTop = el.terminal.scrollHeight;
    } catch (err) {
      el.terminal.textContent = `failed to load logs: ${err.message}`;
    }
  }

  function updateStatusUI(id) {
    if (id !== state.selectedId) return;
    const status = statusOf(id);
    el.agentStatus.textContent = status;
    el.agentStatus.className = `status-badge ${status}`;
    el.startBtn.disabled = status === 'running';
    el.stopBtn.disabled = status !== 'running';
    el.editBtn.disabled = status === 'running';
    el.deleteBtn.disabled = status === 'running';
  }

  el.startBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      el.terminal.textContent = '';
      await api(`/api/agents/${state.selectedId}/start`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to start: ${err.message}`);
    }
  });

  el.stopBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      await api(`/api/agents/${state.selectedId}/stop`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to stop: ${err.message}`);
    }
  });

  el.deleteBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    if (!confirm('Delete this agent and its logs?')) return;
    try {
      await api(`/api/agents/${state.selectedId}`, { method: 'DELETE' });
      state.agents = state.agents.filter((a) => a.id !== state.selectedId);
      state.selectedId = null;
      el.agentPanel.classList.add('hidden');
      el.emptyState.classList.remove('hidden');
      renderSidebar();
    } catch (err) {
      alert(`Failed to delete: ${err.message}`);
    }
  });

  // --- Modal / form ---
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
  el.editBtn.addEventListener('click', () => {
    const agent = getAgent(state.selectedId);
    if (agent) openModal(agent);
  });
  el.modalCancel.addEventListener('click', closeModal);
  el.modalOverlay.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(el.form);
    const payload = Object.fromEntries(formData.entries());
    el.modalError.textContent = '';
    try {
      if (state.editingId) {
        const updated = await api(`/api/agents/${state.editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const idx = state.agents.findIndex((a) => a.id === updated.id);
        state.agents[idx] = { ...state.agents[idx], ...updated };
        if (state.selectedId === updated.id) selectAgent(updated.id);
      } else {
        const created = await api('/api/agents', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        state.agents.push(created);
        state.statuses[created.id] = { status: 'idle' };
      }
      renderSidebar();
      closeModal();
    } catch (err) {
      el.modalError.textContent = err.message;
    }
  });

  // --- WebSocket live updates ---
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hello') {
        state.statuses = msg.statuses;
        renderSidebar();
        if (state.selectedId) updateStatusUI(state.selectedId);
      } else if (msg.type === 'status') {
        state.statuses[msg.agentId] = { status: msg.status, startedAt: state.statuses[msg.agentId]?.startedAt };
        renderSidebar();
        updateStatusUI(msg.agentId);
      } else if (msg.type === 'log') {
        if (msg.agentId === state.selectedId) {
          const atBottom = el.terminal.scrollTop + el.terminal.clientHeight >= el.terminal.scrollHeight - 20;
          el.terminal.textContent += msg.chunk;
          if (atBottom) el.terminal.scrollTop = el.terminal.scrollHeight;
        }
      }
    });

    ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  }

  (async function init() {
    await Promise.all([loadProviders(), loadAgents()]);
    connectWS();
  })();
})();
