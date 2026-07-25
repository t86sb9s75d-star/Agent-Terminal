# Agent Terminal

A localized, harnessed and secured hub to store, operate, and improve your AI agents cohesively and efficiently.

Agent Terminal is a self-hosted orchestration dashboard for running short-lived AI agents against multiple providers (Anthropic, OpenAI, or your own custom scripts) from one place — define an agent once, then start it, watch its output stream live, and stop it, all from the browser.

## Features

- **Agent registry** — define agents (name, provider, model, prompt/task or shell command) and persist them to disk.
- **Start / stop / status** — run agents on demand and track their lifecycle (idle, running, error).
- **Live log streaming** — agent output streams to the browser over WebSocket as it's produced, and is also persisted per-agent so you can revisit it later.
- **Multi-provider** — built-in runners for Anthropic and OpenAI (streaming chat completions), plus a `custom` provider that runs any local shell command as an agent.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in the API keys for the providers you plan to use
npm start
```

The dashboard is served at `http://127.0.0.1:4173` by default (override with `HOST`/`PORT` in `.env`).

## Agent types

| Provider    | What it does                                                                 | Required config              |
|-------------|-------------------------------------------------------------------------------|-------------------------------|
| `anthropic` | Streams a single-turn Claude completion for the agent's task/system prompt   | `ANTHROPIC_API_KEY`, `task`  |
| `openai`    | Streams a single-turn OpenAI chat completion                                  | `OPENAI_API_KEY`, `task`     |
| `custom`    | Spawns an arbitrary local shell command and streams its stdout/stderr        | `command`                    |

## Security note

Agent Terminal has no built-in authentication and the `custom` provider executes arbitrary shell commands you configure. It binds to `127.0.0.1` by default and is intended to run locally on a trusted machine — do not expose it directly to the internet without adding your own auth/reverse-proxy layer.

## Project layout

```
src/
  server.js        Express API + WebSocket server
  agentManager.js   Runtime lifecycle: start/stop, log buffering + persistence
  store.js          JSON-file backed agent registry
  workers/           One runner per provider (anthropic, openai, custom)
public/              Terminal-styled dashboard (vanilla JS, no build step)
data/                Runtime state: agents.json + per-agent log files (gitignored)
```
