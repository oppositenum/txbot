const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FarmClient } = require('../src/client');
const daily = require('../src/daily-result');

function isolatedScheduler(store, sleep) {
  const source = fs.readFileSync(path.join(__dirname, '../src/scheduler.js'), 'utf8')
    + '\nmodule.exports.runFarmJob = runFarmJob; module.exports.farmErrorRetryDelay = farmErrorRetryDelay;';
  const sandbox = {
    module: { exports: {} }, console: { log() {} }, Date, Math, setTimeout, setInterval,
    require(name) {
      const mocks = {
        './store': store,
        './client': { FarmClient, sleep },
        './plugins': {},
        './signin': {},
        './msgFilter': {},
        './daily-result': daily,
        './grab-scheduler': { createGrabScheduler: () => ({}) },
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'scheduler.js' });
  return sandbox.module.exports;
}

function farm(lands) {
  return { level: 1, coin: 1, lands };
}

function fixture() {
  const account = {
    id: 'test',
    config: {
      enabled: true, harvest: true, dig: false, sow: false,
      weed: false, kill: false, water: false, muck: false,
      sellAll: false, farmPollMaxMin: 10,
    },
    status: { jobs: {} },
  };
  const store = {
    get: () => account,
    getSettings: () => ({}),
    setStatus(id, patch) { Object.assign(account.status, patch); },
  };
  const waits = [];
  return { account, store, waits, scheduler: isolatedScheduler(store, async (ms) => { waits.push(ms); }) };
}

test('0分钟后成熟是有效临界倒计时，不会退回普通巡检', () => {
  assert.equal(FarmClient.matureMinutes('0分钟后成熟'), 0);
  assert.equal(FarmClient.nextFarmActionMinutes([{ matureIn: '0分钟后成熟' }]), 0);
  assert.equal(FarmClient.matureMinutes('没有成熟倒计时'), null);
});

test('最后一分钟持续重试，波动后成熟立即收获', async () => {
  const f = fixture();
  const near = farm([{ canHarvest: null, matureIn: '0分钟后成熟' }]);
  const later = farm([{ canHarvest: null, matureIn: '12分钟后成熟' }]);
  let reads = 0;
  const results = [new Error('网络超时'), '还没有成熟的作物', '一键收获全部成熟作物 ┗得到:10个菜'];
  const client = {
    getFarm: async () => (++reads < 3 ? near : later),
    harvestAll: async () => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  };

  await f.scheduler.runFarmJob('test', client);

  assert.equal(results.length, 0);
  assert.deepEqual(f.waits, [5000, 5000]);
  assert.equal(f.account.status.lastResult, '收割');
  assert.ok(f.account.status.jobs.farm > Date.now() + 8 * 60000);
});

test('任务末尾刚成熟的作物当场收，不再额外等一分钟', async () => {
  const f = fixture();
  const initial = farm([{ canHarvest: null, matureIn: '10分钟后成熟' }]);
  const ready = farm([{ canHarvest: 'harvest.do?landId=1', matureIn: null }]);
  const later = farm([{ canHarvest: null, matureIn: '20分钟后成熟' }]);
  const farms = [initial, ready, later];
  let harvests = 0;
  const client = {
    getFarm: async () => farms.shift(),
    harvestAll: async () => { harvests++; return '一键收获全部成熟作物 ┗得到:10个菜'; },
  };

  await f.scheduler.runFarmJob('test', client);

  assert.equal(harvests, 1);
  assert.equal(f.account.status.lastResult, '收割');
  assert.equal(f.waits.length, 0);
});

test('预计成熟或已有可收作物时，任务异常按5秒快速重试', () => {
  const f = fixture();
  const now = Date.now();
  f.account.status.farmInfo = { harvestable: 0, nextMatureAt: now + 30000 };
  assert.equal(f.scheduler.farmErrorRetryDelay(f.account, now), 5000);
  f.account.status.farmInfo = { harvestable: 2, nextMatureAt: null };
  assert.equal(f.scheduler.farmErrorRetryDelay(f.account, now), 5000);
  f.account.status.farmInfo = { harvestable: 0, nextMatureAt: now + 3600000 };
  assert.ok(f.scheduler.farmErrorRetryDelay(f.account, now) > 8 * 60000);
});
