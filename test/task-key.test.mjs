import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskKeyOf } from '../lib/deploy.js';
import { LEGACY_SERVER_ID, SERVER_ID_PATTERN } from '../lib/prefs.js';
import { slug } from '../lib/util.js';

/**
 * 任务 id 决定日志文件名（lib/state.js 的 logFileFor → slug(id)）。
 * 默认那一台（老 deploy.json 合成出来的）必须保持老写法，多出来的环境带后缀，
 * 而且两边不能撞同一个日志文件。
 */
test('taskKeyOf：默认那一台的 id 与日志文件名一个字节都不变', () => {
  assert.equal(taskKeyOf('deploy', 'api', undefined), 'deploy:api');
  assert.equal(taskKeyOf('deploy', 'api', ''), 'deploy:api');
  assert.equal(taskKeyOf('deploy', 'api', LEGACY_SERVER_ID), 'deploy:api');
  assert.equal(taskKeyOf('release', 'api', undefined), 'release:api');
  assert.equal(slug(taskKeyOf('deploy', 'app-server', LEGACY_SERVER_ID)), 'deploy-app-server');
});

test('taskKeyOf：多出来的环境带后缀，日志文件按环境分开', () => {
  assert.equal(taskKeyOf('deploy', 'api', 'dev'), 'deploy_dev_api');
  assert.equal(taskKeyOf('deploy', 'api', 'prod'), 'deploy_prod_api');
  assert.equal(taskKeyOf('release', 'api', 'prod'), 'release_prod_api');
  assert.equal(slug(taskKeyOf('deploy', 'app-server', 'test')), 'deploy_test_app-server');
});

test('taskKeyOf：带环境的 id 不会和老 id 撞同一个日志文件', () => {
  // 用 `:` 分隔就会撞：slug 把 `:` 归一成 `-`，`deploy:dev:api` 与「项目 id 叫 dev/api」的老条目同名
  assert.equal(slug('deploy:dev:api'), slug(taskKeyOf('deploy', 'dev/api', undefined)));
  // 用下划线就撞不上：老的一定以 deploy- 开头，带环境的一定以 deploy_ 开头
  assert.notEqual(slug(taskKeyOf('deploy', 'api', 'dev')), slug(taskKeyOf('deploy', 'dev/api', undefined)));
  assert.notEqual(slug(taskKeyOf('release', 'api', 'dev')), slug(taskKeyOf('release', 'dev/api', undefined)));
  // 两个不同环境不会互相吞：环境 id 里不许有下划线，分隔符才是唯一的
  assert.equal(SERVER_ID_PATTERN.test('dev_a'), false, '环境 id 带下划线会让上面的推断失效');
  assert.equal(SERVER_ID_PATTERN.test('dev-api'), true);
  assert.notEqual(slug(taskKeyOf('deploy', 'b', 'dev')), slug(taskKeyOf('deploy', 'b', 'prod')));
});

test('taskKeyOf：项目 id 里的目录分隔符照旧被 slug 摊平', () => {
  assert.equal(slug(taskKeyOf('deploy', 'yudao-module-system/yudao-module-system-server', 'prod')),
    'deploy_prod_yudao-module-system-yudao-module-system-server');
});
