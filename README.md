# Agent-Terminal

A localized, harnessed and secured HUB to store, operate, and improve your agents cohesively, and efficiently.

## Starter CLI

Agent Terminal starts as a local, dependency-free command-line registry. Agent definitions and run logs stay in `.agent-terminal/` in the working directory.

```sh
npm install
npx agent-terminal init
npx agent-terminal add greeting -- echo "Hello from an agent"
npx agent-terminal list
npx agent-terminal run greeting --confirm
```

Commands are executed without a shell and require `--confirm` every time. Each run is recorded under `.agent-terminal/runs/`.

## Development

```sh
npm test
```
