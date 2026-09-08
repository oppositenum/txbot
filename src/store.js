// 账号 + 全局设置持久化 data/accounts.json
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
  pioneer: false,        // 神殿拓荒（定时发起）
  pioneerScene: 1,       // 1野猪林/2九寨沟/3西双版纳
  pioneerAction: 1,      // 1木材/2干草/3石块/4兽骨
  // ===== 宠物培养循环 =====
  petTrain: false,       // 定时培养
  petTrainWt: 3,         // 兼容旧字段：主属性 3智慧/2斗志/1气质/4体贴
  petTrainWts: [3],      // 轮换培养的属性列表(按优先级)；某个练不了自动换下一个
  // ===== 聊天室抢积分（每天一次突发轮询）=====
  grabPoints: false,     // 抢字卡积分
  grabRoom: 696,         // 房间 ar1
  grabHour: 12,          // 每天开始抢的整点
  grabMin: 0,            // 分钟
  grabWindowMin: 10,     // 突发轮询持续分钟
  grabPollSec: 3,        // 轮询间隔秒(抢卡要频繁，越小越不易错过)
  // ===== 圣衣打怪（只打指定等级以下的怪，账号圣衣等级需能进入该地图，公会地图会自动跳过）=====
  goldFight: false,
  goldFightMaxLevel: 29,   // 只打这个等级及以下的怪
  goldFightPollMaxMin: 5,  // 兜底轮询上限(分钟)，实际按怪物冷却剩余时间精确唤醒
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
};

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
      status: { state: 'idle', lastRun: null, lastResult: null, level: null, coin: null, needLogin: false, lastDaily: null, jobs: {} },
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
  setStatus(id, patch) {
    const acc = this.get(id);
    if (!acc) return;
    Object.assign(acc.status, patch);
    save(db);
  },
  remove(id) {
    db.accounts = db.accounts.filter((a) => a.id !== id);
    save(db);
  },
};
