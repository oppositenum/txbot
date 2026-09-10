const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const daily = require('../src/daily-result');
const REJECTION = '失败!系统检测多号刷签到';

// 模块隔离：禁止加载真实 store、客户端或 OCR，不读取/写入真实账号。
function isolated(file, mocks, extra = '') {
  const sandbox = { module: { exports: {} }, console: { log() {} }, Date, Math,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error('Unexpected dependency: ' + name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, sandbox, { filename: file });
  return sandbox.module.exports;
}
function schedulerFixture() {
  let account = { id: 'test', config: { enabled: true, farmSignin: true, groupSignin: true, qqSignin: true }, status: {} };
  const calls = { farm: 0, group: 0, qq: 0 }, writes = [];
  const store = {
    get: () => account,
    getSettings: () => ({ dailyStartHour: 0, dailyStartMin: 0, dailySpreadMin: 1 }),
    setStatus(id, patch) { Object.assign(account.status, patch); writes.push(JSON.parse(JSON.stringify(account.status))); },
  };
  const scheduler = isolated('scheduler.js', {
    './store': store, './client': { FarmClient: class {}, sleep: async () => {} },
    './plugins': {}, './msgFilter': {}, './daily-result': daily,
    './grab-scheduler': { createGrabScheduler: () => ({}) },
    './signin': {
      farmSignin: async () => { calls.farm++; return REJECTION; },
      groupSignin: async () => { calls.group++; return '签到成功，获得10积分'; },
      qqSignin: async () => { calls.qq++; if (calls.qq === 1) throw new Error('验证码错误'); return '今日已签到'; },
    },
  }, '\nmodule.exports.runDailyJob = runDailyJob; module.exports.computeDailyNext = computeDailyNext;');
  return { scheduler, calls, writes, store, get account() { return account; }, reload() { account = JSON.parse(JSON.stringify(account)); } };
}

test('网站限制优先于导航/成功文字，完整页面截取前识别', () => {
  const text = daily.signinResultText('<b>获得10积分</b>' + '导航 '.repeat(120) + '<p>' + REJECTION + '</p>');
  assert.match(text, /系统检测多号刷签到/);
  assert.deepEqual(daily.classifyResult('qqSignin', text), { state: 'failed', code: 'SIGNIN_MULTI_ACCOUNT', retryable: false, message: text });
  for (const text of ['无需签到或已签', '已提交', '未找到签到入口，无法确认是否已签', '积分商城', '验证码填错,请返回重试.']) {
    assert.equal(daily.classifyResult('farmSignin', text).state, 'failed', text);
  }
  for (const text of ['真幸运!今日奖励你1粒冰凌花种子', '成功获得:积分100', '成功签到群组,特获得20个积分!', '签到成功', '今日已签', '你已经领取今天的奖励', '获得 10 积分']) {
    assert.equal(daily.classifyResult('farmSignin', text).state, 'success', text);
  }
});

test('三种签到入口受限后，不再 POST 或调用 OCR；无入口不虚报完成', async () => {
  let ocr = 0;
  const signin = isolated('signin.js', { './captcha': { solveCaptcha() { ocr++; throw new Error('must not OCR'); } }, './daily-result': daily });
  for (const key of daily.SIGNIN_KEYS) {
    let requests = 0;
    const result = await signin[key]({ req: async () => { requests++; return `<p>${REJECTION}</p><input name="regkey" value="1">`; } });
    assert.equal(requests, 1);
    assert.equal(daily.classifyResult(key, result).retryable, false);
  }
  for (const key of ['farmSignin', 'groupSignin']) {
    const result = await signin[key]({ req: async () => '<p>导航页面</p>' });
    assert.equal(daily.classifyResult(key, result).code, 'UNCONFIRMED');
  }
  assert.equal(ocr, 0);
});

test('逐项保存失败，受限项不重试，普通错误可恢复，跨天/重载仍暂停', async () => {
  const f = schedulerFixture();
  await f.scheduler.runDailyJob('test');
  assert.equal(f.writes[0].dailyResults.farmSignin.state, 'failed');
  assert.equal(f.writes[0].dailyDone.farmSignin, undefined);
  assert.equal(f.account.status.lastDaily, null);
  assert.equal(f.account.status.dailyResults.qqSignin.state, 'failed');
  await f.scheduler.runDailyJob('test');
  assert.deepEqual(f.calls, { farm: 1, group: 1, qq: 2 });
  assert.equal(f.account.status.dailyResults.qqSignin.state, 'success');
  assert.ok(f.account.status.jobs.daily > Date.now() + 5 * 60000, '已暂停项不能导致5分钟补跑');
  f.reload();
  f.account.status.dailyDone.groupSignin = '2000-01-01';
  f.account.status.dailyDone.qqSignin = '2000-01-01';
  f.account.status.dailyResults.farmSignin.date = '2000-01-01';
  await f.scheduler.runDailyJob('test');
  assert.deepEqual(f.calls, { farm: 1, group: 2, qq: 3 });
  f.store.setStatus('test', { state: 'idle', lastResult: '农场正常' });
  assert.equal(f.account.status.dailyResults.farmSignin.code, 'SIGNIN_MULTI_ACCOUNT');
  f.scheduler.recordDailyResult('test', 'farmSignin', '签到成功');
  assert.equal(f.account.status.dailyResults.farmSignin.state, 'failed', '并发旧请求不能覆盖限制');
});

test('失败删除旧成功标记，全部明确成功才写入 lastDaily', () => {
  const f = schedulerFixture();
  for (const key of daily.SIGNIN_KEYS) f.scheduler.recordDailyResult('test', key, '签到成功');
  assert.equal(f.account.status.lastDaily, daily.todayStr());
  f.scheduler.recordDailyResult('test', 'farmSignin', REJECTION);
  assert.equal(f.account.status.dailyDone.farmSignin, undefined);
  assert.equal(f.account.status.lastDaily, null);
});

test('手动接口保存失败并返回409；后续手动提交/验证码入口均不请求网站', async () => {
  const f = schedulerFixture(), routes = {};
  let requests = 0;
  const app = { use() {}, get(route, fn) { routes['GET ' + route] = fn; }, post(route, fn) { routes['POST ' + route] = fn; }, put() {}, delete() {}, all() {}, listen() { return { on() {} }; } };
  const express = Object.assign(() => app, { json() {}, static() {}, raw() {} });
  const sched = { ...f.scheduler, getClient() { return { signin: async () => { requests++; return REJECTION; } }; } };
  // 后端只注册路由，不监听端口、恢复调度或读取 .env。
  let source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const sandbox = { process: { env: {} }, console: { log() {} }, URL,
    require(name) {
      const mocks = { express, path, fs: { existsSync: () => false }, './store': f.store, './scheduler': sched, './client': {}, './plugins': {}, './paths': { baseDir: '/isolated' }, './daily-result': daily };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    } };
  vm.runInNewContext(source, sandbox, { filename: 'server.js' });
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
  for (const [route, body] of [
    ['POST /api/accounts/:id/signin', {}],
    ['POST /api/accounts/:id/action', { type: 'signin' }],
    ['POST /api/accounts/:id/action', { type: 'farmSignin' }],
    ['GET /api/accounts/:id/signin', {}],
  ]) {
    const res = response();
    await routes[route]({ params: { id: 'test' }, body }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SIGNIN_MULTI_ACCOUNT');
  }
  assert.equal(requests, 1);
  assert.equal(f.account.status.dailyResults.farmSignin.state, 'failed');
});

test('真实 store 在隔离目录落盘并重新加载后保留失败和停止重试状态', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-daily-store-'));
  try {
    const mocks = { fs, path, './paths': { baseDir: dir } };
    const store = isolated('store.js', mocks);
    const acc = store.add({ name: 'test', config: { enabled: false } });
    store.setStatus(acc.id, { dailyResults: { qqSignin: { ...daily.classifyResult('qqSignin', REJECTION), at: Date.now(), date: '2000-01-01' } } });
    const reloaded = isolated('store.js', mocks).get(acc.id);
    assert.equal(daily.isBlocked(reloaded, 'qqSignin'), true);
    assert.equal(reloaded.status.dailyResults.qqSignin.state, 'failed');
    assert.equal(reloaded.status.dailyDone?.qqSignin, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('QQ 签到读页面和直接领取提交均使用全局手机 UA', async () => {
  const { FarmClient, USER_AGENT } = require('../src/client');
  const requests = [];
  const client = new FarmClient(null); client.minGap = 0;
  client._f = async (url, opts) => {
    requests.push({ url, opts });
    return { status: 200, headers: { getSetCookie: () => [] }, text: async () => opts.method === 'POST' ? '成功获得:积分100' : '<form action="sign.do">直接领取今日奖励</form>' };
  };
  const signin = isolated('signin.js', { './captcha': { solveCaptcha() { throw new Error('Unexpected OCR'); } }, './daily-result': daily });
  assert.equal(await signin.qqSignin(client), '成功获得:积分100');
  assert.equal(requests.length, 2);
  assert.match(USER_AGENT, /Android.*Mobile/);
  assert.equal(requests[0].opts.headers['User-Agent'], USER_AGENT);
  assert.equal(requests[1].opts.headers['User-Agent'], USER_AGENT);
  assert.equal(requests[1].opts.body, 'type=1&confirm=1&authnum=');
});

test('农场与各插件、登录底层及重定向请求统一使用手机 UA', async () => {
  const { FarmClient, USER_AGENT } = require('../src/client');
  const { PastureClient, PetClient, GoldClient } = require('../src/plugins');
  for (const Client of [FarmClient, PastureClient, PetClient, GoldClient]) {
    const client = new Client(null); client.minGap = 0;
    const requests = [];
    client._f = async (url, opts) => {
      requests.push({ url, opts });
      return { status: requests.length === 1 ? 302 : 200,
        headers: { get: () => '/example', getSetCookie: () => [] }, text: async () => '测试页面' };
    };
    await client.req('index.do');
    await client._raw('https://tx.com.cn/in/login.do');
    await client._follow({ headers: { get: () => '/in/login.do' } }, 'https://tx.com.cn/', 1);
    assert.equal(requests.length, 4);
    for (const r of requests) assert.equal(r.opts.headers['User-Agent'], USER_AGENT, Client.name);
  }
});

test('网页代理不透传 PC UA，验证码图片与网页重定向也使用手机 UA', async () => {
  const { USER_AGENT } = require('../src/client');
  const routes = {}, requests = [];
  const app = { use() {}, get(p,fn) { routes[p] = fn; }, post() {}, put() {}, delete() {}, all(p, middleware, fn) { routes.proxy = fn; }, listen() { return { on() {} }; } };
  const express = Object.assign(() => app, { json() {}, static() {}, raw() {} });
  const client = {
    cookieHeader: () => '', absorbSetCookie() {},
    _f: async (url, opts) => {
      requests.push({url,opts});
      return { status: requests.length === 1 ? 302 : 200, headers: { get: key => key === 'location' ? '/activity/qq/cs/sign.do' : 'text/html' }, text: async () => '<html>页面</html>', arrayBuffer: async () => new ArrayBuffer(0) };
    },
  };
  const sandbox = { process: { env: {} }, console: { log() {} }, URL, Buffer,
    require(name) {
      const mocks = { express, path, fs: { existsSync: () => false }, './store': { get: () => ({ id: 'test' }) }, './scheduler': { getClient: () => client }, './client': { USER_AGENT }, './plugins': {}, './paths': { baseDir: '/isolated' }, './daily-result': daily };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8'), sandbox);
  const res = { set() {}, send() {}, status(n) { throw new Error('Unexpected HTTP '+n); } };
  await routes.proxy({ params: ['test', 'activity/qq/cs/sign.do'], url: '/b/test/activity/qq/cs/sign.do', method: 'GET', headers: { 'user-agent': 'Desktop Browser' } }, res);
  await routes['/api/accounts/:id/captcha-img']({ params: {id:'test'}, query: { url: 'https://tx.com.cn/in/fltregimg.jsp' } }, res);
  assert.equal(requests.length, 3);
  for (const r of requests) assert.equal(r.opts.headers['User-Agent'], USER_AGENT);
});
