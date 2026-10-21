import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWarn } from '../lib/log.js';

test('warn：写进 logger，同一类问题 30 秒内只写一条', () => {
  const lines = [];
  const warn = createWarn({ logger: { warn: (text) => lines.push(text) } });
  warn('扫描失败', new Error('boom'));
  warn('扫描失败', new Error('boom'));
  warn('扫描失败', new Error('boom'));
  warn('另一个问题', '纯文本原因');
  assert.deepEqual(lines, ['扫描失败: boom', '另一个问题: 纯文本原因']);
});

test('warn：logger 只有 error / info 时也能用', () => {
  const errors = [];
  createWarn({ logger: { error: (text) => errors.push(text) } })('范围', '原因');
  assert.deepEqual(errors, ['范围: 原因']);

  const infos = [];
  createWarn({ log: { info: (text) => infos.push(text) } })('只有 info', '原因');
  assert.deepEqual(infos, ['只有 info: 原因']);
});

test('warn：没有 logger 不炸；logger 自己抛错也不外泄', () => {
  const silent = createWarn({});
  assert.doesNotThrow(() => silent('x', new Error('y')));
  assert.doesNotThrow(() => createWarn(undefined)('x', undefined));

  const angry = createWarn({ logger: { warn: () => { throw new Error('日志挂了'); } } });
  assert.doesNotThrow(() => angry('x', new Error('y')));
});
