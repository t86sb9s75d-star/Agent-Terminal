const { spawnSync } = require("node:child_process");

const MAX_RUN_DURATION_MS = 60_000;

function runAgent(agent) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(agent.command[0], agent.command.slice(1), {
    encoding: "utf8",
    shell: false,
    timeout: MAX_RUN_DURATION_MS,
  });

  return {
    agent: agent.name,
    command: agent.command,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

module.exports = { runAgent };
