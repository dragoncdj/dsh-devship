import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { invalidatePortProbe, portBusy } from '../lib/net.js';

/** 起一个一次性监听，返回 { port, close }。 */
async function listenOnce() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('portBusy：有人监听返回 true；缓存 3 秒，作废后重新探测', async () => {
  const { port, close } = await listenOnce();
  assert.equal(await portBusy(port, 500), true);
  await close();
  // 监听已经关了，但缓存里还留着「忙」——这就是 /status 每 2.5s 一轮不再重复 connect 的代价，
  // 由启动 / 停止那两侧负责作废。
  assert.equal(await portBusy(port, 500), true);
  invalidatePortProbe(port);
  assert.equal(await portBusy(port, 500), false);
});

test('portBusy：非法端口直接 false，不碰 socket', async () => {
  for (const port of [0, -1, 65536, 80.5, '8080', undefined, Number.NaN]) {
    assert.equal(await portBusy(port, 200), false);
  }
});
