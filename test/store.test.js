const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { addAgent, findAgent, initialize, listAgents, saveRun } = require("../lib/store");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-terminal-"));
}

test("initializes an empty agent registry", () => {
  const directory = temporaryDirectory();
  initialize(directory);
  assert.deepEqual(listAgents(directory), []);
});

test("adds and retrieves an agent", () => {
  const directory = temporaryDirectory();
  const agent = { name: "hello", command: ["echo", "hello"] };
  addAgent(directory, agent);
  assert.deepEqual(findAgent(directory, "hello"), agent);
});

test("rejects duplicate agent names", () => {
  const directory = temporaryDirectory();
  const agent = { name: "hello", command: ["echo", "hello"] };
  addAgent(directory, agent);
  assert.throws(() => addAgent(directory, agent), /already exists/);
});

test("writes run logs without using agent names as paths", () => {
  const directory = temporaryDirectory();
  saveRun(directory, { agent: "../outside", startedAt: "2026-07-25T14:00:00.000Z" });

  const files = fs.readdirSync(path.join(directory, ".agent-terminal", "runs"));
  assert.deepEqual(files, ["2026-07-25T14-00-00-000Z-.._outside.json"]);
});
