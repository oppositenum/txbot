const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function schedulerFixture(loginError = null) {
  const account = {
    id: 'a1', name: 'test', cookie: 'old', useruid: '10001', password: 'secret', proxy: null,
    config: { enabled: true },
    status: { state: 'error', needLogin: true, jobs: {} },
  };
  let loginCalls = 0;
  class MockFarmClient {
    constructor(cookie) { this.cookie = cookie; }
    async login() {
      loginCalls++;
      if (loginError) throw loginError;
      return 'JSESSIONID=new; txuid=10001';
    }
  }
  const store = {
    list: () => [account],
    get: id => id === account.id ? account : null,
    getSettings: () => ({ maxConcurrent: 2, dailyMaxConcurrent: 1 }),
    update(id, patch) {
      if (patch.cookie !== undefined) account.cookie = patch.cookie;
      if (patch.config) Object.assign(account.config, patch.config);
      return account;
    },
    setStatus(id, patch) { Object.assign(account.status, patch); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/scheduler.js'), 'utf8')
    + '\nmodule.exports.tick = tick;';
  const sandbox = {
    module: { exports: {} }, console: { log() {} }, Date, Math, setTimeout, setInterval,
    require(name) {
      const mocks = {
        './store': store,
        './client': { FarmClient: MockFarmClient, sleep: async () => {} },
        './plugins': {}, './signin': {}, './msgFilter': {},
        './daily-result': { DAILY_KEYS: [], todayStr: () => '2026-09-12', classifyResult: () => ({}), isBlocked: () => false, isSettled: () => true },
        './grab-scheduler': { createGrabScheduler: () => ({ start() {}, stop() {}, nextRun() { return 0; }, once() {} }) },
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'scheduler.js' });
  return { scheduler: sandbox.module.exports, account, get loginCalls() { return loginCalls; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('启用账号登录失效后由调度器自动重登并恢复', async () => {
  const fixture = schedulerFixture();
  fixture.scheduler.tick();
  await flush();
  assert.equal(fixture.loginCalls, 1);
  assert.equal(fixture.account.cookie, 'JSESSIONID=new; txuid=10001');
  assert.equal(fixture.account.status.needLogin, false);
  assert.equal(fixture.account.status.nextLoginRetryAt, null);
  assert.equal(fixture.account.status.state, 'idle');
});

test('自动登录失败后退避约10分钟，调度扫描不会连续撞登录', async () => {
  const fixture = schedulerFixture(new Error('密码错误'));
  const before = Date.now();
  fixture.scheduler.tick();
  await flush();
  assert.equal(fixture.loginCalls, 1);
  assert.equal(fixture.account.status.needLogin, true);
  assert.ok(fixture.account.status.nextLoginRetryAt > before + 8 * 60000);
  assert.match(fixture.account.status.lastResult, /自动登录失败/);

  fixture.scheduler.tick();
  await flush();
  assert.equal(fixture.loginCalls, 1);
});
