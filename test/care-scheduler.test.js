const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const daily = require('../src/daily-result');
const { FarmClient } = require('../src/client');

function isolatedCareScheduler(account, handlers = {}) {
  const calls = { ranks: [], farms: [], requests: [] };
  class MockFarmClient {
    async getRankAll(oper) {
      calls.ranks.push(oper);
      return handlers.rank ? handlers.rank(oper) : [];
    }
    async getFriendFarm(uid, maxPages) {
      calls.farms.push([uid, maxPages]);
      return handlers.farm ? handlers.farm(uid) : [];
    }
    async req(link) {
      calls.requests.push(link);
      return handlers.request ? handlers.request(link) : '操作成功';
    }
    static resultText(html) { return String(html); }
  }
  const store = {
    get: () => account,
    getSettings: () => ({}),
    setStatus(id, patch) { Object.assign(account.status, patch); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/scheduler.js'), 'utf8')
    + '\nmodule.exports.runCareJob = runCareJob;';
  const sandbox = {
    module: { exports: {} }, console: { log() {} }, Date, Math, setTimeout, setInterval,
    require(name) {
      const mocks = {
        './store': store,
        './client': { FarmClient: MockFarmClient, sleep: async () => {} },
        './plugins': {},
        './signin': {},
        './msgFilter': {},
        './daily-result': daily,
        './grab-scheduler': { createGrabScheduler: () => ({ start() {}, stop() {}, nextRun() { return 0; }, once() {} }) },
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'scheduler.js' });
  return { scheduler: sandbox.module.exports, calls };
}

function account() {
  return {
    id: 'a1', cookie: 'test', proxy: null,
    config: { enabled: true, careFriends: true, careMax: 0, farmPollMaxMin: 5, water: false, weed: false, kill: false },
    status: { jobs: {} },
  };
}

test('护理排行榜兼容uid前的动态查询参数', async () => {
  const client = new FarmClient('');
  client.req = async () => [
    '1. 好友甲: <a href="/plugins/farm/index.do?z=dynamic-token&amp;uid=10001">进入农场</a>',
    '2. 好友乙: <a href="/plugins/farm/index.do?uid=10002">进入农场</a>',
    '<a href="rank.do?oper=3&amp;order=2&amp;pn=2">下一页</a>',
  ].join('');

  const result = await client.getRank(3, 1);

  assert.deepEqual(result.friends, [
    { rank: 1, name: '好友甲', uid: 10001 },
    { rank: 2, name: '好友乙', uid: 10002 },
  ]);
  assert.equal(result.maxPage, 2);
});

test('农场收割链接兼容z参数在landId前且HTML实体编码', () => {
  const html = `
    <strong>黑土地1:</strong>(水晶兰)(0星)
    <a href="harvest.do?z=session-token&amp;landId=123456">收割</a>
  `;
  const [land] = FarmClient.parseLands(html);
  assert.equal(land.mature, true);
  assert.equal(land.landId, 123456);
  assert.equal(land.canHarvest, 'harvest.do?z=session-token&landId=123456');
});

test('好友护理不受自家浇水除草杀虫开关限制', async () => {
  const target = account();
  const fixture = isolatedCareScheduler(target, {
    rank: (oper) => oper === 3 ? [{ uid: 88 }] : [],
    farm: () => [{ needWater: 'water.do?landId=1&amp;tuid=88' }],
  });

  await fixture.scheduler.runCareJob('a1');

  assert.deepEqual([...fixture.calls.ranks].sort(), [1, 2, 3]);
  assert.ok(fixture.calls.farms.every(([, maxPages]) => maxPages === 20));
  assert.deepEqual(fixture.calls.requests, ['water.do?landId=1&tuid=88']);
  assert.match(fixture.scheduler.logs.a1.at(-1).msg, /帮好友\(并发\): 浇水1 除草0 杀虫0/);
  assert.ok(target.status.jobs.care > Date.now());
});

test('三路检查完成后才能记录暂无好友需要护理', async () => {
  const target = account();
  const fixture = isolatedCareScheduler(target);

  await fixture.scheduler.runCareJob('a1');

  assert.deepEqual([...fixture.calls.ranks].sort(), [1, 2, 3]);
  assert.equal(fixture.scheduler.logs.a1.at(-1).msg, '帮好友巡检: 已检查浇水/除草/杀虫，暂无好友需要护理');
  assert.ok(target.status.jobs.care > Date.now());
});

test('护理请求失败时记录失败并交给调度器重试', async () => {
  const target = account();
  const fixture = isolatedCareScheduler(target, {
    rank(oper) {
      if (oper === 3) throw new Error('排行榜超时');
      return [];
    },
  });

  await assert.rejects(fixture.scheduler.runCareJob('a1'), /好友护理检查失败: 浇水: 排行榜超时/);
  assert.equal(fixture.scheduler.logs.a1.at(-1).msg, '帮好友巡检失败: 浇水: 排行榜超时');
  assert.equal(target.status.jobs.care, undefined);
});
