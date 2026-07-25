#!/usr/bin/env node
const { addAgent, findAgent, initialize, listAgents, saveRun } = require("../lib/store");
const { runAgent } = require("../lib/runner");

const [command, ...arguments_] = process.argv.slice(2);
const baseDirectory = process.cwd();

function usage() {
  console.log(`Usage:
  agent-terminal init
  agent-terminal add <name> -- <executable> [arguments...]
  agent-terminal list
  agent-terminal show <name>
  agent-terminal run <name> --confirm`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

try {
  switch (command) {
    case "init":
      initialize(baseDirectory);
      console.log("Initialized .agent-terminal/");
      break;
    case "add": {
      const separator = arguments_.indexOf("--");
      const [name] = arguments_;
      const executable = arguments_.slice(separator + 1);
      if (!name || separator < 1 || executable.length === 0) {
        throw new Error("Expected a name and command after --.");
      }
      addAgent(baseDirectory, { name, command: executable });
      console.log(`Added agent "${name}".`);
      break;
    }
    case "list": {
      const agents = listAgents(baseDirectory);
      if (agents.length === 0) {
        console.log("No agents registered.");
      } else {
        agents.forEach((agent) => console.log(`${agent.name}\t${agent.command.join(" ")}`));
      }
      break;
    }
    case "show": {
      const agent = findAgent(baseDirectory, arguments_[0]);
      if (!agent) throw new Error(`Agent "${arguments_[0]}" was not found.`);
      console.log(JSON.stringify(agent, null, 2));
      break;
    }
    case "run": {
      const name = arguments_[0];
      const agent = findAgent(baseDirectory, name);
      if (!agent) throw new Error(`Agent "${name}" was not found.`);
      if (!arguments_.includes("--confirm")) {
        throw new Error(`Refusing to execute "${name}" without --confirm.`);
      }
      const run = runAgent(agent);
      saveRun(baseDirectory, run);
      process.stdout.write(run.stdout || "");
      process.stderr.write(run.stderr || "");
      if (run.error) throw new Error(run.error);
      process.exitCode = run.exitCode ?? 1;
      break;
    }
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  fail(error.message);
}
