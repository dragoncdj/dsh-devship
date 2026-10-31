import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * client.js 是浏览器半（window.__ModuleLoader__），不能在 node 里 import，
 * 所以这里只按文本抠 DICT：两种语言必须同键，代码里用到的键两边都得有。
 * 面板改文案最容易漏的就是「加了 t('x') 忘了 en」——这条测试就是拦它的。
 */
const SOURCE = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8');
const LINES = SOURCE.split('\n');

/**
 * 从 `zh: {` / `en: {` 抠到块尾（6 空格缩进的 `},`）。
 * 按缩进行扫，不按花括号配对：值里有 `{container}` 这种占位符，配对扫会扫歪。
 */
function blockKeys(header) {
  const from = LINES.findIndex((line) => line.trim() === header);
  if (from < 0) throw new Error(`client.js 里找不到 DICT 的 ${header}`);
  const keys = [];
  for (let index = from + 1; index < LINES.length; index += 1) {
    if (/^\s{6}\},$/u.test(LINES[index])) return keys;
    const match = /^\s{8}([A-Za-z][A-Za-z0-9]*):/u.exec(LINES[index]);
    if (match !== null) keys.push(match[1]);
  }
  throw new Error(`DICT 的 ${header} 没有结束`);
}

const ZH = blockKeys('zh: {');
const EN = blockKeys('en: {');

test('DICT：zh 与 en 同键同数，顺序也一致', () => {
  assert.ok(ZH.length > 60, `只抠到 ${ZH.length} 个键，八成是 client.js 的缩进变了`);
  assert.deepEqual(EN, ZH, '两种语言的键不一致');
  assert.equal(new Set(ZH).size, ZH.length, '有重复键');
});

test('DICT：代码里用到的每个 t("key") 两种语言都得有', () => {
  const used = new Set();
  for (const match of SOURCE.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/gu)) used.add(match[1]);
  assert.ok(used.size > 40, `只找到 ${used.size} 处 t() 调用，正则可能失效了`);
  const zhSet = new Set(ZH);
  const enSet = new Set(EN);
  const missingZh = [...used].filter((key) => !zhSet.has(key));
  const missingEn = [...used].filter((key) => !enSet.has(key));
  assert.deepEqual(missingZh, [], '这些键 zh 里没有');
  assert.deepEqual(missingEn, [], '这些键 en 里没有');
});
