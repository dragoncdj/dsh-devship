import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUploadProgress } from '../lib/progress.js';
import { putWithProgress } from '../lib/deploy.js';

/** 可控时钟：速度全靠时间差，测试里不能靠真实时间跑。 */
function clock(start = 0) {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

/**
 * 假 sftp：照 ssh2 的 fastPut 喂 step 回调。
 * ssh2 的真实签名是 step(已传累计, 本次块大小, 文件总大小)，块大小默认 32768。
 * failAfterChunks 让它传到第几块就断开（复现上传中途断线）。
 */
function fakeSftp({ size, chunkSize = 32768, stepMs = 100, time, error, failAfterChunks }) {
  const calls = [];
  return {
    calls,
    fastPut(local, remote, options, cb) {
      let total = 0;
      const next = () => {
        const nb = Math.min(chunkSize, size - total);
        total += nb;
        calls.push({ total, nb, size });
        if (typeof options.step === 'function') options.step(total, nb, size);
        if (error !== undefined && failAfterChunks !== undefined && calls.length >= failAfterChunks) {
          return cb(error);
        }
        if (total >= size) return cb(null);
        time?.advance(stepMs);
        setImmediate(next);
      };
      setImmediate(next);
    },
  };
}

test('上传进度会一段一段往前走，不会卡在 32 KB', async () => {
  const time = clock();
  const size = 1024 * 1024;
  const ticks = [];
  const progress = createUploadProgress(size, { now: time.now, tickMs: 500, onTick: (value) => ticks.push(value) });
  const sftp = fakeSftp({ size, time, stepMs: 100 });

  await putWithProgress(sftp, 'a.tar', '/tmp/a.tar', progress, 0, size);

  assert.equal(sftp.calls.length, 32, '1 MB 按 32 KB 一块该是 32 次');
  assert.ok(ticks.length >= 3, `中途该报好几次，实际 ${ticks.length} 次`);

  const uploaded = ticks.map((value) => value.uploaded);
  for (let index = 1; index < uploaded.length; index += 1) {
    assert.ok(uploaded[index] > uploaded[index - 1], `第 ${index} 次快照的已传字节没往前走：${uploaded.join(' → ')}`);
  }
  assert.ok(
    uploaded.some((value) => value > 32768),
    `进度只见过 32 KB 就说明又拿块大小当进度了：${uploaded.join(' → ')}`,
  );

  const last = progress.snapshot();
  assert.equal(last.uploaded, size);
  assert.equal(last.percent, 100);
  assert.ok(last.bytesPerSecond > 0, '传完时该算得出速度');
});

test('ssh2 的 step 第二个参数是块大小，不能当已传字节用', async () => {
  const time = clock();
  const size = 32768 * 8;
  const progress = createUploadProgress(size, { now: time.now, tickMs: 500 });
  const sftp = fakeSftp({ size, time, stepMs: 100 });

  await putWithProgress(sftp, 'a', 'b', progress, 0, size);

  // 每一块的 nb 恒等于 32768：进度器收到的却是递增的累计值
  const seen = sftp.calls.map((call) => call.nb);
  assert.ok(seen.every((nb) => nb === 32768), '假 sftp 的块大小要恒定，才能复现那个卡住的毛病');
  assert.equal(progress.snapshot().uploaded, size);
  assert.equal(progress.snapshot().percent, 100);
});

test('上传失败：进度停在断掉的地方，不算成已传', async () => {
  const time = clock();
  const size = 1024 * 1024;
  const progress = createUploadProgress(size, { now: time.now, tickMs: 500 });
  const sftp = fakeSftp({ size, time, stepMs: 100, error: new Error('连接断了'), failAfterChunks: 8 });

  await assert.rejects(() => putWithProgress(sftp, 'a', 'b', progress, 0, size), /连接断了/u);

  const snapshot = progress.snapshot();
  assert.equal(sftp.calls.length, 8, '传到第 8 块就该断开');
  assert.equal(snapshot.uploaded, 8 * 32768, '断在半路就该停在已传的那些块');
  assert.ok(snapshot.percent < 100);
});

test('并发逐文件上传：每个文件各占一格，累计互不干扰', async () => {
  const time = clock();
  const total = 32768 * 6;
  const progress = createUploadProgress(total, { now: time.now, tickMs: 500 });
  const first = fakeSftp({ size: 32768 * 2, time, stepMs: 100 });
  const second = fakeSftp({ size: 32768 * 4, time, stepMs: 100 });

  await Promise.all([
    putWithProgress(first, 'a', '/tmp/a', progress, 0, 32768 * 2),
    putWithProgress(second, 'b', '/tmp/b', progress, 1, 32768 * 4),
  ]);

  const snapshot = progress.snapshot();
  assert.equal(snapshot.uploaded, total);
  assert.equal(snapshot.percent, 100);
});

test('没有进度器时照样上传（不登记进度也不报错）', async () => {
  const time = clock();
  const size = 32768 * 2;
  const sftp = fakeSftp({ size, time, stepMs: 10 });
  await putWithProgress(sftp, 'a', 'b', undefined, 0, size);
  assert.equal(sftp.calls.length, 2);
});
