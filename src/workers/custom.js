const { spawn } = require('child_process');

// Phase 4.1 — deny-by-default environment for custom-command agents.
//
// The prior implementation passed `env: process.env` — the FULL server
// environment, including ANTHROPIC_API_KEY / OPENAI_API_KEY — directly to
// every custom shell command. This was verified live during the safety
// review: a custom agent running `echo $ANTHROPIC_API_KEY` printed the real
// key. That is not a hypothetical external-attacker scenario; it means the
// system's own agents could read the credentials that fund their own
// execution. Only an explicit, minimal allowlist is passed through now.
const ALLOWED_ENV_VARS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL'];

function minimalEnv() {
  const env = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// Phase 4.4 — output caps. Unbounded stdout/stderr from a runaway or
// looping command could otherwise exhaust disk/memory with nobody watching.
const MAX_OUTPUT_BYTES = Number(process.env.RUCKER_MAX_OUTPUT_BYTES) || 1_000_000; // 1MB default

// Phase 4.2 — full process-tree termination, not just the shell wrapper.
// `detached: true` on POSIX makes the child the leader of a new process
// group; killing with a NEGATIVE pid targets the whole group, so a
// grandchild (e.g. `sleep` under `/bin/sh -c "sleep 5"`) is reliably
// reached even though Node only ever held a handle to the shell. Graceful
// SIGTERM first, forced SIGKILL only if the group hasn't exited within the
// grace period — every step is reported back so the caller can log exactly
// what happened, not just "it's stopped now."
function terminateProcessGroup(child, { gracePeriodMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve({ method: 'already-exited' });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Group already gone — fine, the exit handler below will resolve.
      }
    }, gracePeriodMs);

    child.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ method: 'terminated' });
    });

    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ method: 'kill-failed', error: err.message });
      }
    }
  });
}

function runCustom({ agent, onLog, runtime }) {
  return new Promise((resolve, reject) => {
    if (!agent.command || !agent.command.trim()) {
      reject(new Error('command is required for custom agents'));
      return;
    }

    const child = spawn(agent.command, {
      shell: true,
      env: minimalEnv(),
      detached: true, // process-group leader, so termination can reach the whole tree
    });
    runtime.child = child;

    let outputBytes = 0;
    let truncated = false;
    const emit = (chunk) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        runtime.outputTruncated = true;
        onLog('\n\n[output truncated — run exceeded the output size limit]\n');
        return;
      }
      const text = chunk.toString();
      const bytes = Buffer.byteLength(text);
      outputBytes += bytes;
      if (bytes > remaining) {
        onLog(text.slice(0, remaining)); // best-effort: preserve the head up to the cap
        truncated = true;
        runtime.outputTruncated = true;
        onLog('\n\n[output truncated — run exceeded the output size limit]\n');
      } else {
        onLog(text);
      }
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);

    child.on('error', (err) => reject(err));

    child.on('close', (code, signal) => {
      runtime.child = null;
      if (signal) {
        const err = new Error(`process terminated by signal ${signal}`);
        err.name = 'AbortError';
        reject(err);
        return;
      }
      if (code !== 0) {
        reject(new Error(`process exited with code ${code}`));
        return;
      }
      onLog(`\n\n[done] exit_code=${code}`);
      resolve();
    });
  });
}

module.exports = runCustom;
module.exports.terminateProcessGroup = terminateProcessGroup;
module.exports.minimalEnv = minimalEnv;
module.exports.ALLOWED_ENV_VARS = ALLOWED_ENV_VARS;
module.exports.MAX_OUTPUT_BYTES = MAX_OUTPUT_BYTES;
