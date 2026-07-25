const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const HASH_FILE = path.join(DATA_DIR, '.agents.hash');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AGENTS_FILE)) fs.writeFileSync(AGENTS_FILE, '[]', 'utf8');
}

function hashOf(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(AGENTS_FILE, 'utf8');
  try {
    const agents = JSON.parse(raw);
    // Non-destructive migration: agents saved before workstreams existed
    // simply don't have this field yet. Default it in memory rather than
    // rewriting the file — it becomes permanent only once the agent is
    // next actually saved (create/update).
    return agents.map((a) => (a.workstreamId !== undefined ? a : { ...a, workstreamId: null }));
  } catch {
    return [];
  }
}

function writeAll(agents) {
  ensureFile();
  const raw = JSON.stringify(agents, null, 2);
  fs.writeFileSync(AGENTS_FILE, raw, 'utf8');
  fs.writeFileSync(HASH_FILE, hashOf(raw), 'utf8');
}

// Detects whether agents.json was edited by something other than this module
// (e.g. hand-edited on disk) since the last write this process made.
// Returns { checked, tampered } — checked is false the very first time
// (no prior known-good hash to compare against).
function checkIntegrity() {
  ensureFile();
  const raw = fs.readFileSync(AGENTS_FILE, 'utf8');
  const actual = hashOf(raw);
  if (!fs.existsSync(HASH_FILE)) {
    fs.writeFileSync(HASH_FILE, actual, 'utf8');
    return { checked: false, tampered: false };
  }
  const expected = fs.readFileSync(HASH_FILE, 'utf8').trim();
  if (expected !== actual) {
    fs.writeFileSync(HASH_FILE, actual, 'utf8');
    return { checked: true, tampered: true };
  }
  return { checked: true, tampered: false };
}

const VALID_PROVIDERS = ['anthropic', 'openai', 'custom'];

function list() {
  return readAll();
}

function get(id) {
  return readAll().find((a) => a.id === id) || null;
}

function create(data) {
  if (!data.name || !data.name.trim()) throw new Error('name is required');
  if (!VALID_PROVIDERS.includes(data.provider)) {
    throw new Error(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  if (data.provider === 'custom' && !data.command) {
    throw new Error('command is required for custom agents');
  }
  if (data.provider !== 'custom' && !data.task) {
    throw new Error('task is required for anthropic/openai agents');
  }

  const agents = readAll();
  const agent = {
    id: crypto.randomUUID(),
    name: data.name.trim(),
    role: data.role ? data.role.trim() : '',
    provider: data.provider,
    model: data.model || null,
    systemPrompt: data.systemPrompt || '',
    task: data.task || '',
    command: data.command || '',
    maxTokens: data.maxTokens ? Number(data.maxTokens) : 1024,
    workstreamId: data.workstreamId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  agents.push(agent);
  writeAll(agents);
  return agent;
}

function update(id, data) {
  const agents = readAll();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error('agent not found');
  const existing = agents[idx];
  const updated = {
    ...existing,
    name: data.name !== undefined ? data.name.trim() : existing.name,
    role: data.role !== undefined ? data.role.trim() : existing.role,
    provider: data.provider !== undefined ? data.provider : existing.provider,
    model: data.model !== undefined ? data.model : existing.model,
    systemPrompt: data.systemPrompt !== undefined ? data.systemPrompt : existing.systemPrompt,
    task: data.task !== undefined ? data.task : existing.task,
    command: data.command !== undefined ? data.command : existing.command,
    maxTokens: data.maxTokens !== undefined ? Number(data.maxTokens) : existing.maxTokens,
    workstreamId: data.workstreamId !== undefined ? (data.workstreamId || null) : existing.workstreamId,
    updatedAt: new Date().toISOString(),
  };
  if (!VALID_PROVIDERS.includes(updated.provider)) {
    throw new Error(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  agents[idx] = updated;
  writeAll(agents);
  return updated;
}

function remove(id) {
  const agents = readAll();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) throw new Error('agent not found');
  writeAll(next);
}

module.exports = { list, get, create, update, remove, checkIntegrity, VALID_PROVIDERS };
