// FarmClient — tx.com.cn 天下农场纯协议客户端
const BASE = 'https://tx.com.cn/plugins/farm/cs/';
// 所有游戏协议请求统一使用已实测可签到的手机设备标识。
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

let ProxyAgent = null, undiciFetch = null;
try { ({ ProxyAgent, fetch: undiciFetch } = require('undici')); } catch { /* undici 不可用则代理功能禁用 */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) =>
  h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

class FarmClient {
  // cookie: 字符串 "k=v; k2=v2" 或 {k:v} 对象；opts.proxy: "http://[user:pass@]host:port"
  constructor(cookie, opts = {}) {
    this.jar = {};
    if (typeof cookie === 'string') {
      cookie.split(/;\s*/).forEach((p) => {
        const i = p.indexOf('=');
        if (i > 0) this.jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
    } else Object.assign(this.jar, cookie || {});
    this.z = null;
    this.lastReq = 0;
    this.lastSow = 0;
    this.minGap = 1500; // 全局最小请求间隔
    this.base = BASE;   // 插件基址，子类可覆盖
    this.setProxy(opts.proxy);
  }

  setProxy(proxy) {
    this.proxy = proxy || null;
    this.dispatcher = (proxy && ProxyAgent) ? new ProxyAgent(proxy) : null;
    // 走代理的请求更容易遇到"代理本身没坏，但被多账号共用同一端口挤爆连接池"这种瞬时抖动
    // (比直连更容易出现)，所以走代理时超时/重试次数都加大，直连保持原来的快速失败节奏
    this.timeoutMs = proxy ? 30000 : 15000;
    this.maxRetries = proxy ? 4 : 2;
  }

  // 统一 fetch：自动附带代理 dispatcher + 超时保护
  // 没有超时的话，一旦某次请求卡死(代理故障/连接挂起)，对应 Promise 永远不 resolve，
  // 调度器该任务的并发锁(running Set)会被永久占用，之后再也不会被重新调度，且不报任何错——
  // 表现为"这个任务突然再也不跑了"，很难排查。所以任何网络请求都必须有超时兜底。
  // 网络层失败(超时/连接被拒/连接重置等，fetch()本身reject)才重试；
  // HTTP响应本身(哪怕4xx/5xx，或页面里写着"等级不够"/"体力不足"这类业务拒绝)
  // fetch()都会正常resolve，不会走进这个重试分支——避免对业务拒绝做无意义的重复请求。
  async _f(url, options = {}) {
    // 走代理时必须用 undici 自己的 fetch，不能用 Node 全局 fetch：
    // Node 内置全局 fetch 由 Node 自带的 undici 版本支撑，跟 node_modules 里单独装的 undici
    // 包(ProxyAgent 从这里 new 出来)版本一旦不一致，dispatcher 内部请求处理器接口对不上，
    // 每次都会 100% 报 "fetch failed"(cause: invalid onRequestStart method)——不是代理本身
    // 的问题，用 curl -x 测代理连通性完全正常也测不出这个坑，只有实际跑起来才会炸。
    const doFetch = this.dispatcher && undiciFetch ? undiciFetch : fetch;
    if (this.dispatcher) options = { ...options, dispatcher: this.dispatcher };
    const maxRetries = this.maxRetries ?? 2; // 直连默认最多重试2次(共3次尝试)，走代理默认4次(共5次)
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await doFetch(url, { signal: AbortSignal.timeout(this.timeoutMs || 15000), ...options });
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) await sleep(500 * (attempt + 1) + Math.random() * 300); // 递增退避
      }
    }
    throw lastErr;
  }

  cookieHeader() {
    return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorbSetCookie(res) {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of sc) {
      const kv = line.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }

  // 底层请求（手动重定向，供登录链使用）
  async _raw(url, opts = {}) {
    const wait = this.lastReq + this.minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastReq = Date.now();
    const res = await this._f(url.replace(/^http:/, 'https:'), {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        Cookie: this.cookieHeader(),
        Referer: opts.referer || 'https://tx.com.cn/',
        ...(opts.origin ? { Origin: 'https://tx.com.cn' } : {}),
        ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: opts.body,
      redirect: 'manual',
    });
    this.absorbSetCookie(res);
    return res;
  }

  async _follow(res, referer, max = 8) {
    for (let i = 0; i < max; i++) {
      const loc = res.headers.get('location');
      if (!loc) break;
      res = await this._raw(loc.startsWith('/') ? 'https://tx.com.cn' + loc : loc, { referer });
    }
    return res;
  }

  // 账号密码登录（纯协议）。成功后 this.jar 就位，返回 Cookie 字符串
  async login(useruid, password) {
    this.jar = {};
    const loginPage = 'https://tx.com.cn/in/fltin_t.jsp?z=900000019&type=login';
    await this._raw(loginPage).then((r) => r.text());
    // 模拟浏览器 JS 设置的百度统计 cookie（服务端 cookie 检测会校验回传）
    const now = Math.floor(Date.now() / 1000);
    this.jar['Hm_lvt_0807807898758df58fac1b03d3aece54'] = String(now);
    this.jar['Hm_lpvt_0807807898758df58fac1b03d3aece54'] = String(now);
    this.jar.HMACCOUNT = Array.from({ length: 16 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
    // cookie 检测预热链
    let r = await this._raw('https://tx.com.cn/in/login.do?kid=&type=passwdforward&cfrom=tx', { referer: loginPage });
    await this._follow(r, loginPage);
    // 提交登录
    r = await this._raw('https://tx.com.cn/in/cs/login.do?type=passwd', {
      method: 'POST',
      origin: true,
      referer: 'https://tx.com.cn/in/login.do?kid=',
      body: new URLSearchParams({ useruid, password, kid: '', hidden: '' }).toString(),
    });
    await this._follow(r, 'https://tx.com.cn/in/login.do?kid=');
    if (!this.jar.txuid) {
      const err = new Error('登录失败：账号或密码错误');
      err.code = 'LOGIN_FAILED';
      throw err;
    }
    this.z = null;
    return this.cookieHeader();
  }

  async req(path, opts = {}) {
    const wait = this.lastReq + this.minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastReq = Date.now();
    const url = path.startsWith('http') ? path : this.base + path;
    let res = await this._f(url, {
      method: opts.method || 'GET',
      headers: {
        Cookie: this.cookieHeader(),
        'User-Agent': UA,
        Referer: opts.referer || this.base + 'index.do',
        ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: opts.body,
      redirect: 'manual',
    });
    this.absorbSetCookie(res);
    // 手动跟随重定向，确保跨 http/https 也始终携带 Cookie
    for (let i = 0; i < 6 && res.status >= 300 && res.status < 400; i++) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = (loc.startsWith('/') ? 'https://tx.com.cn' + loc : loc).replace(/^http:/, 'https:');
      res = await this._f(next, { headers: { Cookie: this.cookieHeader(), 'User-Agent': UA, Referer: url }, redirect: 'manual' });
      this.absorbSetCookie(res);
    }
    const html = await res.text();
    // 未登录/失效强特征（被导向注册/登录页）；用组合词避免误伤正常操作页里的广告词
    const loggedOut = /欢迎注册天下网会员|会话已过期|登录超时|请重新登录|passport\.tx\.com/.test(html)
      || (/已有帐号登录/.test(html) && /免费注册/.test(html) && !/我的农场/.test(html));
    if (loggedOut && !/温馨提示/.test(html)) {
      const err = new Error('NOT_LOGGED_IN');
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }
    const zm = html.match(/z=([^"'&\s]+)/);
    if (zm) this.z = zm[1];
    return html;
  }

  // 解析成熟倒计时文本 "X小时Y分钟后成熟" → 分钟；无则 null
  static matureMinutes(text) {
    if (!text) return null;
    const hMatch = text.match(/(\d+)\s*小时/);
    const mMatch = text.match(/(\d+)\s*分钟/);
    if (!hMatch && !mMatch) return null;
    return +(hMatch?.[1] || 0) * 60 + +(mMatch?.[1] || 0);
  }

  // 农场下次可收获还需多少分钟：有已成熟地=0；否则取最近成熟；全空/无作物=null
  static nextFarmActionMinutes(lands) {
    if (lands.some((l) => l.canHarvest)) return 0;
    const mins = lands.map((l) => FarmClient.matureMinutes(l.matureIn)).filter((x) => x != null);
    return mins.length ? Math.min(...mins) : null;
  }

  // 从 HTML 提取"温馨提示"后的结果文本
  static resultText(html) {
    const t = strip(html);
    const i = t.indexOf('温馨提示');
    if (i >= 0) return t.slice(i + 4, i + 160).split(/返回我的农场|你还可以|>>/)[0].trim();
    const j = t.indexOf('我的农场');
    return t.slice(j >= 0 ? j : 0, (j >= 0 ? j : 0) + 120).trim();
  }

  async ensureZ() {
    if (!this.z) await this.req('index.do');
    return this.z;
  }

  // ============ 查询 ============

  // 农场概况 + 土地列表。翻页是"上一页/下一页"式，第1页看不到总页数，
  // 所以：第1页判断是否有下一页，有则一次性并行请求一批后续页；越界页会被服务端夹到最后一页，靠 landId 去重滤掉重复。
  async getFarm(maxPages = 20) {
    const html1 = await this.req('index.do');
    const t1 = strip(html1);
    const info = {
      waCoin: +((t1.match(/哇币\s*[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      coin: +((t1.match(/金币\s*[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      level: +(t1.match(/等级\s*[:：]\s*(\d+)/) || [])[1] || 0,
    };
    const seen = new Set();
    const lands = [];
    const addAll = (list) => { for (const l of list) { if (l.landId != null) { if (seen.has(l.landId)) continue; seen.add(l.landId); } lands.push(l); } };
    addAll(FarmClient.parseLands(html1));
    const hasNext = /myLand\.do\?pn=\d+/.test(html1);
    if (hasNext && maxPages > 1) {
      const rest = await Promise.all(Array.from({ length: maxPages - 1 }, (_, i) => this.req(`myLand.do?pn=${i + 2}`)));
      for (const html of rest) addAll(FarmClient.parseLands(html));
    }
    return { ...info, lands };
  }

  // 解析土地块：状态 + 可用操作链接（块形如 <strong>黑土地1\n</strong>:(作物)(0星)...）
  static parseLands(html) {
    const lands = [];
    const blocks = html.split(/(?=<strong>\s*黑?土地\d+)/).slice(1);
    for (const b of blocks) {
      const t = strip(b);
      const head = t.match(/(黑?土地)\s*(\d+)\s*[:：]\s*(?:\(([^)]*)\))?/);
      if (!head) continue;
      // 网站会把会话参数 z 放在 landId 前面，并以 HTML 实体编码连接符；
      // 不能假设 landId 紧跟在问号后面，否则页面显示可收割但调度器会漏判。
      const href = (name) => {
        const raw = (b.match(new RegExp(`${name}\\.do\\?[^"'<>\\s]+`)) || [])[0];
        return raw ? raw.replace(/&amp;/g, '&') : null;
      };
      const harvestHref = href('harvest');
      const landHref = ['harvest', 'upLandInfo', 'water', 'steal'].map(href).find(Boolean) || null;
      const landId = Number(new URLSearchParams(landHref?.split('?')[1] || '').get('landId')) || null;
      const land = {
        pos: +head[2],
        black: head[1] === '黑土地',
        crop: head[3] || null,
        star: +(t.match(/(\d+)星/) || [])[1] || 0,
        landId,
        mature: !!harvestHref || /steal\.do/.test(b),
        matureIn: (t.match(/(\d+小时)?(\d+分钟)?后成熟/) || [])[0] || null,
        yield: (t.match(/产[\d+]+\/剩\d+/) || [])[0] || null,
        empty: /空地/.test(t),
        needWater: (b.match(/water\.do\?landId=\d+[^"']*/) || [])[0] || null,
        needWeed: (b.match(/weeding\.do\?landId=\d+[^"']*/) || [])[0] || null,
        needKill: (b.match(/killInsect\w*\.do\?landId=\d+[^"']*/) || [])[0] || null,
        canSteal: (b.match(/steal\.do\?landId=\d+&(?:amp;)?tuid=\d+/) || [])[0] || null,
        canHarvest: landId && harvestHref ? harvestHref : null,
      };
      lands.push(land);
    }
    return lands;
  }

  // 种子袋 {seedsId, name, count}；兼容一键种植(sowSeedsAll)与普通单株(sowSeeds)两种布局
  // 第1页拿总页数后，其余页并行拉取（种子多的大号不用一页页排队等）
  async getBag() {
    const parsePage = (html) => {
      const re = /([一-龥A-Za-z0-9]+)\s*\((\d+)\s*粒?\)[\s\S]{0,260}?sowSeeds(?:All)?\.do\?(?:landId=\d+&(?:amp;)?)?seedsId=(\d+)/g;
      const out = []; let m;
      while ((m = re.exec(html))) out.push({ name: m[1], count: +m[2], seedsId: +m[3] });
      return out;
    };
    const seen = new Set();
    const seeds = [];
    const addAll = (list) => { for (const s of list) if (!seen.has(s.seedsId)) { seen.add(s.seedsId); seeds.push(s); } };
    const html1 = await this.req('myBag.do?keySow=1&pn=1');
    addAll(parsePage(html1));
    const pg = strip(html1).match(/(\d+)条,(\d+)\/(\d+)页/);
    const totalPages = Math.min(20, pg ? +pg[3] : 1);
    if (totalPages > 1) {
      const rest = await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => this.req(`myBag.do?keySow=1&pn=${i + 2}`)));
      for (const html of rest) addAll(parsePage(html));
    }
    return seeds;
  }

  // 果实仓库 {seedsId, name, count, locked}；同上并行翻页
  async getStore() {
    const parsePage = (html) => [...html.matchAll(/([一-龥A-Za-z0-9]+)\((\d+)\)[\s\S]{0,300}?lock\.do\?seedsId=(\d+)&(?:amp;)?lock=(\d)/g)]
      .map((m) => ({ name: m[1], count: +m[2], seedsId: +m[3], locked: m[4] === '1' }));
    const html1 = await this.req('myStore.do?pn=1');
    const t1 = strip(html1);
    const total = +(t1.match(/总价:(\d+)/) || [])[1] || 0;
    const items = parsePage(html1);
    const pgNums = t1.match(/(\d+)\s*页/g);
    const lastPage = Math.min(20, pgNums ? Math.max(...pgNums.map((x) => parseInt(x))) : 1);
    if (lastPage > 1) {
      const rest = await Promise.all(Array.from({ length: lastPage - 1 }, (_, i) => this.req(`myStore.do?pn=${i + 2}`)));
      for (const html of rest) items.push(...parsePage(html));
    }
    // 修正锁定语义: [锁]->lock.do?...&lock=0 表示点击后锁定(当前未锁), [解]->lock=1 表示点击解锁(当前已锁)
    items.forEach((i) => (i.locked = !i.locked));
    return { totalValue: total, items };
  }

  // 偷菜/护理排行 rank.do?oper=0偷|1草|2虫|3水 单页 → {friends:[{uid,name,rank}], maxPage}
  async getRank(oper = 0, pn = 1) {
    const html = await this.req(pn > 1 ? `rank.do?oper=${oper}&order=2&pn=${pn}` : `rank.do?oper=${oper}`);
    const friends = [...html.matchAll(/(\d+)\.\s*([^<:：]{1,25})[:：][\s\S]{0,200}?\/plugins\/farm\/index\.do\?[^"'<>]*?\buid=(\d+)/g)]
      .map((m) => ({ rank: +m[1], name: m[2].trim(), uid: +m[3] }));
    const pageNums = [...html.matchAll(/rank\.do\?[^"']*?pn=(\d+)/g)].map((m) => +m[1]);
    const maxPage = pageNums.length ? Math.max(pn, ...pageNums) : pn;
    return { friends, maxPage };
  }
  // 遍历所有页收集好友：第1页拿总页数后，其余页并行拉取
  async getRankAll(oper = 0, maxPages = 15) {
    const all = [];
    const seen = new Set();
    const addAll = (list) => { for (const f of list) if (!seen.has(f.uid)) { seen.add(f.uid); all.push(f); } };
    const { friends: f1, maxPage } = await this.getRank(oper, 1);
    addAll(f1);
    const total = Math.min(maxPage, maxPages);
    if (total > 1) {
      const rest = await Promise.all(Array.from({ length: total - 1 }, (_, i) => this.getRank(oper, i + 2)));
      for (const { friends } of rest) addAll(friends);
    }
    return all;
  }

  // 好友农场（含可偷/可护理链接）
  async getFriendFarm(uid, maxPages = 3) {
    const lands = [];
    for (let pn = 1; pn <= maxPages; pn++) {
      const html = await this.req(pn === 1 ? `index.do?uid=${uid}` : `myLand.do?uid=${uid}&flag=0&pn=${pn}`);
      lands.push(...FarmClient.parseLands(html));
      const t = strip(html);
      const pg = t.match(/(\d+)条,(\d+)\/(\d+)页/);
      if (!pg || +pg[2] >= +pg[3]) break;
    }
    return lands;
  }

  // 任务列表
  async getTasks() {
    const html = await this.req('taskOrders.do');
    return [...html.matchAll(/orderInfo\.do\?taskId=(\d+)[^>]*>\s*([^<]{1,40})/g)].map((m) => ({ taskId: +m[1], name: m[2].trim() }));
  }

  async getTaskInfo(taskId) {
    const html = await this.req(`orderInfo.do?taskId=${taskId}`);
    const t = strip(html);
    const orderIdM = html.match(/finishOrder\.do\?orderId=(\d+)/); // 库存够时才出现，即"可完成"的判据
    return {
      taskId,
      name: (t.match(/任务名称[:：]\s*(.+?)\s*等级要求/) || [])[1]?.trim() || null,
      need: (t.match(/上交需求[:：]\s*([^\s]+)/) || [])[1] || null,
      have: +(t.match(/仓库有此果实[:：]\s*(\d+)个/) || [])[1] || 0,
      seedsId: +(html.match(/seedsInfo\.do\?seedsId=(\d+)/) || [])[1] || null,
      canFinish: !!orderIdM,
      orderId: orderIdM ? +orderIdM[1] : null,
    };
  }

  // 完成任务，领取奖励(经验/金币/道具)；只有库存够时(getTaskInfo().canFinish)才应调用
  async finishTask(orderId) { return this._act(`finishOrder.do?orderId=${orderId}`); }

  // ===== 好友留言收件箱(/im/ 命名空间，跟农场/牧场/宠物/圣衣是独立的社交功能) =====
  // 列出一页留言的 id（新消息排在前，第1页=最新）
  async getMessagePage(page = 1) {
    const html = await this.req(`https://tx.com.cn/im/cs/commonReceiveManage.do?page=${page}`);
    return [...new Set([...html.matchAll(/commonReceiveDetail\.do\?id=(\d+)/g)].map((m) => +m[1]))];
  }
  // 读取单条留言详情：发件人昵称/uid + 正文
  // 时间戳有两种格式：近期是"[MM-DD HH:MM:SS]"，超过一年的老留言是"[YYYY-MM-DD HH:MM:SS]"，
  // 两种都要匹配，否则老留言会因为匹配不到而把后面的"删除 保存 转发"等页面文字也当成正文
  async getMessageDetail(id) {
    const html = await this.req(`https://tx.com.cn/im/cs/commonReceiveDetail.do?id=${id}`);
    const t = strip(html);
    const m = t.match(/阅读消息\s*来自[:：]\s*([^\(]+)\((\d+)\)\s*([\s\S]*?)\s*\[(?:\d{4}-)?\d\d-\d\d/);
    return { id, from: m ? m[1].trim() : null, uid: m ? m[2] : null, body: m ? m[3].trim() : '' };
  }
  // 删除单条留言(详情页"删除"链接，比列表页的批量接口简单——不需要凑 RIDS/checkbox 顺序)
  async deleteMessage(id) {
    return FarmClient.resultText(await this.req(`https://tx.com.cn/im/cs/commonReceiveRemove.do?id=${id}`));
  }

  // 商店种子列表
  static parseShopItems(html) {
    return [...html.matchAll(/([一-龥A-Za-z0-9]+)[:：](\d+)级[\s\S]{0,100}?单价[:：](\d+)金币[\s\S]{0,200}?seedsInfo\.do\?seedsId=(\d+)/g)]
      .map((m) => ({ name: m[1], level: +m[2], price: +m[3], seedsId: +m[4] }));
  }
  async getShop(category = 0, lv = 0, pn = 1) {
    const html = await this.req(`shop.do?category=${category}&lv=${lv}&pn=${pn}`);
    return FarmClient.parseShopItems(html);
  }
  // 官方"推荐种植"(myInfo.do 页面按账号等级给出的等级种子)：{seedsId, name, price, sellPrice, needLevel}
  async getRecommendedSeed() {
    const html = await this.req('myInfo.do');
    const seedsId = +((html.match(/推荐种植[:：]<a href="seedsInfo\.do\?seedsId=(\d+)"/) || [])[1] || 0);
    if (!seedsId) return null;
    const info = await this.req(`seedsInfo.do?seedsId=${seedsId}`);
    const t = strip(info);
    return {
      seedsId,
      name: (t.match(/种子详细介绍\s*([一-龥A-Za-z0-9]+)/) || [])[1] || `种子${seedsId}`,
      price: +(t.match(/种子价格[:：](\d+)金币/) || [])[1] || 0,
      sellPrice: +(t.match(/果实售价[:：](\d+)金币/) || [])[1] || 0,
      needLevel: +(t.match(/所需等级[:：](\d+)级/) || [])[1] || 0,
      gift: false,
    };
  }

  // 完整种子目录：档0-5(普通种子，按等级分档)全部翻页并行拉取 + 礼物种子(category=1)
  // 用于「种植种子」下拉可选全部种子(不局限于当前种子袋里已有的)
  async getSeedCatalog() {
    const seen = new Set();
    const catalog = [];
    const addAll = (items, extra) => { for (const it of items) if (!seen.has(it.seedsId)) { seen.add(it.seedsId); catalog.push({ ...it, ...extra }); } };
    const fetchTier = async (lv) => {
      const html1 = await this.req(`shop.do?category=0&lv=${lv}&pn=1`);
      const items = FarmClient.parseShopItems(html1);
      const pageNums = [...html1.matchAll(new RegExp(`shop\\.do\\?category=0&(?:amp;)?lv=${lv}&(?:amp;)?pn=(\\d+)`, 'g'))].map((m) => +m[1]);
      const maxPage = pageNums.length ? Math.max(1, ...pageNums) : 1;
      if (maxPage > 1) {
        const rest = await Promise.all(Array.from({ length: maxPage - 1 }, (_, i) => this.req(`shop.do?category=0&lv=${lv}&pn=${i + 2}`)));
        for (const html of rest) items.push(...FarmClient.parseShopItems(html));
      }
      return items;
    };
    const tiers = await Promise.all([0, 1, 2, 3, 4, 5].map(fetchTier));
    for (const items of tiers) addAll(items, { gift: false });
    const giftHtml = await this.req('shop.do?category=1&pn=1');
    addAll(FarmClient.parseShopItems(giftHtml), { gift: true }); // 礼物种子：不一定能直接买，标记出来
    return catalog.sort((a, b) => a.level - b.level || a.price - b.price);
  }

  // ============ 操作（返回结果文本） ============

  async _act(path) {
    const html = await this.req(path);
    return FarmClient.resultText(html);
  }

  async harvestAll() { await this.ensureZ(); return this._act(`harvestAll.do?z=${this.z}`); }
  async digAll() { await this.ensureZ(); return this._act(`digLands.do?z=${this.z}`); }
  async weedAll() { await this.ensureZ(); return this._act(`weedingAll.do?z=${this.z}`); }
  async killAll() { await this.ensureZ(); return this._act(`killInsectsAll.do?z=${this.z}`); }
  async waterAll() { await this.ensureZ(); return this._act(`waterAll.do?z=${this.z}`); }
  async muckAll() { await this.ensureZ(); return this._act(`muckAll.do?z=${this.z}`); }

  async harvest(landId) { return this._act(`harvest.do?landId=${landId}`); }
  async steal(landId, tuid) { return this._act(`steal.do?landId=${landId}&tuid=${tuid}`); }
  async waterLand(landId, tuid) { return this._act(`water.do?landId=${landId}&tuid=${tuid}`); }
  async weedLand(landId, tuid) { return this._act(`weeding.do?landId=${landId}${tuid ? `&tuid=${tuid}` : ''}`); }
  async killLand(landId, tuid) { return this._act(`killInsect.do?landId=${landId}${tuid ? `&tuid=${tuid}` : ''}`); }
  async harvestFriendLand(landId) { return this._act(`harvestFriendLand.do?landId=${landId}`); }

  // 我的友情地（种在好友农场上的地）任务解析：friendLand.do
  async getFriendLandTasks() {
    const html = await this.req('friendLand.do');
    const tasks = [];
    // 每块地对应一组操作链接；按 landId 归组
    const grab = (re) => [...html.matchAll(re)].map((m) => ({ landId: m[1], tuid: m[2] }));
    const harvest = new Set([...html.matchAll(/harvestFriendLand\.do\?landId=(\d+)/g)].map((m) => m[1]));
    const dig = new Set([...html.matchAll(/digFriendLand\.do\?landId=(\d+)/g)].map((m) => m[1]));
    const kill = new Set([...html.matchAll(/killFriendInsects\.do\?landId=(\d+)/g)].map((m) => m[1]));
    const weed = new Set([...html.matchAll(/weedingFriend\.do\?landId=(\d+)/g)].map((m) => m[1]));
    const water = new Map([...html.matchAll(/waterFriendLand\.do\?landId=(\d+)&(?:amp;)?tuid=(\d+)/g)].map((m) => [m[1], m[2]]));
    void grab;
    const ids = new Set([...harvest, ...dig, ...kill, ...weed, ...water.keys()]);
    for (const id of ids) tasks.push({ landId: id, canHarvest: harvest.has(id), needDig: dig.has(id), needKill: kill.has(id), needWeed: weed.has(id), needWater: water.has(id), tuid: water.get(id) || null });
    return tasks;
  }
  async killFriendInsects(landId) { return this._act(`killFriendInsects.do?landId=${landId}`); }
  async weedFriendLand(landId) { return this._act(`weedingFriend.do?landId=${landId}`); }
  async waterFriendLand(landId, tuid) { return this._act(`waterFriendLand.do?landId=${landId}${tuid ? `&tuid=${tuid}` : ''}`); }
  async digFriendLand(landId) { return this._act(`digFriendLand.do?landId=${landId}`); }

  // 一键种植（服务端限10秒/次）
  async sowAll(seedsId, num) {
    const wait = this.lastSow + 10500 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSow = Date.now();
    const html = await this.req(`sowSeedsAll.do?seedsId=${seedsId}`, { method: 'POST', body: `num=${num}` });
    return FarmClient.resultText(html);
  }

  // 单株播种（未开通一键种植的账号用）：landId=0 由服务端分配空地
  async sowSeed(seedsId, landId = 0) { return this._act(`sowSeeds.do?landId=${landId}&seedsId=${seedsId}`); }

  async buySeeds(seedsId, num) {
    await this.ensureZ();
    const html = await this.req(`buySeeds.do?seedsId=${seedsId}`, { method: 'POST', body: `num=${num}&z=${encodeURIComponent(this.z)}` });
    return FarmClient.resultText(html);
  }

  async sell(seedsId, num) {
    await this.ensureZ();
    const html = await this.req('sales.do', { method: 'POST', body: `num=${num}&seedsId=${seedsId}&z=${encodeURIComponent(this.z)}` });
    return FarmClient.resultText(html);
  }

  async sellAll() { return this._act('salesAll.do'); }
  async lock(seedsId, toLocked) { return this._act(`lock.do?seedsId=${seedsId}&lock=${toLocked ? 0 : 1}&pn=1`); }
  async lockAll(toLocked) { return this._act(`lockAll.do?lock=${toLocked ? 1 : 0}`); }
  // 使用道具：toolsId 1普通肥料/2强力肥料/7双倍经验卡/8特效杀虫剂/9特效除草剂；landId=0 时对通用；自家地 tuid=0
  async useTool(toolsId, landId = 0, tuid = 0) { return this._act(`useTools.do?landId=${landId}&toolsId=${toolsId}&tuid=${tuid}`); }
  async muckLand(landId, strong = false) { return this.useTool(strong ? 2 : 1, landId, 0); } // 单地施肥
  async giveTool(toolsId, friendId) { return this._act(`proxy.do?toolsId=${toolsId}&friendId=${friendId}`); } // 赠送道具
  async removeTool(toolsId) { return this._act(`toolsIntro.do?del=0&toolsId=${toolsId}`); } // 清除道具

  // 好友友情地种植
  async sowFriendSeeds(seedsId, landUid) { return this._act(`sowFriendSeeds.do?landId=0&seedsId=${seedsId}&landUid=${landUid}`); }

  // 道具/果实摆摊出售：type 1道具; goodsId=道具或果实id; price单价; pwd交易密码(无则空)
  async stallSell(goodsId, nums, price, type = 1, pwd = '') {
    const html = await this.req('salesGoods.do', { method: 'POST', body: `nums=${nums}&price=${price}&pwd=${encodeURIComponent(pwd)}&goodsId=${goodsId}&type=${type}&confirm=1` });
    return FarmClient.resultText(html);
  }

  // 土地升级/改良（消耗金币，谨慎）
  async changeSeason(landId, season) { return this._act(`changeSeason.do?season=${season}&landId=${landId}`); } // 1春/3秋/4夏
  async toSpecialLand(landId, sowSpecial) { return this._act(`toSpecialLand.do?sowSpecial=${sowSpecial}&landId=${landId}`); } // 1草园/2市花
  async mergeLand() { await this.ensureZ(); return this._act(`upLand.do?merge=1&z=${this.z}`); } // 3块空地合黑土地(需先探测确认)

  // 一键功能：地卡 & 开通
  async useExp2All() { await this.ensureZ(); return this._act(`exp2All.do?z=${this.z}`); } // 三倍经验地卡
  async useCoin2All() { await this.ensureZ(); return this._act(`coin2All.do?z=${this.z}`); } // 十倍金币地卡
  async openFun(actionId) { return this._act(`openFun.do?actionId=${actionId}`); } // 5浇水/6施肥/7锁定/8禁被施肥


  // 每轮读一次房间，只提交页面中实际出现的领取表单。
  async grabRoomCards(ar1 = 696, { shouldContinue = () => true } = {}) {
    const { parseGrabResult } = require('./grab-result');
    const summary = { found: 0, attempted: 0, claimed: 0, points: 0, full: false, limited: false, results: [] };
    if (!shouldContinue()) return summary;
    const html = await this.req(`https://tx.com.cn/room/rindex.do?op=2&ar1=${ar1}`);
    // 房间聊天内容不能作为本账号“已满”的证据，只读取明确的系统提示页。
    if (/<title[^>]*>[^<]*(?:温馨提示|操作提示|提示信息)[^<]*<\/title>/i.test(html)) {
      const notice = parseGrabResult(html);
      if (notice.full || notice.limited) return { ...summary, full: notice.full, limited: notice.limited, results: [notice.message] };
    }
    const forms = new Map();
    for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      const action = (m[1].match(/\baction\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
      if (!action) continue;
      const url = new URL(action.replace(/&amp;/g, '&'), 'https://tx.com.cn/room/');
      if (url.origin !== 'https://tx.com.cn' || url.pathname !== '/room/exchangeCard.do') continue;
      const body = new URLSearchParams();
      for (const input of m[2].matchAll(/<input\b[^>]*>/gi)) {
        const name = (input[0].match(/\bname\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
        const value = (input[0].match(/\bvalue\s*=\s*['"]([^'"]*)['"]/i) || [])[1];
        if (name && value !== undefined && !/\btype\s*=\s*['"](?:submit|button|checkbox|radio)['"]/i.test(input[0])) body.set(name, value.replace(/&amp;/g, '&'));
      }
      body.set('is', '1');
      forms.set(url.href + '\n' + body.toString(), { url: url.href, body: body.toString() });
    }
    summary.found = forms.size;
    for (const form of forms.values()) {
      if (!shouldContinue()) break;
      let result;
      try { result = parseGrabResult(await this.req(form.url, { method: 'POST', body: form.body })); }
      catch (e) { e.grabProgress = { ...summary, attempted: summary.attempted + 1 }; throw e; }
      summary.attempted++;
      summary.results.push(result.message);
      if (result.success) { summary.claimed++; summary.points += result.points; }
      if (result.full) { summary.full = true; break; }
      if (result.limited) { summary.limited = true; break; }
      if (result.roundComplete) break; // 本轮已经参与，下一次轮询继续找新一轮。
    }
    return summary;
  }

  // 签到：取验证码图 + regkey
  async getSignin() {
    const html = await this.req('verification.do');
    const regkey = (html.match(/name="regkey"\s+value="(\d+)"/) || [])[1];
    const img = (html.match(/<img[^>]+src="([^"]*(?:auth|code|img)[^"]*)"/i) || [])[1];
    return { regkey, img, html };
  }

  async signin(regkey, authnum) {
    const html = await this.req('/plugins/farm/cs/gift.do', { method: 'POST', body: `regkey=${regkey}&authnum=${authnum}` });
    return require('./daily-result').signinResultText(html);
  }
}

module.exports = { FarmClient, strip, sleep, USER_AGENT: UA };
