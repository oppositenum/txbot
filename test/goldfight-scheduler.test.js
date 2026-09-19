const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGoldFightScheduler(results) {
  const account = {
    id: 'a1', cookie: 'test', proxy: null,
    config: { enabled: true, goldFight: true, goldFightMaxLevel: 29, goldFightPollMaxMin: 5 },
    status: { jobs: {} },
  };
  const calls = [];
  class MockGoldClient {
    async getFightStatus() {
      return [
        { areaName: '新手试练场', name: '幼狼', level: 2, mapId: 1, enemyId: 11, available: true },
        { areaName: '新手试练场', name: '鼠人', level: 3, mapId: 1, enemyId: 12, available: true },
        { areaName: '遗迹', name: '灵鸟', level: 13, mapId: 2, enemyId: 13, available: true },
      ];
    }
    async fightEnemy(mapId, enemyId) {
      calls.push([mapId, enemyId]);
      return results[calls.length - 1];
    }
  }
  const store = {
    get: () => account, list: () => [account], getSettings: () => ({}),
    setStatus(id, patch) { Object.assign(account.status, patch); },
    update: () => account,
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/scheduler.js'), 'utf8')
    + '\nmodule.exports.runGoldFightJob = runGoldFightJob;';
  const sandbox = {
    module: { exports: {} }, console: { log() {} }, Date, Math, setTimeout, setInterval,
    require(name) {
      const mocks = {
        './store': store,
        './client': { FarmClient: class {}, sleep: async () => {} },
        './plugins': { GoldClient: MockGoldClient },
        './signin': {}, './msgFilter': {},
        './daily-result': { DAILY_KEYS: [], todayStr: () => '', classifyResult: () => ({}), isBlocked: () => false, isSettled: () => true },
        './grab-scheduler': { createGrabScheduler: () => ({ start() {}, stop() {}, nextRun() { return 0; }, once() {} }) },
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'scheduler.js' });
  return { scheduler: sandbox.module.exports, account, calls };
}

test('圣衣打怪遇到体力不足立即停止本轮剩余目标', async () => {
  const fixture = loadGoldFightScheduler([
    { ok: true, reason: '战斗胜利' },
    { ok: false, reason: '体力不足' },
    { ok: true, reason: '不应执行' },
  ]);

  await fixture.scheduler.runGoldFightJob('a1');

  assert.deepEqual(fixture.calls, [[1, 11], [1, 12]]);
  assert.match(fixture.scheduler.logs.a1.at(-2).msg, /体力不足，本轮停止/);
  assert.match(fixture.scheduler.logs.a1.at(-1).msg, /体力不足，尝试2只后停止，已击杀1只/);
  assert.ok(fixture.account.status.jobs.goldfight > Date.now());
});
