import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { desktopEnv, resolvePython, stopDevChild } from './dev.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tuantuan dev '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(p) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); return p; }
test('Windows discovers root virtualenv with spaces in path', t => {
  const r = fixture(t), p = file(join(r, '.venv', 'Scripts', 'python.exe'));
  assert.equal(resolvePython(r, 'win32', null), p);
});
test('Windows prefers backend virtualenv', t => {
  const r = fixture(t); file(join(r, '.venv', 'Scripts', 'python.exe'));
  const p = file(join(r, 'backend', '.venv', 'Scripts', 'python.exe'));
  assert.equal(resolvePython(r, 'win32', null), p);
});
test('Unix keeps backend virtualenv', t => {
  const r = fixture(t), p = file(join(r, 'backend', '.venv', 'bin', 'python'));
  assert.equal(resolvePython(r, 'darwin', null), p);
});
test('explicit interpreter takes priority and must exist', t => {
  const r = fixture(t), p = file(join(r, 'custom python', 'python.exe'));
  assert.equal(resolvePython(r, 'win32', p), p);
  assert.throws(() => resolvePython(r, 'win32', join(r, 'missing')), /TUANTUAN_PYTHON/);
});
test('missing virtualenv provides setup guidance', t => {
  assert.throws(() => resolvePython(fixture(t), 'win32', null), /TUANTUAN_PYTHON/);
});

test('Windows launcher stop terminates its complete child tree', { skip: process.platform !== 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    console.log(leaf.pid);
    setInterval(() => {}, 1000);
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [data] = await once(child.stdout, 'data');
  const leaf = Number(data.toString().trim());
  t.after(() => { try { process.kill(leaf); } catch {} try { child.kill(); } catch {} });
  await stopDevChild(child, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(leaf, 0); } catch { return; }
    await setTimeout(20);
  }
  assert.fail('Development child process survived tree termination');
});

test('new environment values win and legacy names only provide fallback', () => {
  for (const suffix of ['PYTHON', 'API_BASE']) {
    const current = 'TUANTUAN_' + suffix, legacy = 'CAREERLOOP_' + suffix;
    assert.equal(desktopEnv(suffix, { [current]: 'new', [legacy]: 'old' }), 'new');
    assert.equal(desktopEnv(suffix, { [legacy]: 'old' }), 'old');
    assert.equal(desktopEnv(suffix, { [current]: '', [legacy]: 'old' }), '');
    assert.equal(desktopEnv(suffix, {}), undefined);
  }
});
