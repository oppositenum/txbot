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
        './client': { FarmClient: MockFarmClient, sleep: async () => {}, actionLinks: () => [] },
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

test('好友农场土地兼容专用除草和杀虫动作名', () => {
  const lands = FarmClient.parseLands(`
    <strong>土地1:</strong>(水晶兰)(0星)
    <a href="weedingFriend.do?z=session-token&amp;landId=101">除草</a>
    <strong>黑土地2:</strong>(仙客来)(0星)
    <a href="killFriendInsects.do?z=session-token&amp;landId=102">杀虫</a>
  `);

  assert.equal(lands[0].landId, 101);
  assert.equal(lands[0].needWeed, 'weedingFriend.do?z=session-token&landId=101');
  assert.equal(lands[1].landId, 102);
  assert.equal(lands[1].needKill, 'killFriendInsects.do?z=session-token&landId=102');
});

test('好友护理按操作文字兼容未知名称的除草和杀虫链接', () => {
  const lands = FarmClient.parseLands(`
    <strong>土地1:</strong>(水晶兰)(0星)
    <a class="action" href="removeGrass.do?z=session-token&amp;landId=201">[除草]</a>
    <strong>土地2:</strong>(仙客来)(0星)
    <a data-kind="care" href='removePest.do?z=session-token&amp;landId=202'>帮忙除虫</a>
  `);

  assert.equal(lands[0].landId, 201);
  assert.equal(lands[0].needWeed, 'removeGrass.do?z=session-token&landId=201');
  assert.equal(lands[1].landId, 202);
  assert.equal(lands[1].needKill, 'removePest.do?z=session-token&landId=202');
});

test('好友农场按真实分页链接读取后页的除草和杀虫地块', async () => {
  const client = new FarmClient('');
  const requests = [];
  client.req = async (path) => {
    requests.push(path);
    if (path === 'index.do?uid=60541821') return `
      <strong>黑土地1:</strong>(富贵竹)(0星)施肥
      <a href="myLand.do?z=session-token&amp;uid=60541821&amp;flag=0&amp;pn=2">下页</a>
      <a href="myLand.do?z=session-token&amp;uid=60541821&amp;flag=0&amp;pn=3">3</a>
    `;
    if (path.endsWith('pn=2')) return `
      <strong>土地8:</strong>(富贵竹)(0星)
      <a href="killInsects.do?z=session-token&amp;landId=208&amp;tuid=60541821">杀虫(1)</a>
      <a href="weeding.do?z=session-token&amp;landId=208&amp;tuid=60541821">除草(1)</a>
      <a href="myLand.do?z=session-token&amp;uid=60541821&amp;pn=3">下页</a>
    `;
    if (path.endsWith('pn=3')) return `
      <strong>土地11:</strong>(富贵竹)(0星)
      <a href="killInsects.do?z=session-token&amp;landId=211&amp;tuid=60541821">杀虫(1)</a>
      <a href="weeding.do?z=session-token&amp;landId=211&amp;tuid=60541821">除草(1)</a>
    `;
    throw new Error(path);
  };

  const lands = await client.getFriendFarm(60541821, 20);

  assert.deepEqual(requests, [
    'index.do?uid=60541821',
    'myLand.do?uid=60541821&flag=0&pn=2',
    'myLand.do?uid=60541821&flag=0&pn=3',
  ]);
  assert.deepEqual(lands.filter((land) => land.needWeed).map((land) => land.landId), [208, 211]);
  assert.deepEqual(lands.filter((land) => land.needKill).map((land) => land.landId), [208, 211]);
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

test('浇水除草杀虫按小类型并行请求，全部结束后才安排下一轮', { timeout: 2000 }, async () => {
  const target = account();
  const releases = new Map();
  let allStarted;
  const started = new Promise((resolve) => { allStarted = resolve; });
  const fixture = isolatedCareScheduler(target, {
    rank: (oper) => [{ uid: oper }],
    farm: (uid) => [{
      [({ 3: 'needWater', 1: 'needWeed', 2: 'needKill' })[uid]]: `care.do?oper=${uid}`,
    }],
    request(link) {
      return new Promise((resolve) => {
        releases.set(link, resolve);
        if (releases.size === 3) allStarted();
      });
    },
  });

  let finished = false;
  const job = fixture.scheduler.runCareJob('a1').then(() => { finished = true; });
  try {
    await started;
    assert.deepEqual([...releases.keys()].sort(), ['care.do?oper=1', 'care.do?oper=2', 'care.do?oper=3']);
    assert.equal(finished, false);
    assert.equal(target.status.jobs.care, undefined);
    releases.get('care.do?oper=3')('操作成功');
    releases.get('care.do?oper=1')('除光');
    assert.equal(target.status.jobs.care, undefined);
    releases.get('care.do?oper=2')('杀光');
    await job;
    assert.equal(finished, true);
    assert.match(fixture.scheduler.logs.a1.at(-1).msg, /帮好友\(并发\): 浇水1 除草1 杀虫1/);
    assert.ok(target.status.jobs.care > Date.now());
  } finally {
    for (const resolve of releases.values()) resolve('除光 杀光');
    await job;
  }
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
