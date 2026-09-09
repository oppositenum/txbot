// 管理后端：REST API + H5 静态页
const express = require('express');
const path = require('path');
const store = require('./store');
const sched = require('./scheduler');
const { FarmClient } = require('./client');
const { PastureClient, PetClient, GoldClient } = require('./plugins');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

const pub = (a) => ({ id: a.id, name: a.name, config: a.config, status: a.status, hasCookie: !!a.cookie, hasCreds: !!(a.useruid && a.password), useruid: a.useruid || null, proxy: a.proxy || null });

// ---- 全局设置 ----
app.get('/api/settings', (req, res) => res.json(store.getSettings()));
app.put('/api/settings', (req, res) => res.json(store.setSettings(req.body || {})));

// 新账号默认配置模板
app.get('/api/default-config', (req, res) => res.json(store.getDefaultConfig() || {}));
app.put('/api/default-config', (req, res) => res.json(store.setDefaultConfig(req.body || {})));
// 一键把某配置应用到所有已有账号（并可同时设为新账号模板）
app.post('/api/apply-config-all', (req, res) => {
  const cfg = req.body && req.body.config ? req.body.config : req.body;
  const n = store.applyConfigToAll(cfg);
  if (req.body && req.body.asTemplate) store.setDefaultConfig(cfg);
  // 让所有在跑的账号按新配置重排 job
  store.list().forEach((a) => { if (a.config.enabled) sched.start(a.id); });
  res.json({ ok: true, applied: n });
});

// ---- 代理管理：保存的代理列表 + 批量分配给勾选的账号 ----
app.get('/api/proxies', (req, res) => res.json(store.getSettings().proxies || []));
app.put('/api/proxies', (req, res) => {
  const proxies = Array.isArray(req.body) ? req.body : (req.body.proxies || []);
  res.json(store.setSettings({ proxies }).proxies);
});
app.post('/api/apply-proxy', (req, res) => {
  const { proxy, accountIds } = req.body || {};
  const n = store.applyProxyToAccounts(proxy, accountIds);
  (accountIds || []).forEach((id) => sched.resetClient(id));
  res.json({ ok: true, applied: n });
});

// ---- 账号管理 ----
app.get('/api/accounts', (req, res) => res.json(store.list().map(pub)));

// 支持两种模式：{cookie} 或 {useruid, password}；均可带 proxy
app.post('/api/accounts', async (req, res) => {
  const { name, cookie, useruid, password, proxy, config } = req.body;
  try {
    if (useruid && password) {
      // 账密模式：用该账号的代理登录验证，成功再保存
      const c = new FarmClient(null, { proxy });
      const gotCookie = await c.login(useruid.trim(), password);
      const acc = store.add({ name, cookie: gotCookie, useruid: useruid.trim(), password, proxy, config });
      sched.getClient(acc);
      sched.log(acc.id, `账号已添加(账密登录${proxy ? '·代理' : ''}): ${acc.name}`);
      return res.json(pub(acc));
    }
    if (cookie && /JSESSIONID/i.test(cookie)) {
      const acc = store.add({ name, cookie: cookie.trim(), proxy, config });
      sched.log(acc.id, `账号已添加(Cookie${proxy ? '·代理' : ''}): ${acc.name}`);
      return res.json(pub(acc));
    }
    res.status(400).json({ error: '请提供账号密码，或含 JSESSIONID 的 Cookie' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== Cookie 注入反向代理：本地浏览器经此以账号身份浏览 tx.com.cn =====
// 访问 /b/:id/<tx路径> → 服务端带该账号 cookie 转发，HTML 内链接重写回代理
function rewriteHtml(html, id, curPath) {
  const dir = ('/' + curPath).replace(/[^/]*$/, ''); // 当前页目录
  let out = html
    // 绝对 tx.com.cn 链接 → 代理
    .replace(/(href|src|action)=("|')https?:\/\/tx\.com\.cn\//gi, `$1=$2/b/${id}/`)
    // 根相对(排除 // 和 已是/b/) → 代理
    .replace(/(href|src|action)=("|')\/(?!\/)(?!b\/)/gi, `$1=$2/b/${id}/`);
  const base = `<base href="/b/${id}${dir}">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + base) : base + out;
  return out;
}

app.all(/^\/b\/([^/]+)\/(.*)$/, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const id = req.params[0], rest = req.params[1];
  const acc = store.get(id);
  if (!acc) return res.status(404).send('账号不存在');
  const c = sched.getClient(acc);
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = 'https://tx.com.cn/' + rest + qs;
  try {
    const opts = {
      method: req.method,
      headers: {
        Cookie: c.cookieHeader(),
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        Referer: 'https://tx.com.cn/',
        ...(req.method === 'POST' ? { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' } : {}),
      },
      redirect: 'manual',
      ...(req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length ? { body: req.body } : {}),
    };
    // 复用 FarmClient._f()（自带按代理调整的超时+重试），而不是裸 fetch——
    // 之前这里裸 fetch 没有任何超时/重试兜底，账号挂了代理时代理端口一抖动就直接 502
    let r = await c._f(target, opts);
    c.absorbSetCookie(r);
    // 跟随重定向（保持 cookie，改写回代理域）
    for (let i = 0; i < 5 && r.status >= 300 && r.status < 400; i++) {
      let loc = r.headers.get('location'); if (!loc) break;
      loc = (loc.startsWith('/') ? 'https://tx.com.cn' + loc : loc).replace(/^http:/, 'https:');
      if (/^https:\/\/tx\.com\.cn\//.test(loc)) { r = await c._f(loc, { headers: opts.headers, redirect: 'manual' }); c.absorbSetCookie(r); }
      else { return res.redirect(loc); }
    }
    const ct = r.headers.get('content-type') || '';
    if (/text\/html/i.test(ct)) {
      const html = await r.text();
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(rewriteHtml(html, id, rest));
    }
    res.set('Content-Type', ct);
    return res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).send('代理失败: ' + e.message);
  }
});

// 手动触发重新登录（账密模式）
app.post('/api/accounts/:id/relogin', async (req, res) => {
  try {
    const ok = await sched.relogin(req.params.id);
    if (!ok) return res.status(400).json({ error: '该账号未配置账号密码' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.update(req.params.id, req.body);
  if (!acc) return res.status(404).json({ error: 'not found' });
  if (req.body.cookie || req.body.proxy !== undefined) sched.resetClient(acc.id);
  // enabled 开关联动调度
  if (req.body.config && 'enabled' in req.body.config) {
    req.body.config.enabled ? sched.start(acc.id) : sched.stop(acc.id);
  }
  res.json(pub(acc));
});

app.delete('/api/accounts/:id', (req, res) => {
  sched.stop(req.params.id);
  store.remove(req.params.id);
  res.json({ ok: true });
});

// ---- 执行与状态 ----
app.post('/api/accounts/:id/run', (req, res) => {
  sched.runCycle(req.params.id, true);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/logs', (req, res) => res.json(sched.logs[req.params.id] || []));

// 实时农场快照
app.get('/api/accounts/:id/farm', async (req, res) => {
  const acc = store.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  try {
    const c = sched.getClient(acc);
    const farm = await c.getFarm();
    store.setStatus(acc.id, { level: farm.level, coin: farm.coin });
    res.json(farm);
  } catch (e) {
    res.status(500).json({ error: e.message, needLogin: e.code === 'NOT_LOGGED_IN' });
  }
});

app.get('/api/accounts/:id/bag', async (req, res) => {
  try { res.json(await sched.getClient(store.get(req.params.id)).getBag()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts/:id/store', async (req, res) => {
  try { res.json(await sched.getClient(store.get(req.params.id)).getStore()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts/:id/tasks', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    const tasks = await c.getTasks();
    const details = await Promise.all(tasks.map((t) => c.getTaskInfo(t.taskId).then((info) => ({ ...t, ...info })).catch(() => ({ ...t, need: null, have: 0, canFinish: false }))));
    res.json(details);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts/:id/shop', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    res.json(await c.getShop(+req.query.category || 0, +req.query.lv || 0, +req.query.pn || 1));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 完整种子目录(全部档位)+当前种子袋库存合并，供「种植种子」下拉全选
app.get('/api/accounts/:id/seed-catalog', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    const [catalog, bag] = await Promise.all([c.getSeedCatalog(), c.getBag()]);
    const bagMap = new Map(bag.map((b) => [b.seedsId, b.count]));
    res.json(catalog.map((item) => ({ ...item, count: bagMap.get(item.seedsId) || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts/:id/rank', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    res.json(await c.getRankAll(+req.query.oper || 0, +req.query.maxPages || 15));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动单项操作
const ACTIONS = {
  // 农场 · 一键
  harvestAll: (c) => c.harvestAll(), digAll: (c) => c.digAll(), weedAll: (c) => c.weedAll(),
  killAll: (c) => c.killAll(), waterAll: (c) => c.waterAll(), muckAll: (c) => c.muckAll(),
  sellAll: (c) => c.sellAll(), lockAll: (c, p) => c.lockAll(p.toLocked),
  useExp2All: (c) => c.useExp2All(), useCoin2All: (c) => c.useCoin2All(),
  // 农场 · 单项
  sow: (c, p) => c.sowAll(p.seedsId, p.num || 1),
  buy: (c, p) => c.buySeeds(p.seedsId, p.num || 1),
  sell: (c, p) => c.sell(p.seedsId, p.num || 1),
  lock: (c, p) => c.lock(p.seedsId, p.toLocked),
  useTool: (c, p) => c.useTool(p.toolsId, p.landId || 0, p.tuid || 0),
  muckLand: (c, p) => c.muckLand(p.landId, p.strong),
  harvest: (c, p) => c.harvest(p.landId),
  waterLand: (c, p) => c.waterLand(p.landId, p.tuid || 0),
  sowFriend: (c, p) => c.sowFriendSeeds(p.seedsId, p.landUid),
  giveTool: (c, p) => c.giveTool(p.toolsId, p.friendId),
  stallSell: (c, p) => c.stallSell(p.goodsId, p.nums, p.price, p.type || 1, p.pwd || ''),
  changeSeason: (c, p) => c.changeSeason(p.landId, p.season),
  toSpecialLand: (c, p) => c.toSpecialLand(p.landId, p.sowSpecial),
  openFun: (c, p) => c.openFun(p.actionId),
  finishTask: (c, p) => c.finishTask(p.orderId),
  signin: (c, p) => c.signin(p.regkey, p.authnum),
  farmSignin: (c) => require('./signin').farmSignin(c),
  groupSignin: (c) => require('./signin').groupSignin(c),
  qqSignin: (c) => require('./signin').qqSignin(c),
  grabOnce: async (c, p) => { const r = await c.grabRoomCards(p.room || 696); return r.found ? `抢到:${r.results.join('/')||r.found}` : '当前无抢卡活动'; },
};

// 插件动作：pasture/pet/gold（客户端复用账号 cookie jar）
const PLUGIN_CLIENTS = { pasture: PastureClient, pet: PetClient, gold: GoldClient };
const PLUGIN_ACTIONS = {
  pasture: { info: (c) => c.getInfo(), dailyAward: (c) => c.dailyAward(), harvestAll: (c) => c.harvestAll(),
    feedAll: (c) => c.feedAll(), disinfectAll: (c) => c.disinfectAll(), cleanAll: (c) => c.cleanAll(),
    fattenAll: (c) => c.fattenAll(), nurseAll: (c) => c.nurseAll(), harvest: (c, p) => c.harvest(p.id),
    feedDog: (c) => c.feedDog(), restock: async (c, p) => { const r = await c.restockAll(p.femaleid || null); return `补栏${r.n}圈舍${r.name ? '×' + r.name : ''}`; },
    feedAnimals: async (c) => `喂食 ${await c.feedAnimals()} 只`, cleanAnimals: async (c) => `洗澡 ${await c.cleanAnimals()} 只`,
    pioneer: (c, p) => c.pioneer(p.sceneid || 1, p.action || 1) },
  pet: { info: (c) => c.getInfo(), dailyAllowance: (c) => c.dailyAllowance(), attendance: (c) => c.attendance(),
    harvestWork: async (c) => { const n = await c.harvestWork(); return `种花收获 ${n} 处花圃`; }, feed: (c) => c.feed(),
    trainInfo: (c) => c.getTrain(), train: async (c, p) => { const r = await c.train(p.wt || 3); return r.reason; } },
  gold: { info: (c) => c.getInfo(), dailyReward: (c) => c.dailyReward(), practice: (c) => c.practice(), dig: (c, p) => c.dig(p.digType || 2),
    fightStatus: (c, p) => c.getFightStatus(p.maxLevel || 29),
    fightOnce: async (c, p) => {
      const targets = await c.getFightTargets(p.maxLevel || 29);
      if (!targets.length) return '当前无可打的怪(都在冷却中)';
      const results = [];
      for (const t of targets) { const r = await c.fightBoss(t.mapId, t.bossId); results.push(`${t.name}(Lv${t.level}):${r.ok ? '胜利' : r.reason}`); }
      return results.join(' / ');
    } },
};
app.post('/api/accounts/:id/action', async (req, res) => {
  const acc = store.get(req.params.id);
  const fn = ACTIONS[req.body.type];
  if (!acc || !fn) return res.status(400).json({ error: 'bad request' });
  try {
    const result = await fn(sched.getClient(acc), req.body);
    sched.log(acc.id, `手动[${req.body.type}]: ${result}`);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 插件动作：POST /api/accounts/:id/plugin/:plugin  body {type, ...params}
app.post('/api/accounts/:id/plugin/:plugin', async (req, res) => {
  const acc = store.get(req.params.id);
  const Cls = PLUGIN_CLIENTS[req.params.plugin];
  const fn = PLUGIN_ACTIONS[req.params.plugin]?.[req.body.type];
  if (!acc || !Cls || !fn) return res.status(400).json({ error: 'bad request' });
  try {
    const client = new Cls(sched.getClient(acc).jar, { proxy: acc.proxy }); // 复用农场登录态 cookie jar + 该账号代理
    const result = await fn(client, req.body);
    if (req.body.type !== 'info') sched.log(acc.id, `[${req.params.plugin}.${req.body.type}]: ${typeof result === 'string' ? result : JSON.stringify(result).slice(0, 80)}`);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 签到（验证码人工输入） ----
app.get('/api/accounts/:id/signin', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    const { regkey, img } = await c.getSignin();
    res.json({ regkey, img: img ? new URL(img, 'https://tx.com.cn/plugins/farm/cs/').href : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 代理验证码图片（带账号 Cookie）
app.get('/api/accounts/:id/captcha-img', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    const r = await c._f(req.query.url, { headers: { Cookie: c.cookieHeader(), 'User-Agent': 'Mozilla/5.0', Referer: 'https://tx.com.cn/plugins/farm/cs/verification.do' } });
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).end(); }
});

app.post('/api/accounts/:id/signin', async (req, res) => {
  try {
    const c = sched.getClient(store.get(req.params.id));
    const result = await c.signin(req.body.regkey, req.body.authnum);
    sched.log(req.params.id, `签到: ${result}`);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // 默认监听所有网卡，便于局域网/服务器访问
const server = app.listen(PORT, HOST, () => {
  console.log(`txbot 管理面板已启动`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log(`  局域网访问: http://${ni.address}:${PORT}`);
      }
    }
  }
  sched.resume();
});
// 端口已被占用 → 说明已有实例在跑，直接退出，避免第二个调度器写坏 accounts.json
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`端口 ${PORT} 已被占用，已有 txbot 在运行；本进程退出以避免冲突。`); process.exit(1); }
  else { console.error('服务错误:', e.message); process.exit(1); }
});
