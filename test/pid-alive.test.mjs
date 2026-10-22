import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTasklistPids, pidsAliveAsync, pidAliveAsync } from '../lib/state.js';

/** tasklist /NH /FO CSV 的真实形状：pid 是第二列。 */
const CSV = [
  '"System Idle Process","0","Services","0","8 K"',
  '"node.exe","1234","Console","1","45,120 K"',
  '"java.exe","5678","Console","1","120,000 K"',
  '"svchost.exe","999","Services","0","12,000 K"',
  '',
].join('\r\n');

test('parseTasklistPids：取 CSV 第二列的 pid，跳过空行和畸形行', () => {
  const pids = parseTasklistPids(CSV);
  assert.equal(pids.has(1234), true);
  assert.equal(pids.has(5678), true);
  assert.equal(pids.has(999), true);
  assert.equal(pids.has(45120), false); // 内存列不能被当成 pid
  assert.equal(pids.has(1), false); // 会话号列同理
});

test('parseTasklistPids：空输入不炸', () => {
  assert.equal(parseTasklistPids('').size, 0);
  assert.equal(parseTasklistPids(undefined).size, 0);
  assert.equal(parseTasklistPids('"not a row"').size, 0);
});

test('pidsAliveAsync：一轮问一批，每个 pid 都有答案', async () => {
  const answers = await pidsAliveAsync([1234, 5678, 999]);
  assert.equal(answers.size, 3);
  for (const pid of [1234, 5678, 999]) {
    const alive = answers.get(pid);
    assert.equal(alive === true || alive === false || alive === undefined, true);
  }
});

test('pidsAliveAsync：非法 pid 直接给「不存在」，不占用查询', async () => {
  const answers = await pidsAliveAsync([0, -1, 1.5, Number.NaN]);
  assert.equal(answers.size, 4);
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(answers.get(pid), false);
  assert.equal((await pidsAliveAsync([])).size, 0);
});

test('pidAliveAsync：单条入口仍然可用，且和批量口径一致', async () => {
  const batch = await pidsAliveAsync([424242]);
  const single = await pidAliveAsync(424242);
  assert.equal(single, batch.get(424242));
  assert.equal(await pidAliveAsync(0), false);
});
