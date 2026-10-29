const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBulkRoute(accounts) {
  const routes = {};
  const calls = { start: [], stop: [] };
  const app = {
    use() {},
    get() {},
    post(route, handler) { routes[route] = handler; },
    put() {}, delete() {}, all() {},
    listen() { return { on() {} }; },
  };
  const express = Object.assign(() => app, { json() {}, static() {}, raw() {} });
  const store = { list: () => accounts, get: id => accounts.find(account => account.id === id) };
  const sched = {
    start(id) { calls.start.push(id); store.get(id).config.enabled = true; },
    stop(id) { calls.stop.push(id); store.get(id).config.enabled = false; },
  };
  const sandbox = {
    process: { env: {} }, console: { log() {}, error() {} }, URL, Buffer, Set, Map, Promise,
    require(name) {
      const mocks = {
        express, path, fs: { existsSync: () => false }, './store': store, './scheduler': sched,
        './client': {}, './plugins': {}, './paths': { baseDir: '/isolated' }, './daily-result': {},
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8'), sandbox, { filename: 'server.js' });
  return { handler: routes['/api/accounts/bulk-enabled'], calls };
}

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('一键托管和停止只改变目标状态，已处于目标状态的账号不重排', () => {
  const accounts = [
    { id: 'a1', config: { enabled: true } },
    { id: 'a2', config: { enabled: false } },
    { id: 'a3', config: { enabled: false } },
  ];
  const fixture = loadBulkRoute(accounts);
  const startRes = response();
  fixture.handler({ body: { enabled: true } }, startRes);
  assert.deepEqual(fixture.calls.start, ['a2', 'a3']);
  assert.deepEqual(fixture.calls.stop, []);
  assert.deepEqual({ ...startRes.body }, { ok: true, enabled: true, affected: 2, total: 3 });

  const stopRes = response();
  fixture.handler({ body: { enabled: false } }, stopRes);
  assert.deepEqual(fixture.calls.stop, ['a1', 'a2', 'a3']);
  assert.deepEqual({ ...stopRes.body }, { ok: true, enabled: false, affected: 3, total: 3 });
});

function loadFriendRoutes(accounts, addFriend) {
  const routes = { post: {}, get: {} };
  const app = {
    use() {}, get(route, handler) { routes.get[route] = handler; },
    post(route, handler) { routes.post[route] = handler; },
    put() {}, delete() {}, all() {}, listen() { return { on() {} }; },
  };
  const express = Object.assign(() => app, { json() {}, static() {}, raw() {} });
  const store = { list: () => accounts, get: id => accounts.find(account => account.id === id) };
  const sched = { getClient: () => ({ addFriend }), log() {}, relogin() {} };
  const sandbox = {
    process: { env: {} }, console: { log() {}, error() {} }, URL, Buffer, Set, Map, Promise,
    require(name) {
      const mocks = {
        express, path, fs: { existsSync: () => false }, './store': store, './scheduler': sched,
        './client': {}, './plugins': {}, './paths': { baseDir: '/isolated' }, './daily-result': {},
      };
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8'), sandbox, { filename: 'server.js' });
  return routes;
}

test('全员加好友立即返回进度，并在每个账号完成后更新', async () => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const accounts = [
    { id: 'a1', name: '一号', cookie: 'JSESSIONID=1' },
    { id: 'a2', name: '二号', cookie: 'JSESSIONID=2' },
    { id: 'a3', name: '三号' },
  ];
  const routes = loadFriendRoutes(accounts, async (condition) => {
    await started;
    return { ok: true, already: false, message: condition + ' 已发送' };
  });
  const created = response();
  routes.post['/api/accounts/add-friend-all']({ body: { condition: '30146530', notice: '你好' } }, created);
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.status, 'running');
  assert.equal(created.body.total, 2);
  assert.equal(created.body.skipped, 1);
  assert.equal(created.body.done, 0);

  const busy = response();
  routes.post['/api/accounts/add-friend-all']({ body: { condition: '30146530' } }, busy);
  assert.equal(busy.statusCode, 409);

  release();
  const finished = await new Promise((resolve) => {
    const read = () => {
      const res = response();
      routes.get['/api/accounts/add-friend-jobs/:id']({ params: { id: created.body.id } }, res);
      if (res.body.status === 'done') resolve(res.body);
      else setTimeout(read, 5);
    };
    read();
  });
  assert.equal(finished.done, 2);
  assert.equal(finished.success, 2);
  assert.equal(finished.results.map((item) => item.name).sort().join(','), '一号,二号');
});

test('批量启停接口拒绝非布尔 enabled，且不修改账号', () => {
  const accounts = [{ id: 'a1', config: { enabled: true } }];
  const fixture = loadBulkRoute(accounts);
  const res = response();
  fixture.handler({ body: { enabled: 'false' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /布尔值/);
  assert.equal(accounts[0].config.enabled, true);
  assert.deepEqual(fixture.calls, { start: [], stop: [] });
});
