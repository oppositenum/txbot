// 账号 + 全局设置持久化 data/accounts.json
const fs = require('fs');
const path = require('path');
const { baseDir } = require('./paths');

const DATA_DIR = path.join(baseDir, 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

const DEFAULT_CONFIG = {
  enabled: false,        // 总开关：是否参与自动调度
  // ===== 农场智能循环 =====
  harvest: true,         // 收割成熟
  dig: true,             // 耕地
  sow: true,             // 补种
  sowSeedsId: 'auto',    // 'auto'=种袋数量最多 | 具体seedsId
  sowAutoBuy: true,      // 指定种子但库存不足时，自动去商店购买补足
  weed: true, kill: true, water: true, muck: false,
  friendLand: true,      // 收自己的友情地
  farmTasks: true,       // 自动完成日常任务(taskOrders.do)，库存够就领奖，默认开启
  steal: false, stealMax: 20,     // 0=不限(一次偷完所有可偷)
  careFriends: false, careMax: 0,  // 0=不限(把好友的草/虫/水全部处理完)
  sellAll: false,
  farmPollMaxMin: 5,     // 农场巡检间隔(分钟)：无提醒的任务(除草/偷菜/助友)靠轮询，默认5分钟查一次
  // ===== 多游戏每日（每天0点后一次）默认开启，新账号即自动签到/领取 =====
  pastureDaily: true,    // 牧场每日礼包+收获
  petDaily: true,        // 宠物每日津贴+报到+种花
  goldDaily: true,       // 圣衣每日奖励
  farmSignin: true,      // 农场每日签到(自动OCR验证码)
  groupSignin: true,     // 群组签到(自动OCR验证码)
  qqSignin: true,        // QQ签到
  // ===== 牧场循环 =====
  pastureLoop: false,    // 定时收获牧场
  pastureIntervalMin: 120,
  pastureFeed: true,          // 独立喂食循环：不管有没有开pastureLoop，饿了就喂，别让动物"停止成长"
  pastureFeedIntervalMin: 210, // 喂食间隔(分钟)，默认3.5小时(3-4小时区间)
  pioneer: false,        // 神殿拓荒：完成后奖励自动放入库房，独立循环——一轮结束立刻发起下一轮
  pioneerScene: 1,       // 1野猪林/2九寨沟/3西双版纳
  pioneerAction: 4,      // 1砍伐树木/2清除杂草/3铲除石块/4消灭野兽(默认，耗时最短)；实际耗时按账号读到的倒计时精确排期
  // ===== 宠物培养循环 =====
  petTrain: false,       // 定时培养
  petTrainWt: 3,         // 兼容旧字段：主属性 3智慧/2斗志/1气质/4体贴
  petTrainWts: [3],      // 轮换培养的属性列表(按优先级)；某个练不了自动换下一个
  // ===== 聊天室抢积分（到开始时间后持续轮询，明确抢满才结束当天）=====
  grabPoints: false,     // 抢字卡积分
  grabRoom: 696,         // 房间 ar1
  grabHour: 12,          // 每天开始抢的整点
  grabMin: 0,            // 分钟
  grabPollSec: 1,        // 每轮完成后的等待秒数，最低1秒；旧 grabWindowMin 不再限制总时长
  // ===== 圣衣打怪（只打指定等级以下的怪，账号圣衣等级需能进入该地图，公会地图会自动跳过）=====
  goldFight: false,
  goldFightMaxLevel: 29,   // 只打这个等级及以下的怪
  goldFightPollMaxMin: 5,  // 兜底轮询上限(分钟)，实际按怪物冷却剩余时间精确唤醒
  // ===== 好友留言骚扰监测（只监测+记日志，暂不自动删；判定命中会记到全局惯犯名单）=====
  msgWatch: false,
  msgWatchIntervalMin: 60,   // 巡检间隔(分钟)
  msgAutoDelete: false,      // 观察期关闭；确认判定准了再打开自动删除
};

const DEFAULT_SETTINGS = {
  maxConcurrent: 8,      // 全局同时执行的任务数上限（负载均衡；任务已细化并发）
  tickSec: 20,           // 调度扫描间隔(秒)
  dailyStartHour: 0,     // 每日任务最早开始小时
  dailyStartMin: 6,      // 每日任务开始分钟（避免0点整点，默认0点06分）
  dailySpreadMin: 120,   // 每日任务在开始后多少分钟内随机错峰
  dailyMaxConcurrent: 1, // 全局同时最多几个账号在跑"每日任务"(签到/每日领取)；
                         // 独立于 maxConcurrent，故意设更小——签到类操作是风控重点盯防的
                         // 行为模式，多账号同时刷容易被识别成"批量刷"，串行更安全
  stealWhitelist: [],    // 全局偷菜白名单 uid（遇到这些用户不偷）
  proxies: [],           // 已保存的代理列表 [{label, url}]，供"代理管理"批量勾选账号分配用
  msgOffenders: [],      // 留言骚扰惯犯 uid 名单(全局共享，跨账号)：命中过一次的人，以后发的消息不用再逐条判定内容
};

const ACCOUNT_EXPORT_FORMAT = 'txbot-account-export';
const ACCOUNT_EXPORT_VERSION = 1;
const MAX_IMPORT_ACCOUNTS = 1000;
const RETIRED_TRANSFER_CONFIG_KEYS = new Set(['grabWindowMin']);

const freshStatus = () => ({ state: 'idle', lastRun: null, lastResult: null, level: null, coin: null, needLogin: false, lastDaily: null, jobs: {} });
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const cookieValue = (cookie, name) => (String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, 'i')) || [])[1] || null;
const accountIdentities = (account) => {
  const identities = [];
  if (account.useruid) identities.push(`uid:${String(account.useruid).trim().toLocaleLowerCase()}`);
  const txuid = cookieValue(account.cookie, 'txuid');
  if (txuid) identities.push(`txuid:${txuid}`);
  const session = cookieValue(account.cookie, 'JSESSIONID');
  if (session) identities.push(`session:${session}`);
  return identities;
};

function importError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ACCOUNT_EXPORT';
  return error;
}

function transferString(value, label, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw importError(`${label}格式错误`);
  if (value.length > max) throw importError(`${label}超过长度限制`);
  return value;
}

function normalizeTransferConfig(raw, index) {
  if (raw == null) return {};
  if (!plainObject(raw)) throw importError(`第${index + 1}个账号的任务配置格式错误`);
  const config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RETIRED_TRANSFER_CONFIG_KEYS.has(key)) continue;
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw importError(`第${index + 1}个账号包含未知配置项: ${key}`);
    const scalar = value == null || ['string', 'number', 'boolean'].includes(typeof value);
    const list = Array.isArray(value) && value.length <= 100 && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item));
    if ((!scalar && !list) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw importError(`第${index + 1}个账号的配置项 ${key} 格式错误`);
    }
    config[key] = value;
  }
  return config;
}

function normalizeAccountExport(payload) {
  if (!plainObject(payload) || payload.format !== ACCOUNT_EXPORT_FORMAT || payload.version !== ACCOUNT_EXPORT_VERSION) {
    throw importError('不是受支持的 txbot 账号导出文件');
  }
  if (!Array.isArray(payload.accounts) || !payload.accounts.length) throw importError('导出文件中没有账号');
  if (payload.accounts.length > MAX_IMPORT_ACCOUNTS) throw importError(`单次最多导入${MAX_IMPORT_ACCOUNTS}个账号`);
  const identities = new Set();
  return payload.accounts.map((raw, index) => {
    if (!plainObject(raw)) throw importError(`第${index + 1}个账号格式错误`);
    const useruid = transferString(raw.useruid, `第${index + 1}个账号`, 200);
    const password = transferString(raw.password, `第${index + 1}个账号密码`, 4096);
    const cookie = transferString(raw.cookie, `第${index + 1}个账号Cookie`, 131072);
    if (!(useruid && password) && !(cookie && /(?:^|;\s*)JSESSIONID=/i.test(cookie))) {
      throw importError(`第${index + 1}个账号缺少有效的账号密码或Cookie`);
    }
    const account = {
      name: transferString(raw.name, `第${index + 1}个账号备注`, 200) || useruid || `导入账号${index + 1}`,
      cookie, useruid, password,
      proxy: transferString(raw.proxy, `第${index + 1}个账号代理`, 2048),
      config: normalizeTransferConfig(raw.config, index),
    };
    const keys = accountIdentities(account);
    if (!keys.length || keys.some((key) => identities.has(key))) throw importError(`第${index + 1}个账号与文件内其他账号重复`);
    keys.forEach((key) => identities.add(key));
    return account;
  });
}

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    db.accounts = db.accounts || [];
    return db;
  } catch {
    return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 保存前滚动备份现有文件（防误覆盖导致账号丢失）
  try {
    if (fs.existsSync(FILE)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(FILE, path.join(BACKUP_DIR, `accounts-${stamp}.json`));
      // 只保留最近 30 份
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('accounts-')).sort();
      for (const f of files.slice(0, -30)) fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch { /* 备份失败不影响主流程 */ }
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

let db = load();

// 老账号补全新增的 DEFAULT_CONFIG 字段（代码迭代加了新配置项时，已有账号不会自动带上，这里统一补齐一次）
(function backfillDefaults() {
  let changed = false;
  for (const acc of db.accounts) {
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      if (!(k in acc.config)) { acc.config[k] = v; changed = true; }
    }
  }
  if (changed) save(db);
})();

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  list: () => db.accounts,
  get: (id) => db.accounts.find((a) => a.id === id),
  getSettings: () => db.settings,
  setSettings(patch) { Object.assign(db.settings, patch); save(db); return db.settings; },
  // 新账号默认模板（全局），叠加在 DEFAULT_CONFIG 之上
  getDefaultConfig: () => db.settings.defaultConfig || null,
  setDefaultConfig(cfg) { db.settings.defaultConfig = { ...(cfg || {}) }; delete db.settings.defaultConfig.enabled; save(db); return db.settings.defaultConfig; },
  applyConfigToAll(cfg) {
    const patch = { ...(cfg || {}) }; delete patch.enabled; // 不改各号的启用开关
    db.accounts.forEach((a) => Object.assign(a.config, patch));
    save(db);
    return db.accounts.length;
  },
  // 把某个代理批量分配给勾选的账号（url 传空字符串='' 表示清除代理，改回直连）
  applyProxyToAccounts(url, ids) {
    const set = new Set(ids || []);
    let n = 0;
    for (const a of db.accounts) {
      if (set.has(a.id)) { a.proxy = url || null; n++; }
    }
    save(db);
    return n;
  },
  exportAccounts() {
    return {
      format: ACCOUNT_EXPORT_FORMAT,
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sensitive: true,
      accounts: db.accounts.map((a) => ({
        sourceId: a.id,
        name: a.name,
        cookie: a.cookie || null,
        useruid: a.useruid || null,
        password: a.password || null,
        proxy: a.proxy || null,
        config: Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, fallback]) => [key, Object.hasOwn(a.config, key) ? a.config[key] : fallback])),
      })),
    };
  },
  importAccounts(payload, { overwrite = false, resumeEnabled = false } = {}) {
    const incoming = normalizeAccountExport(payload);
    const byIdentity = new Map();
    db.accounts.forEach((account) => accountIdentities(account).forEach((key) => {
      if (!byIdentity.has(key)) byIdentity.set(key, new Set());
      byIdentity.get(key).add(account);
    }));
    const matchedTargets = new Set();
    const plans = incoming.map((item, index) => {
      const identities = accountIdentities(item);
      const matches = new Set(identities.flatMap((key) => [...(byIdentity.get(key) || [])]));
      if (matches.size > 1) throw importError(`第${index + 1}个账号匹配到目标服务器中的多个账号`);
      const current = matches.values().next().value || null;
      if (current && matchedTargets.has(current.id)) throw importError(`第${index + 1}个账号与文件内其他账号匹配到同一目标账号`);
      if (current) matchedTargets.add(current.id);
      return { item, current };
    });
    const result = { total: incoming.length, added: 0, updated: 0, skipped: 0, affected: [] };
    for (const { item, current } of plans) {
      const config = { ...DEFAULT_CONFIG, ...item.config, enabled: resumeEnabled && item.config.enabled === true };
      if (current && !overwrite) { result.skipped++; continue; }
      if (current) {
        Object.assign(current, { name: item.name, cookie: item.cookie, useruid: item.useruid, password: item.password, proxy: item.proxy, config });
        current.status = { ...(current.status || freshStatus()), state: 'idle', needLogin: false, jobs: {} };
        result.updated++;
        result.affected.push({ id: current.id, enabled: config.enabled, action: 'updated' });
        continue;
      }
      const id = 'a' + (Math.max(0, ...db.accounts.map((a) => +a.id.slice(1) || 0)) + 1);
      const account = { id, name: item.name, cookie: item.cookie, useruid: item.useruid, password: item.password, proxy: item.proxy, config, status: freshStatus() };
      db.accounts.push(account);
      result.added++;
      result.affected.push({ id, enabled: config.enabled, action: 'added' });
    }
    if (result.added || result.updated) save(db);
    return result;
  },
  add({ name, cookie, useruid, password, proxy, config }) {
    const id = 'a' + (Math.max(0, ...db.accounts.map((a) => +a.id.slice(1))) + 1);
    const acc = {
      id,
      name: name || useruid || id,
      cookie: cookie || null,
      useruid: useruid || null,
      password: password || null,
      proxy: proxy || null,        // 每账号独立代理 http://[user:pass@]host:port
      config: { ...DEFAULT_CONFIG, ...(db.settings.defaultConfig || {}), ...(config || {}) },
      status: freshStatus(),
    };
    db.accounts.push(acc);
    save(db);
    return acc;
  },
  update(id, patch) {
    const acc = this.get(id);
    if (!acc) return null;
    if (patch.name !== undefined) acc.name = patch.name;
    if (patch.cookie !== undefined) { acc.cookie = patch.cookie; acc.status.needLogin = false; }
    if (patch.useruid !== undefined) acc.useruid = patch.useruid;
    if (patch.password !== undefined) acc.password = patch.password;
    if (patch.proxy !== undefined) acc.proxy = patch.proxy || null;
    if (patch.config) Object.assign(acc.config, patch.config);
    save(db);
    return acc;
  },
  setStatus(id, patch, { persist = true } = {}) {
    const acc = this.get(id);
    if (!acc) return;
    Object.assign(acc.status, patch);
    if (persist) save(db);
  },
  remove(id) {
    db.accounts = db.accounts.filter((a) => a.id !== id);
    save(db);
  },
};
