import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoClearKind, isFinishedEntry } from '../lib/auto-clear.js';
import { AUTO_CLEAR_DELAYS, normalizeAutoClear } from '../lib/prefs.js';

test('autoClearKind：只有 deploy / release 单独算，其它一律算打包', () => {
  assert.equal(autoClearKind({ kind: 'deploy' }), 'deploy');
  assert.equal(autoClearKind({ kind: 'release' }), 'release');
  assert.equal(autoClearKind({ kind: 'build' }), 'build');
  assert.equal(autoClearKind({ kind: 'launch' }), 'build');
  assert.equal(autoClearKind({}), 'build');
  assert.equal(autoClearKind({ kind: undefined }), 'build');
});

test('isFinishedEntry：成功 / 已停止算跑完', () => {
  assert.equal(isFinishedEntry({ state: 'success' }), true);
  assert.equal(isFinishedEntry({ state: 'stopped' }), true);
});

test('isFinishedEntry：失败与进行中的都不算（失败的要留在列表里看错误）', () => {
  for (const state of ['failed', 'running', 'building', 'stopping', 'exited', undefined, '']) {
    assert.equal(isFinishedEntry({ state }), false, `state=${String(state)}`);
  }
});

test('开关 + 类别：只有对应类别开着才会清这条（sweepAutoClear 的判定就是这个）', () => {
  const on = normalizeAutoClear({ build: true, deploy: false, release: true, delayMs: 15000 });
  const cases = [
    [{ kind: 'build', state: 'success' }, true],
    [{ kind: 'build', state: 'stopped' }, true],
    [{ kind: 'build', state: 'failed' }, false],
    [{ kind: 'deploy', state: 'success' }, false],
    [{ kind: 'release', state: 'success' }, true],
    [{ kind: 'release', state: 'running' }, false],
  ];
  for (const [entry, expected] of cases) {
    const wouldClear = on[autoClearKind(entry)] === true && isFinishedEntry(entry);
    assert.equal(wouldClear, expected, JSON.stringify(entry));
  }
});

test('延迟档位：面板下拉里的每一项 Host 都认', () => {
  for (const delay of AUTO_CLEAR_DELAYS) {
    assert.equal(normalizeAutoClear({ delayMs: delay }).delayMs, delay);
  }
});
