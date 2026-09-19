const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScheduler(account) {
  const store = {
    list: () => [account],
    get: () => account,
    getSettings: () => ({ maxConcurrent: 0, tickSec: 20 }),
    setStatus(id, patch) { Object.assign(account.status, patch); },
    update(id, patch) {
      if (patch.config) Object.assign(account.config, patch.config);
      return account;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/scheduler.js'), 'utf8');
  const sandbox = {
    module: { exports: {} }, console: { log() {} }, Date, Math, setTimeout,
    setInterval: () => 1,
    require(name) {
      const mocks = {
        './store': store,
        './client': { FarmClient: class {}, sleep: async () => {} },
        './plugins': {}, './signin': {}, './msgFilter': {},
        './daily-result': { DAILY_KEYS: [], todayStr: () => '2026-09-19', classifyResult: () => ({}), isBlocked: () => false, isSettled: () => true },
        './grab-scheduler': { createGrabScheduler: () => ({ start() {}, stop() {}, nextRun() { return 123456; }, once() {} }) },
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'scheduler.js' });
  return sandbox.module.exports;
}

test('服务重启后为全部已启用任务重新安排一次执行', () => {
  const account = {
    id: 'a1',
    config: {
      enabled: true, friendLand: true, steal: true, careFriends: true, farmTasks: true,
      farmSignin: true, pastureLoop: true, pastureFeed: true, pioneer: true,
      petTrain: true, goldFight: true, msgWatch: true, grabPoints: true,
    },
    status: { state: 'running', needLogin: false, jobs: { care: Date.now() + 86400000 } },
  };
  const scheduler = loadScheduler(account);
  const before = Date.now();

  scheduler.resume();

  const regular = ['farm', 'friendland', 'steal', 'care', 'farmtask', 'daily', 'pasture', 'pasturefeed', 'pioneer', 'pettrain', 'goldfight', 'msgwatch'];
  for (const type of regular) {
    assert.ok(account.status.jobs[type] >= before, `${type} 应重新排期`);
    assert.ok(account.status.jobs[type] <= Date.now() + 30000, `${type} 应在30秒内进入队列`);
  }
  assert.equal(account.status.jobs.grab, 123456);
  assert.equal(account.status.state, 'idle');
  assert.equal(scheduler.logs.a1.at(-1).msg, '服务重启: 已安排全部启用任务执行一次');
});

test('服务重启只安排账号实际开启的任务', () => {
  const account = {
    id: 'a1',
    config: { enabled: true, careFriends: true },
    status: { state: 'idle', needLogin: false, jobs: { steal: 1, pasture: 2 } },
  };
  const scheduler = loadScheduler(account);

  scheduler.resume();

  assert.deepEqual(Object.keys(account.status.jobs).sort(), ['care', 'farm']);
});

test('服务重启保留登录失效账号的即时排期供重登后执行', () => {
  const account = {
    id: 'a1', useruid: '10001', password: 'secret',
    config: { enabled: true, careFriends: true },
    status: { state: 'error', needLogin: true, nextLoginRetryAt: Date.now() + 60000, jobs: {} },
  };
  const scheduler = loadScheduler(account);

  scheduler.resume();

  assert.deepEqual(Object.keys(account.status.jobs).sort(), ['care', 'farm']);
  assert.equal(account.status.needLogin, true);
});
