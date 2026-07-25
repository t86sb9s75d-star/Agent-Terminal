const { spawn } = require('child_process');

function runCustom({ agent, onLog, runtime }) {
  return new Promise((resolve, reject) => {
    if (!agent.command || !agent.command.trim()) {
      reject(new Error('command is required for custom agents'));
      return;
    }

    const child = spawn(agent.command, {
      shell: true,
      env: process.env,
    });
    runtime.child = child;

    child.stdout.on('data', (data) => onLog(data.toString()));
    child.stderr.on('data', (data) => onLog(data.toString()));

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
