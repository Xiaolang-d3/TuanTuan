import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Keep legacy names in one resolver; explicitly set new values always win.
export function desktopEnv(suffix, env = process.env) {
  return env[`TUANTUAN_${suffix}`] ?? env[`CAREERLOOP_${suffix}`];
}

export function resolvePython(root, platform = process.platform, override = desktopEnv('PYTHON')) {
  const suffix = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const candidates = override ? [resolve(override)] : [
    join(root, 'backend', '.venv', ...suffix), join(root, '.venv', ...suffix)
  ];
  const python = candidates.find(p => existsSync(p) && statSync(p).isFile());
  if (!python) throw new Error('Python environment not found. Create .venv or set TUANTUAN_PYTHON to an interpreter with backend dependencies.');
  return python;
}

export function stopDevChild(child, signal = 'SIGTERM') {
  if (process.platform !== 'win32') {
    child.kill(signal);
    return Promise.resolve();
  }
  // Windows kill() terminates only one process. Include Vite, Cargo and API children.
  return new Promise((resolveStop, reject) => {
    const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore'
    });
    stop.on('error', reject);
    stop.on('exit', code => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        reject(new Error(`Failed to terminate development process tree (taskkill exit ${code})`));
      } else resolveStop();
    });
  });
}

function main() {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, [join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    'dev', '--config', 'src-tauri/tauri.dev.conf.json', ...process.argv.slice(2)], {
    cwd: desktop, stdio: 'inherit', env: { ...process.env }
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    stopDevChild(child, signal).catch(error => { console.error(error.message); process.exitCode = 1; });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
