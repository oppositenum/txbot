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
    process: { env: {} }, console: { log() {}, error() {} }, URL, Buffer,
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
