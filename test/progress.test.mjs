import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUploadProgress, formatBytes, formatSpeed } from '../lib/progress.js';

/** 可控时钟：进度器的速度全靠时间差，测试里不能靠真实时间跑。 */
function clock(start = 0) {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

test('单文件上传：百分比和速度按时间窗算', () => {
  const time = clock();
  const ticks = [];
  const progress = createUploadProgress(1000, { now: time.now, tickMs: 500, onTick: (value) => ticks.push(value) });

  progress.beginFile(0, 1000);
  progress.stepFile(0, 250);
  assert.deepEqual(ticks.at(-1), { uploaded: 250, total: 1000, percent: 25, bytesPerSecond: 0 });

  // 1 秒传了 250 字节：速度按「窗口起点之前最近的点」算，就是 250 B/s
  time.advance(1000);
  progress.stepFile(0, 500);
  assert.deepEqual(ticks.at(-1), { uploaded: 500, total: 1000, percent: 50, bytesPerSecond: 250 });

  time.advance(1000);
  progress.stepFile(0, 1000);
  assert.equal(ticks.at(-1).percent, 100);
  assert.equal(ticks.at(-1).uploaded, 1000);
  assert.equal(ticks.at(-1).bytesPerSecond, 375);

  progress.endFile(0);
  assert.equal(ticks.at(-1).percent, 100);
});

test('并发上传：每个文件各占一格，互不干扰', () => {
  const time = clock();
  const progress = createUploadProgress(100, { now: time.now, tickMs: 500 });

  progress.beginFile('a', 40);
  progress.beginFile('b', 60);
  progress.stepFile('a', 20);
  assert.equal(progress.snapshot().uploaded, 20);
  progress.stepFile('b', 10);
  assert.deepEqual(progress.snapshot(), { uploaded: 30, total: 100, percent: 30, bytesPerSecond: 0 });

  progress.endFile('a');
  // a 传完按它的大小算 40（不是当时已传的 20），b 那 10 字节也还在账上
  assert.equal(progress.snapshot().uploaded, 50);

  progress.stepFile('b', 60);
  progress.endFile('b');
  assert.equal(progress.snapshot().uploaded, 100);
  assert.equal(progress.snapshot().percent, 100);
});

test('节流：密集回调只报一次，文件传完那次一定报', () => {
  const time = clock();
  const ticks = [];
  const progress = createUploadProgress(1000, { now: time.now, tickMs: 500, onTick: (value) => ticks.push(value) });

  progress.beginFile(0, 1000);
  for (let index = 1; index <= 20; index += 1) progress.stepFile(0, index * 10);
  assert.equal(ticks.length, 1, '同一个时刻的 20 次回调只该报一次');

  time.advance(600);
  progress.stepFile(0, 300);
  assert.equal(ticks.length, 2);

  time.advance(100);
  progress.stepFile(0, 400);
  assert.equal(ticks.length, 2, '没满一个窗口不该再报');

  progress.endFile(0);
  assert.equal(ticks.length, 3, '传完那次一定要报，最后一段进度不能丢');
  assert.equal(ticks.at(-1).percent, 100);
});

test('总量可以后补（tar 打完才知道大小）', () => {
  const time = clock();
  const progress = createUploadProgress(0, { now: time.now, tickMs: 500 });
  progress.beginFile(0, 400);
  progress.stepFile(0, 100);
  assert.equal(progress.snapshot().percent, 0, '还不知道总量时不猜百分比');

  progress.setTotal(400);
  assert.deepEqual(progress.snapshot(), { uploaded: 100, total: 400, percent: 25, bytesPerSecond: 0 });

  progress.setTotal(-1);
  assert.equal(progress.snapshot().total, 0);
});

test('没登记过的 key 和乱七八糟的数字都不会把进度算飞', () => {
  const time = clock();
  const progress = createUploadProgress(100, { now: time.now, tickMs: 500 });
  progress.stepFile('没有这个文件', 9999);
  assert.equal(progress.snapshot().uploaded, 0);

  progress.beginFile(0, 100);
  progress.stepFile(0, 5000);
  assert.equal(progress.snapshot().uploaded, 100, '单文件已传不会超过它自己的大小');
  progress.stepFile(0, Number.NaN);
  assert.equal(progress.snapshot().uploaded, 0);
  progress.endFile(0);
  assert.equal(progress.snapshot().uploaded, 100);
});

test('速度按最近这段时间算，不会被整轮平均拖低', () => {
  const time = clock();
  const progress = createUploadProgress(100_000, { now: time.now, tickMs: 500 });
  progress.beginFile(0, 100_000);

  // 前 6 秒慢慢传：100 B/s
  for (let index = 1; index <= 12; index += 1) {
    progress.stepFile(0, index * 50);
    time.advance(500);
  }
  // 之后每半秒传 2000 字节：4000 B/s
  for (let index = 1; index <= 12; index += 1) {
    progress.stepFile(0, 600 + index * 2000);
    time.advance(500);
  }

  const speed = progress.snapshot().bytesPerSecond;
  const overallAverage = progress.snapshot().uploaded / 12;
  assert.ok(speed > 3000 && speed < 4200, `最近这段该算出约 4000 B/s，实际 ${speed}`);
  assert.ok(speed > overallAverage, `整轮平均只有 ${overallAverage} B/s，速度不该被它拖低`);
});

test('采样节流：密集回调不会把速度窗口压成几百毫秒', () => {
  const time = clock();
  const chunk = 32768;
  const progress = createUploadProgress(chunk * 1000, { now: time.now, tickMs: 500 });
  progress.beginFile(0, chunk * 1000);

  // 照 ssh2 的节奏来：每传完一块（32 KB）回调一次，每块 10 ms → 真实速度 3.2768 MB/s
  for (let index = 1; index <= 1000; index += 1) {
    progress.stepFile(0, index * chunk);
    time.advance(10);
  }

  const speed = progress.snapshot().bytesPerSecond;
  assert.ok(
    speed > 3_100_000 && speed < 3_400_000,
    `速度该在 3.27 MB/s 附近，实际 ${(speed / 1024 / 1024).toFixed(2)} MB/s（采样太密就会算飞）`,
  );
});

test('formatBytes / formatSpeed 的写法', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.00 GB');
  assert.equal(formatBytes(Number.NaN), '0 B');

  assert.equal(formatSpeed(0), '—');
  assert.equal(formatSpeed(512), '512 B/s');
  assert.equal(formatSpeed(2048), '2 KB/s');
  assert.equal(formatSpeed(4.8 * 1024 * 1024), '4.8 MB/s');
});
