const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function isolatedStore(dir) {
  const source = fs.readFileSync(path.join(__dirname, '../src/store.js'), 'utf8');
  const sandbox = {
    module: { exports: {} }, Date, Object, console: { log() {} },
    require(name) {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      if (name === './paths') return { baseDir: dir };
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'store.js' });
  return sandbox.module.exports;
}

test('账号导出包含继续运行所需配置，但不包含临时状态', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-export-'));
  try {
    const store = isolatedStore(dir);
    const account = store.add({ name: '主号', useruid: '10001', password: 'secret', cookie: 'JSESSIONID=session1; txuid=10001', proxy: 'http://proxy:8080', config: { enabled: true, steal: true, grabWindowMin: 10 } });
    store.setStatus(account.id, { coin: 999, lastResult: '运行记录' });
    const bundle = store.exportAccounts();
    assert.equal(bundle.format, 'txbot-account-export');
    assert.equal(bundle.version, 1);
    assert.equal(bundle.sensitive, true);
    assert.equal(bundle.accounts.length, 1);
    assert.equal(bundle.accounts[0].password, 'secret');
    assert.equal(bundle.accounts[0].cookie, 'JSESSIONID=session1; txuid=10001');
    assert.equal(bundle.accounts[0].proxy, 'http://proxy:8080');
    assert.equal(bundle.accounts[0].config.steal, true);
    assert.equal('grabWindowMin' in bundle.accounts[0].config, false);
    assert.equal('status' in bundle.accounts[0], false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('导入默认暂停且跳过重复账号，显式覆盖后可恢复原启用状态', () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-source-'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-target-'));
  try {
    const source = isolatedStore(sourceDir);
    source.add({ name: '账号A', useruid: '10001', password: 'pass-a', cookie: 'JSESSIONID=a; txuid=10001', config: { enabled: true, farmPollMaxMin: 7 } });
    source.add({ name: '账号B', cookie: 'JSESSIONID=b; txuid=10002', proxy: 'http://proxy:8080', config: { enabled: false, water: false } });
    const bundle = JSON.parse(JSON.stringify(source.exportAccounts()));
    const target = isolatedStore(targetDir);

    const first = target.importAccounts(bundle);
    assert.deepEqual({ total: first.total, added: first.added, updated: first.updated, skipped: first.skipped }, { total: 2, added: 2, updated: 0, skipped: 0 });
    assert.equal(target.list().every((account) => account.config.enabled === false), true);
    assert.equal(target.list()[0].config.farmPollMaxMin, 7);
    assert.equal(target.list()[1].proxy, 'http://proxy:8080');

    const duplicate = target.importAccounts(bundle);
    assert.deepEqual({ added: duplicate.added, updated: duplicate.updated, skipped: duplicate.skipped }, { added: 0, updated: 0, skipped: 2 });

    bundle.accounts[0].name = '账号A已更新';
    bundle.accounts[0].config.farmPollMaxMin = 3;
    const replaced = target.importAccounts(bundle, { overwrite: true, resumeEnabled: true });
    assert.deepEqual({ added: replaced.added, updated: replaced.updated, skipped: replaced.skipped }, { added: 0, updated: 2, skipped: 0 });
    assert.equal(target.list()[0].name, '账号A已更新');
    assert.equal(target.list()[0].config.enabled, true);
    assert.equal(target.list()[0].config.farmPollMaxMin, 3);
    assert.equal(target.list()[1].config.enabled, false);
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('无效或文件内重复的导入包在写入前整体拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-invalid-import-'));
  try {
    const store = isolatedStore(dir);
    assert.throws(() => store.importAccounts({ format: 'other', version: 1, accounts: [] }), /不是受支持/);
    const account = { name: '重复号', useruid: '10001', password: 'pass', cookie: null, proxy: null, config: { enabled: true } };
    assert.throws(() => store.importAccounts({ format: 'txbot-account-export', version: 1, accounts: [account, { ...account }] }), /文件内其他账号重复/);
    const polluted = JSON.parse('{"format":"txbot-account-export","version":1,"accounts":[{"useruid":"10002","password":"pass","config":{"__proto__":{"enabled":true}}}]}');
    assert.throws(() => store.importAccounts(polluted), /未知配置项/);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('账密账号和相同txuid的Cookie账号识别为同一账号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-identity-import-'));
  try {
    const store = isolatedStore(dir);
    store.add({ name: '已有账密号', useruid: '10001', password: 'pass', cookie: 'JSESSIONID=old; txuid=10001' });
    const cookieAccount = { name: 'Cookie备份', cookie: 'JSESSIONID=new; txuid=10001', useruid: null, password: null, proxy: null, config: { enabled: true } };
    const result = store.importAccounts({ format: 'txbot-account-export', version: 1, accounts: [cookieAccount] });
    assert.equal(result.skipped, 1);
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧迁移包的grabWindowMin已废弃但不会阻断导入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-legacy-import-'));
  try {
    const store = isolatedStore(dir);
    const legacy = {
      format: 'txbot-account-export', version: 1,
      accounts: [{ name: '旧配置账号', useruid: '10003', password: 'pass', cookie: null, proxy: null, config: { enabled: true, grabWindowMin: 10, grabPollSec: 3 } }],
    };
    const result = store.importAccounts(legacy, { resumeEnabled: true });
    assert.equal(result.added, 1);
    assert.equal(store.list()[0].config.enabled, true);
    assert.equal(store.list()[0].config.grabPollSec, 3);
    assert.equal('grabWindowMin' in store.list()[0].config, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('导入身份不能多对一或一对多匹配目标账号，冲突时不写入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txbot-target-conflict-'));
  try {
    const store = isolatedStore(dir);
    store.add({ name: '目标A', useruid: '10001', password: 'pass-a', cookie: 'JSESSIONID=session-a; txuid=10001' });
    store.add({ name: '目标B', useruid: '10002', password: 'pass-b', cookie: 'JSESSIONID=session-b; txuid=10002' });
    const format = { format: 'txbot-account-export', version: 1 };

    const sameTarget = [
      { name: '覆盖A-账号', useruid: '10001', password: 'new-a', cookie: null, config: { enabled: true } },
      { name: '覆盖A-会话', useruid: null, password: null, cookie: 'JSESSIONID=session-a; txuid=99999', config: { enabled: true } },
    ];
    assert.throws(() => store.importAccounts({ ...format, accounts: sameTarget }, { overwrite: true }), /同一目标账号/);
    assert.equal(store.list().map((account) => account.name).join(','), '目标A,目标B');

    const splitTarget = [{ name: '跨账号冲突', useruid: '10001', password: 'new-a', cookie: 'JSESSIONID=session-b; txuid=99998', config: { enabled: true } }];
    assert.throws(() => store.importAccounts({ ...format, accounts: splitTarget }, { overwrite: true }), /多个账号/);
    assert.equal(store.list().map((account) => account.name).join(','), '目标A,目标B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
