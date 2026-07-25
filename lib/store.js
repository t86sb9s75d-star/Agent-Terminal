const fs = require("node:fs");
const path = require("node:path");

const dataDirectory = (baseDirectory = process.cwd()) =>
  path.join(baseDirectory, ".agent-terminal");

const agentsPath = (baseDirectory) => path.join(dataDirectory(baseDirectory), "agents.json");

function initialize(baseDirectory) {
  fs.mkdirSync(dataDirectory(baseDirectory), { recursive: true });

  if (!fs.existsSync(agentsPath(baseDirectory))) {
    fs.writeFileSync(agentsPath(baseDirectory), "[]\n", "utf8");
  }
}

function listAgents(baseDirectory) {
  initialize(baseDirectory);
  return JSON.parse(fs.readFileSync(agentsPath(baseDirectory), "utf8"));
}

function addAgent(baseDirectory, agent) {
  const agents = listAgents(baseDirectory);

  if (agents.some((existing) => existing.name === agent.name)) {
    throw new Error(`An agent named "${agent.name}" already exists.`);
  }

  agents.push(agent);
  fs.writeFileSync(agentsPath(baseDirectory), `${JSON.stringify(agents, null, 2)}\n`, "utf8");
}

function findAgent(baseDirectory, name) {
  return listAgents(baseDirectory).find((agent) => agent.name === name);
}

function saveRun(baseDirectory, run) {
  const directory = path.join(dataDirectory(baseDirectory), "runs");
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${run.startedAt.replace(/[:.]/g, "-")}-${run.agent}.json`;
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

module.exports = { addAgent, dataDirectory, findAgent, initialize, listAgents, saveRun };
