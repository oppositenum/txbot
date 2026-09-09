// 事件驱动多任务调度器 + 全局并发负载均衡 + 每账号代理
// 每账号有多个 job（farm / daily / pasture），各自 nextRun；
// 全局 tick 扫描到期 job，受 maxConcurrent 限流地投入执行。
const { FarmClient, sleep } = require('./client');
const { PastureClient, PetClient, GoldClient } = require('./plugins');
const { farmSignin, groupSignin, qqSignin } = require('./signin');
const msgFilter = require('./msgFilter');
const store = require('./store');

// 本地时区的"今天"日期字符串。注意：不能用 toISOString()，那是 UTC——
// 服务器在 GMT+8 时区时，本地时间00:00~07:59这段窗口 UTC 还没跨天，
// 用 toISOString() 会把"今天"误判成"昨天"，导致每日任务在本地新的一天
// 头8小时里被误认为"已经做过"而跳过，实际要等到本地早上8点(UTC跨天)才补做。
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const jitter = (ms, pct = 0.15) => ms + ms * pct * (Math.random() * 2 - 1);

const logs = {};       // id -> [{ts,msg}]
const clients = {};    // id -> FarmClient（含 proxy）
const running = new Set(); // 正在执行 job 的账号
let activeCount = 0;   // 全局并发计数
let tickTimer = null;

function log(id, msg) {
  (logs[id] = logs[id] || []).push({ ts: Date.now(), msg: String(msg).slice(0, 300) });
  if (logs[id].length > 500) logs[id] = logs[id].slice(-400);
  console.log(`[${id}] ${msg}`);
}

// ---- 客户端（应用/更新代理）----
function getClient(acc) {
  const cur = clients[acc.id];
  if (!cur || cur.proxy !== (acc.proxy || null)) {
    clients[acc.id] = new FarmClient(acc.cookie, { proxy: acc.proxy });
  }
  return clients[acc.id];
}
function resetClient(id) { delete clients[id]; }

async function relogin(id) {
  const acc = store.get(id);
  if (!acc || !acc.useruid || !acc.password) return false;
  log(id, '尝试用账号密码重新登录…');
  const c = new FarmClient(null, { proxy: acc.proxy });
  const cookie = await c.login(acc.useruid, acc.password);
  clients[id] = c;
  store.update(id, { cookie });
  store.setStatus(id, { needLogin: false });
  log(id, '✅ 自动登录成功，Cookie 已更新');
  return true;
}

// ==================== 各 job 是否启用 ====================
function jobEnabled(acc, type) {
  const cfg = acc.config;
  if (!cfg.enabled) return false;
  if (type === 'farm') return true; // 农场核心(收/耕/种/自家护理)
  if (type === 'friendland') return !!cfg.friendLand;
  if (type === 'steal') return !!cfg.steal;
  if (type === 'care') return !!cfg.careFriends;
  if (type === 'farmtask') return !!cfg.farmTasks;
  if (type === 'daily') return !!(cfg.pastureDaily || cfg.petDaily || cfg.goldDaily || cfg.farmSignin || cfg.groupSignin || cfg.qqSignin);
  if (type === 'pasture') return !!cfg.pastureLoop;
  if (type === 'pasturefeed') return !!cfg.pastureFeed;
  if (type === 'pioneer') return !!cfg.pioneer;
  if (type === 'pettrain') return !!cfg.petTrain;
  if (type === 'grab') return !!cfg.grabPoints;
  if (type === 'goldfight') return !!cfg.goldFight;
  if (type === 'msgwatch') return !!cfg.msgWatch;
  return false;
}

// ==================== 计算下次执行时间 ====================
// acc 可选：用于判断今天是否已做过(lastDaily)，没做过则尽快补做而非等明天
function computeDailyNext(acc) {
  const s = store.getSettings();
  const spread = () => Math.random() * (s.dailySpreadMin || 120) * 60000;
  const now = new Date();
  const start = new Date(now); start.setHours(s.dailyStartHour || 0, s.dailyStartMin || 0, 0, 0);
  if (now < start) return start.getTime() + spread();                 // 今天还没到起始点 → 今天起点
  if (!acc || acc.status.lastDaily !== todayStr()) return Date.now() + Math.random() * 300000; // 今天没做过 → 5分钟内补做
  return start.getTime() + 86400000 + spread();                       // 今天已做 → 明天
}

function setJob(id, type, nextRun) {
  const acc = store.get(id);
  if (!acc) return;
  const jobs = acc.status.jobs || {};
  jobs[type] = nextRun;
  store.setStatus(id, { jobs });
}

// ==================== farm job ====================
async function runFarmJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const did = [];
  const farm = await c.getFarm();
  store.setStatus(id, { level: farm.level, coin: farm.coin, needLogin: false });
  log(id, `农场 Lv${farm.level} 金币${farm.coin} 地${farm.lands.length} 可收${farm.lands.filter((l) => l.canHarvest).length}`);

  if (cfg.harvest && farm.lands.some((l) => l.canHarvest)) { const r = await c.harvestAll(); did.push('收割'); log(id, `收: ${r}`); }
  const careOps = [['weed', '除草', () => c.weedAll()], ['kill', '杀虫', () => c.killAll()], ['water', '浇水', () => c.waterAll()], ['muck', '施肥', () => c.muckAll()]];
  let needPerLand = false;
  for (const [key, label, fn] of careOps) {
    if (!cfg[key]) continue;
    const r = await fn();
    if (/未开通|需要等级/.test(r)) { needPerLand = true; continue; }
    if (!/没有|不需要|清理完|都杀完|不用/.test(r)) { did.push(label); log(id, `${label}: ${r}`); }
  }
  if (needPerLand) {
    const f = await c.getFarm(); let n = 0;
    for (const l of f.lands) {
      const links = [cfg.weed && l.needWeed, cfg.kill && l.needKill, cfg.water && l.needWater].filter(Boolean);
      for (const link of links) { await c.req(link.replace(/&amp;/g, '&')).then(FarmClient.resultText); n++; }
    }
    if (n) { did.push(`逐块护理x${n}`); log(id, `逐块护理 ${n} 次`); }
  }
  if (cfg.dig) { const r = await c.digAll(); if (/成功耕地/.test(r)) { did.push('耕地'); log(id, `耕: ${r}`); } }
  if (cfg.sow) {
    const f2 = await c.getFarm();
    const emptyLands = f2.lands.filter((l) => l.empty);
    if (emptyLands.length) {
      let bag = await c.getBag();
      let seed = null;
      if (cfg.sowSeedsId === 'auto') {
        seed = bag.sort((a, b) => b.count - a.count)[0];
      } else {
        // 'recommend'=按 myInfo.do 官方"推荐种植"(随账号等级变化)；否则是配置里指定的具体 seedsId
        let targetId = null, targetName = null;
        if (cfg.sowSeedsId === 'recommend') {
          const rec = await c.getRecommendedSeed().catch(() => null);
          if (rec) { targetId = rec.seedsId; targetName = rec.name; log(id, `官方推荐种植: ${rec.name}(id${rec.seedsId})`); }
          else log(id, '未获取到官方推荐种子(等级不够等原因)，改为随便种仓库现有种子');
        } else {
          targetId = +cfg.sowSeedsId;
        }
        if (targetId) {
          seed = bag.find((s) => s.seedsId === targetId);
          // 库存不足 → 自动去商店补货
          if (cfg.sowAutoBuy !== false) {
            const have = seed ? seed.count : 0;
            const need = emptyLands.length - have;
            if (need > 0) {
              const catalog = await c.getSeedCatalog();
              const item = catalog.find((x) => x.seedsId === targetId) || (targetName ? { seedsId: targetId, name: targetName, gift: false } : null);
              if (!item) log(id, `种子(id=${targetId})不在商店目录，无法自动购买`);
              else if (item.gift) log(id, `种子[${item.name}]是礼物种子，商店无法直接购买`);
              else {
                const r = await c.buySeeds(item.seedsId, need);
                if (/成功购买/.test(r)) { log(id, `补货[${item.name}]x${need}成功`); bag = await c.getBag(); seed = bag.find((s) => s.seedsId === targetId); }
                else log(id, `补货[${item.name}]失败: ${r.slice(0, 50)}`);
              }
            }
          }
        }
        // recommend 模式查不到官方推荐(等级不够等)时，退化成 auto：随便种仓库里数量最多的现有种子，
        // 别让地空着——总比"无可用种子"啥也不做强
        if (cfg.sowSeedsId === 'recommend' && !targetId) seed = bag.sort((a, b) => b.count - a.count)[0];
      }
      if (seed && seed.count > 0) {
        const want = Math.min(emptyLands.length, seed.count);
        let r = await c.sowAll(seed.seedsId, want);
        if (/未开通|需要等级|没有开通|一键种植功能/.test(r)) {
          // 未开通一键种植 → 单株逐块播种
          let n = 0;
          for (let k = 0; k < want; k++) { const rr = await c.sowSeed(seed.seedsId, 0); if (/成功|种植了|播种/.test(rr)) n++; else break; }
          r = `单株种植x${n}`;
        }
        did.push('种植'); log(id, `种[${seed.name}]x${want}: ${r}`);
      } else log(id, '无可用种子');
    }
  }
  if (cfg.sellAll) { const r = await c.sellAll(); did.push('出售'); log(id, `全售: ${r}`); }

  // 计算下次唤醒：最近成熟时间，封顶 farmPollMaxMin（捕捉被偷/被加速）
  const finalFarm = await c.getFarm();
  const cap = (cfg.farmPollMaxMin || 30) * 60000;
  const nextMin = FarmClient.nextFarmActionMinutes(finalFarm.lands);
  let delay = nextMin == null ? cap : Math.min(nextMin * 60000, cap);
  if (delay < 60000) delay = 60000; // 至少1分钟
  const next = Date.now() + jitter(delay);
  setJob(id, 'farm', next);
  // 缓存农场倒计时概览（供卡片展示，不额外请求）
  store.setStatus(id, {
    lastRun: Date.now(), lastResult: did.length ? did.join('/') : '无事可做',
    farmInfo: { harvestable: finalFarm.lands.filter((l) => l.canHarvest).length, total: finalFarm.lands.length, nextMatureAt: nextMin != null && nextMin > 0 ? Date.now() + nextMin * 60000 : (nextMin === 0 ? Date.now() : null) },
  });
  log(id, `农场完成: ${did.length ? did.join('/') : '无事可做'}；下次 ${new Date(next).toLocaleTimeString()}${nextMin != null ? `（作物约${nextMin}分钟后熟）` : ''}`);
}

const pollNext = (cfg) => Date.now() + jitter(Math.max(1, cfg.farmPollMaxMin || 5) * 60000);

// ==================== goldfight job（圣衣打怪，只打配置等级以下，独立并发）====================
async function runGoldFightJob(id) {
  const acc = store.get(id); const cfg = acc.config;
  const g = new GoldClient(acc.cookie, { proxy: acc.proxy });
  const maxLv = cfg.goldFightMaxLevel || 29;
  const cap = Math.max(1, cfg.goldFightPollMaxMin || 5) * 60;
  let bosses;
  try { bosses = await g.getFightStatus(maxLv); }
  catch (e) {
    log(id, `圣衣打怪巡检出错: ${e.message}，${Math.round(cap / 60)}分钟后重试`);
    setJob(id, 'goldfight', Date.now() + jitter(cap * 1000));
    return;
  }
  let killed = 0;
  for (const b of bosses.filter((x) => x.available)) {
    const r = await g.fightBoss(b.mapId, b.bossId);
    if (r.ok) { killed++; log(id, `圣衣打怪[${b.areaName}]${b.name}(Lv${b.level}): 胜利`); }
    else log(id, `圣衣打怪[${b.areaName}]${b.name}(Lv${b.level})未打成: ${r.reason}`);
    await sleep(600 + Math.random() * 600);
  }
  // 按最近的怪物冷却剩余时间精确唤醒，封顶 goldFightPollMaxMin
  const cooling = bosses.filter((b) => !b.available && b.respawnSec != null).map((b) => b.respawnSec);
  const waitSec = cooling.length ? Math.min(cap, Math.max(20, Math.min(...cooling) + 3)) : cap;
  const next = Date.now() + jitter(waitSec * 1000, 0.1);
  setJob(id, 'goldfight', next);
  // 每次巡检都留痕（哪怕没打到），否则用户看不到任务在运行的证据
  const nextStr = new Date(next).toLocaleTimeString();
  if (killed) log(id, `圣衣打怪完成，击杀${killed}只(候选${bosses.length}只)；下次 ${nextStr}`);
  else log(id, `圣衣打怪巡检: ${bosses.length}只候选怪均在冷却，最近${cooling.length ? Math.ceil(Math.min(...cooling) / 60) + '分钟' : '未知'}后刷新；下次 ${nextStr}`);
}

// ==================== friendland job（我的友情地，独立并发）====================
async function runFriendLandJob(id) {
  const acc = store.get(id); const cfg = acc.config;
  const c = new FarmClient(acc.cookie, { proxy: acc.proxy });
  const tasks = await c.getFriendLandTasks();
  let fn = 0;
  for (const t of tasks) {
    if (t.canHarvest) { await c.harvestFriendLand(t.landId); fn++; }
    if (cfg.kill && t.needKill) { await c.killFriendInsects(t.landId); fn++; }
    if (cfg.weed && t.needWeed) { await c.weedFriendLand(t.landId); fn++; }
    if (cfg.water && t.needWater) { await c.waterFriendLand(t.landId, t.tuid); fn++; }
    if (cfg.dig && t.needDig) { await c.digFriendLand(t.landId); fn++; }
  }
  log(id, fn ? `友情地护理 ${fn} 次` : `友情地巡检: ${tasks.length}块地均无需处理`);
  setJob(id, 'friendland', pollNext(cfg));
}

// ==================== farmtask job（日常任务，库存够就自动完成，独立并发）====================
async function runFarmTaskJob(id) {
  const c = new FarmClient(store.get(id).cookie, { proxy: store.get(id).proxy });
  const tasks = await c.getTasks();
  const details = await Promise.all(tasks.map((t) => c.getTaskInfo(t.taskId).then((info) => ({ ...t, ...info })).catch(() => null)));
  let done = 0; const rewards = [];
  for (const t of details.filter(Boolean)) {
    if (!t.canFinish) continue;
    const r = await c.finishTask(t.orderId);
    done++;
    const m = r.match(/奖励你([^>]{0,40})/);
    rewards.push(`${t.name}:${m ? m[1].trim() : '完成'}`);
    await sleep(800 + Math.random() * 800);
  }
  const pending = details.filter(Boolean).filter((t) => !t.canFinish);
  if (done) {
    log(id, `完成${done}个日常任务: ${rewards.join(' / ')}`);
  } else if (pending.length) {
    // 列出每个任务缺什么、缺多少，方便直接去买/去种对应作物补齐库存
    const detail = pending.map((t) => `${t.name || t.taskId}(需${t.need || '?'}，现有${t.have})`).join('；');
    log(id, `任务巡检: ${pending.length}个待办均库存不足 — ${detail}`);
  } else {
    log(id, '任务巡检: 无待办任务');
  }
  setJob(id, 'farmtask', pollNext(store.get(id).config));
}

// ==================== steal job（偷菜，独立并发，遍历翻页+白名单）====================
async function runStealJob(id) {
  const acc = store.get(id); const cfg = acc.config;
  const c = new FarmClient(acc.cookie, { proxy: acc.proxy });
  const wl = new Set((store.getSettings().stealWhitelist || []).map(String));
  const cap = cfg.stealMax > 0 ? cfg.stealMax : Infinity;
  let stolen = 0, skipped = 0;
  for (const f of await c.getRankAll(0, 15)) {
    if (stolen >= cap) break;
    if (wl.has(String(f.uid))) { skipped++; continue; }
    for (const l of (await c.getFriendFarm(f.uid, 3)).filter((x) => x.canSteal)) {
      if (stolen >= cap) break;
      const m = l.canSteal.replace(/&amp;/g, '&').match(/landId=(\d+)&tuid=(\d+)/);
      if (!m) continue;
      await c.steal(m[1], m[2]); stolen++;
      await sleep(1500 + Math.random() * 2000);
    }
  }
  log(id, stolen ? `偷菜 ${stolen} 块${skipped ? ` (白名单跳过${skipped}人)` : ''}` : `偷菜巡检: 无可偷的地${skipped ? `(白名单跳过${skipped}人)` : ''}`);
  setJob(id, 'steal', pollNext(cfg));
}

// ==================== care job（帮好友浇水/除草/杀虫，三路并发）====================
async function runCareJob(id) {
  const acc = store.get(id); const cfg = acc.config;
  const cap = cfg.careMax > 0 ? cfg.careMax : Infinity;
  const fix = (s) => s.replace(/&amp;/g, '&');
  const WEED_DONE = /除光|没有.*杂草|清理完|不需要除草|没有杂草/;
  const KILL_DONE = /杀光|没有.*害虫|都健康|不需要杀虫|没有害虫/;

  // 除草/杀虫：同一地块反复调用同一链接直到"除光/杀光"文案出现
  const runRepeatPass = async (oper, needKey, doneRe) => {
    const pc = new FarmClient(acc.cookie, { proxy: acc.proxy });
    let n = 0;
    for (const f of await pc.getRankAll(oper, 15)) {
      if (n >= cap) break;
      for (const l of await pc.getFriendFarm(f.uid, 3)) {
        if (n >= cap) break;
        const link = l[needKey];
        if (!link) continue;
        for (let i = 0; i < 80 && n < cap; i++) {
          const r = await pc.req(fix(link)).then(FarmClient.resultText);
          n++;
          if (doneRe.test(r) || /失败|不能|已被/.test(r)) break;
          await sleep(1200 + Math.random() * 1200);
        }
      }
    }
    return n;
  };

  // 浇水：响应自带">>给下一块地浇水"直达链接(带下一个landId)，顺着链走完该好友全部待浇地块，
  // 不用像除草/杀虫那样逐块重查好友地块列表(且好友地块可能远超翻页上限，链式跟随天然不受限)
  const runWaterPass = async (oper) => {
    const pc = new FarmClient(acc.cookie, { proxy: acc.proxy });
    let n = 0;
    for (const f of await pc.getRankAll(oper, 15)) {
      if (n >= cap) break;
      const firstLand = (await pc.getFriendFarm(f.uid, 3)).find((l) => l.needWater); // 翻页找入口(有的好友地块很多，第一页未必有)
      if (!firstLand) continue;
      let link = fix(firstLand.needWater);
      for (let i = 0; i < 100 && link && n < cap; i++) {
        const html = await pc.req(link);
        n++;
        const next = html.match(/water\.do\?landId=\d+&(?:amp;)?tuid=\d+/);
        link = next ? fix(next[0]) : null;
        if (link) await sleep(700 + Math.random() * 700);
      }
    }
    return n;
  };

  const tasks = [];
  if (cfg.water) tasks.push(runWaterPass(3).then((n) => ['浇水', n]));
  if (cfg.weed) tasks.push(runRepeatPass(1, 'needWeed', WEED_DONE).then((n) => ['除草', n]));
  if (cfg.kill) tasks.push(runRepeatPass(2, 'needKill', KILL_DONE).then((n) => ['杀虫', n]));
  const done = (await Promise.allSettled(tasks)).filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const total = done.reduce((s, [, n]) => s + n, 0);
  log(id, total ? '帮好友(并发): ' + done.map(([l, n]) => l + n).join(' ') : '帮好友巡检: 暂无好友需要护理');
  setJob(id, 'care', pollNext(cfg));
}

// ==================== daily job（每日签到/领取，并行处理，按任务去重）====================
async function runDailyJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const today = todayStr();
  const proxy = acc.proxy;
  const done = { ...(acc.status.dailyDone || {}) };
  // 各每日任务：每个用独立客户端(同一cookie)，便于并行
  const nc = () => new FarmClient(acc.cookie, { proxy });
  const defs = [];
  if (cfg.farmSignin) defs.push(['farmSignin', '农场签到', () => farmSignin(nc())]);
  if (cfg.groupSignin) defs.push(['groupSignin', '群组签到', () => groupSignin(nc())]);
  if (cfg.qqSignin) defs.push(['qqSignin', 'QQ签到', () => qqSignin(nc())]);
  if (cfg.pastureDaily) defs.push(['pastureDaily', '牧场每日', async () => {
    const p = new PastureClient(acc.cookie, { proxy });
    const s = await p.dailyAward(); const info = await p.getInfo();
    if (info.dogHungry) await p.feedDog();
    for (const h of info.harvestable) await p.harvest(h);
    const rs = await p.restockAll();
    return `${s} 收${info.harvestable.length}补${rs.n}`;
  }]);
  if (cfg.petDaily) defs.push(['petDaily', '宠物每日', async () => {
    const pet = new PetClient(acc.cookie, { proxy });
    const a = await pet.dailyAllowance();
    await pet.attendance().catch(() => {}); await pet.harvestWork().catch(() => {});
    return a.slice(0, 30);
  }]);
  if (cfg.goldDaily) defs.push(['goldDaily', '圣衣每日', () => new GoldClient(acc.cookie, { proxy }).dailyReward()]);

  // 只处理今天还没做的
  const todo = defs.filter(([k]) => done[k] !== today);
  if (!todo.length) { setJob(id, 'daily', computeDailyNext(acc)); return; }

  // 串行执行（不并行）：签到/每日领取是风控重点盯防的行为模式，同一账号短时间内
  // 并发打出好几个"领取"类请求不像真人操作，任务间加随机间隔更安全
  let loginFail = 0;
  for (let i = 0; i < todo.length; i++) {
    const [k, label, fn] = todo[i];
    try {
      const text = String(await fn());
      // 请求本身没报错不代表业务上成功——风控拒绝("系统检测多号刷签到")、
      // 验证码识别错误等都是这类情况，不能标记为"今天已完成"，否则以后再也不会重试
      const rejected = /失败|系统检测|验证码错误|请稍后再试|操作过于频繁/.test(text);
      if (rejected) log(id, `${label}(未成功，30分钟后重试): ${text.slice(0, 50)}`);
      else { done[k] = today; log(id, `${label}: ${text.slice(0, 40)}`); }
    } catch (e) {
      if (e.code === 'NOT_LOGGED_IN') loginFail++;
      log(id, `${label}失败: ${e.message || e}`);
    }
    if (i < todo.length - 1) await sleep(2000 + Math.random() * 3000); // 任务间隔2-5秒，模拟真人逐个操作
  }
  store.setStatus(id, { dailyDone: done });

  const allDone = defs.every(([k]) => done[k] === today);
  if (allDone) store.setStatus(id, { lastDaily: today });
  // Cookie 失效且全失败 → 抛出让 runJob 重登重试
  if (loginFail === todo.length && loginFail > 0) { const e = new Error('NOT_LOGGED_IN'); e.code = 'NOT_LOGGED_IN'; throw e; }
  // 全部完成→明天；有未完成→30分钟后重试剩余的
  const next = allDone ? computeDailyNext(acc) : Date.now() + jitter(30 * 60000);
  setJob(id, 'daily', next);
  log(id, `每日任务 ${defs.filter(([k]) => done[k] === today).length}/${defs.length} 完成${allDone ? '' : '(剩余30分钟后重试)'}；下次 ${new Date(next).toLocaleString()}`);
}

// ==================== pasture 循环 job ====================
async function runPastureJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const p = new PastureClient(c.jar, { proxy: acc.proxy });
  let n = 0, rs = { n: 0 }, fed = 0, washed = 0, matureMin = null;
  if (cfg.pastureLoop) {
    let info = await p.getInfo();
    if (info.dogHungry) await p.feedDog();
    // 先收获成熟的
    for (const hid of info.harvestable) { await p.harvest(hid); n++; }
    // 关键：喂食饥饿动物(否则"停止成长"永远长不大)+ 洗澡
    const fr = await p.feedAnimals();
    fed = fr.fed; if (fr.bought) log(id, '食料不足，已自动购买开心牧草x50');
    washed = await p.cleanAnimals();
    // 补栏空闲圈舍
    rs = await p.restockAll();
    // 重新读取，计算下次成熟时间用于精确唤醒
    info = await p.getInfo();
    matureMin = info.nextMatureMin;
    store.setStatus(id, { pastureInfo: { harvestable: info.harvestable.length, idle: info.idleCorrals.length, needFeed: info.needFeed, nextMatureAt: matureMin != null ? Date.now() + matureMin * 60000 : null } });
  }
  // 唤醒：按最近动物成熟时间，封顶 pastureIntervalMin；喂食后一般十几分钟就发情/成熟
  const cap = (cfg.pastureIntervalMin || 120) * 60000;
  let delay = matureMin != null ? Math.min(matureMin * 60000, cap) : cap;
  if (delay < 60000) delay = 60000;
  const next = Date.now() + jitter(delay);
  setJob(id, 'pasture', next);
  if (cfg.pastureLoop) log(id, `牧场 收获${n} 喂食${fed} 洗澡${washed} 补栏${rs.n}${rs.name ? '×' + rs.name : ''}；下次 ${new Date(next).toLocaleTimeString()}${matureMin != null ? `(约${matureMin}分钟后)` : ''}`);
}

// ==================== 神殿拓荒 job（完成后奖励自动放入库房，独立循环，一轮结束立刻发起下一轮）====================
async function runPioneerJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const p = new PastureClient(c.jar, { proxy: acc.proxy });
  const r = await p.pioneer(cfg.pioneerScene || 1, cfg.pioneerAction || 4);
  // 不管刚发起成功还是撞见"上一轮还没结束"，都读一次 scene.do 上真实的倒计时来精确排期——
  // 实测按 action 猜固定时长(文档写的10/30/50分)不准(账号等级越高实际耗时越长)，
  // 读不到倒计时(格式没匹配上/瞬间状态)才兜底5分钟后再查
  const st = await p.pioneerStatus();
  const delayMin = st.remainMin != null ? st.remainMin + 1 : 5;
  log(id, `拓荒: ${r.text}${st.remainMin != null ? `(约${st.remainMin}分钟后完成)` : ''}；下次 ${new Date(Date.now() + delayMin * 60000).toLocaleTimeString()}`);
  setJob(id, 'pioneer', Date.now() + jitter(delayMin * 60000));
}

// ==================== 牧场独立喂食 job（不依赖 pastureLoop/pastureDaily，按固定间隔巡检）====================
// 动物饥饿后"停止成长"，光靠每日一次的 pastureDaily 或依赖 pastureLoop 才有的喂食，中间空窗太长；
// 独立拆出来按 pastureFeedIntervalMin(默认3.5小时) 轮询，跟其他牧场逻辑各自独立、互不阻塞
async function runPastureFeedJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const p = new PastureClient(c.jar, { proxy: acc.proxy });
  const info = await p.getInfo();
  if (info.dogHungry) await p.feedDog();
  const { fed, bought } = await p.feedAnimals();
  // 回写 needFeed，否则 UI 的"待喂食"角标会一直停留在喂食前读到的旧数字
  const info2 = fed ? await p.getInfo() : info;
  store.setStatus(id, { pastureInfo: { ...(acc.status.pastureInfo || {}), needFeed: info2.needFeed } });
  log(id, `${fed ? `牧场喂食: ${fed}只` : '牧场巡检: 暂无待喂食动物'}${bought ? '(食料不足已自动购买开心牧草x50)' : ''}`);
  const next = Date.now() + jitter((cfg.pastureFeedIntervalMin || 210) * 60000);
  setJob(id, 'pasturefeed', next);
}

// ==================== 宠物培养循环 job ====================
const TRAIN_NAME = { 1: '气质', 2: '斗志', 3: '智慧', 4: '体贴' };
async function runPetTrainJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const pet = new PetClient(c.jar, { proxy: acc.proxy });
  const st = await pet.getTrain();
  let delayMin;
  if (st.training) {
    delayMin = (st.remainMin || 5) + 1;
    log(id, `宠物培养中(${st.current}) 剩${st.remainMin}分钟`);
  } else if (st.pressure >= 90) {
    // 压力过高培养会“适得其反”，白费珍珠 → 跳过，需动感MP3减压（全局，换技能也无效）
    delayMin = 60;
    log(id, `宠物压力${st.pressure}过高，培养无效(需动感MP3减压)，暂停避免浪费珍珠`);
  } else {
    // 多技能轮换：从上次位置起依次尝试，某个练不了(非全局原因)自动换下一个
    const list = (cfg.petTrainWts && cfg.petTrainWts.length) ? cfg.petTrainWts : [cfg.petTrainWt || 3];
    const start = acc.status.trainIdx || 0;
    let done = false, globalBlock = null;
    for (let k = 0; k < list.length; k++) {
      const wt = list[(start + k) % list.length];
      const r = await pet.train(wt);
      if (r.ok) {
        log(id, `宠物培养[${TRAIN_NAME[wt]}]: ${r.reason}`);
        store.setStatus(id, { trainIdx: (start + k + 1) % list.length });
        delayMin = 6; done = true; break;
      }
      if (r.reason === '珍珠不足' || r.reason === '体力不足') { globalBlock = r.reason; break; } // 全局，换技能无用
      log(id, `宠物培养[${TRAIN_NAME[wt]}]不可(${r.reason})，自动换技能`);
    }
    if (!done) { delayMin = globalBlock === '体力不足' ? 30 : 60; log(id, `宠物培养暂停(${globalBlock || '无可练技能'})，${delayMin}分钟后重试`); }
  }
  const next = Date.now() + jitter(delayMin * 60000);
  setJob(id, 'pettrain', next);
}

// ==================== 聊天室抢积分 job（每天一次突发轮询）====================
// acc 可选：今天没抢过且已过设定点则尽快补抢，否则排明天
function computeGrabNext(cfg, acc) {
  const now = new Date();
  const start = new Date(now); start.setHours(cfg.grabHour || 12, cfg.grabMin || 0, 0, 0);
  if (now < start) return start.getTime() + Math.random() * 60000;    // 今天还没到
  if (!acc || acc.status.lastGrab !== todayStr()) return Date.now() + Math.random() * 120000; // 今天没抢 → 2分钟内补抢
  return start.getTime() + 86400000 + Math.random() * 60000;          // 今天已抢 → 明天
}
async function runGrabJob(id) {
  const acc = store.get(id);
  const cfg = acc.config;
  if (acc.status.lastGrab === todayStr()) { setJob(id, 'grab', computeGrabNext(cfg, acc)); return; }
  // 专用快速客户端（不与农场共享，抢卡要频繁）
  const gc = new FarmClient(acc.cookie, { proxy: acc.proxy });
  gc.minGap = 400;
  const room = cfg.grabRoom || 696;
  const endAt = Date.now() + (cfg.grabWindowMin || 10) * 60000;
  const pollMs = Math.max(1000, (cfg.grabPollSec || 3) * 1000);
  let grabbed = 0, full = false, rounds = 0, lastLog = 0;
  log(id, `开始抢积分(房间${room})，轮询${cfg.grabWindowMin || 10}分钟(每${pollMs / 1000}秒)…`);
  while (Date.now() < endAt) {
    rounds++;
    try {
      const r = await gc.grabRoomCards(room);
      if (r.found) { grabbed += r.found; log(id, `🎯抢卡: ${r.results.join(' / ') || r.found + '张'}`); }
      if (r.full) { full = true; log(id, '积分已抢满，停止'); break; }
    } catch (e) { if (e.code === 'NOT_LOGGED_IN') { log(id, '抢积分:Cookie失效，终止本轮'); break; } }
    if (Date.now() - lastLog > 60000) { log(id, `抢积分轮询中…已${rounds}轮`); lastLog = Date.now(); } // 每分钟报活
    await sleep(pollMs);
  }
  store.setStatus(id, { lastGrab: todayStr() });
  setJob(id, 'grab', computeGrabNext(cfg, acc));
  log(id, `抢积分结束：${rounds}轮，抢到${grabbed}次${full ? '(已满)' : ''}；下次 ${new Date(store.get(id).status.jobs.grab).toLocaleString()}`);
}

// ==================== msgwatch job（好友留言骚扰监测，先只记日志，不自动删）====================
// 关键机制(实测验证过)：commonReceiveManage.do 这个列表本质是"未读队列"——只要调用过
// commonReceiveDetail.do?id=X 查看某条，它就会立刻从这个列表永久消失(不是按id/时间排列
// 不变的历史归档，而是"没看过的"才会出现)。所以完全不需要自己记"扫到哪了"：每次巡检把
// 当前能翻到的页面都看一遍(=都查看一遍详情)，看过的自然从队列里掉出去，下次巡检看到的
// 就是这之后新收到的。曾经踩过坑：最初按"消息id是否大于上次记录的最大id"判断是否是新
// 留言，但由于查看会让列表"塌陷"(后面的老消息会顶上来占据第1页)，旧的id会被误判成
// "已经处理过"而永远跳过——即使从来没有真正看过/判定过内容。
const MSG_WATCH_MAX_PAGES = 20; // 一次巡检最多翻的页数(约100条)，积压太多时分多轮巡检慢慢消化，不影响正确性
async function runMsgWatchJob(id, c) {
  const acc = store.get(id);
  const cfg = acc.config;
  const newIds = [];
  for (let page = 1; page <= MSG_WATCH_MAX_PAGES; page++) {
    const ids = await c.getMessagePage(page);
    if (!ids.length) break;
    newIds.push(...ids);
    await sleep(300 + Math.random() * 300);
  }
  let flagged = 0;
  const offenders = new Set(store.getSettings().msgOffenders || []);
  let offendersChanged = false;
  // 命中但没自动删的，存进待清理列表——不然只写进日志，用户找不到地方批量处理
  const pending = [...(acc.status.msgPending || [])];
  for (const mid of newIds) {
    let det;
    try { det = await c.getMessageDetail(mid); } catch { continue; }
    if (!det.uid) continue;
    const known = offenders.has(det.uid);
    const r = msgFilter.classify(det.body, det.from, known);
    if (r.suspicious) {
      flagged++;
      log(id, `⚠️疑似骚扰留言 来自${det.from}(${det.uid}): ${det.body.slice(0, 60)} [命中:${r.matched.join(',')}]${cfg.msgAutoDelete ? '' : ' (观察期，未删除)'}`);
      if (!known) { offenders.add(det.uid); offendersChanged = true; }
      if (cfg.msgAutoDelete) {
        try { await c.deleteMessage(mid); log(id, `已删除留言#${mid}`); } catch (e) { log(id, `删除留言#${mid}失败: ${e.message}`); }
      } else {
        pending.push({ id: mid, from: det.from, uid: det.uid, body: det.body.slice(0, 100), matched: r.matched, ts: Date.now() });
      }
    }
    await sleep(300 + Math.random() * 300);
  }
  if (offendersChanged) store.setSettings({ msgOffenders: [...offenders] });
  if (pending.length !== (acc.status.msgPending || []).length) store.setStatus(id, { msgPending: pending });
  log(id, newIds.length ? `留言巡检: 查看${newIds.length}条，命中${flagged}条` : '留言巡检: 无待查看留言');
  setJob(id, 'msgwatch', Date.now() + jitter((cfg.msgWatchIntervalMin || 60) * 60000));
}

// ==================== job 执行包装（并发+登录重试）====================
async function runJob(id, type, retried = false) {
  const acc = store.get(id);
  if (!acc) return;
  const key = `${id}:${type}`;       // 账号+任务类型级锁：同账号不同任务可并行
  running.add(key); activeCount++;
  store.setStatus(id, { state: 'running' });
  let c = getClient(acc);
  if (acc.status.needLogin && acc.useruid && acc.password) {
    try { await relogin(id); c = getClient(store.get(id)); } catch (e) { log(id, '重登失败: ' + e.message); }
  }
  try {
    const task = (async () => {
      if (type === 'farm') await runFarmJob(id, c);
      else if (type === 'friendland') await runFriendLandJob(id);
      else if (type === 'steal') await runStealJob(id);
      else if (type === 'care') await runCareJob(id);
      else if (type === 'farmtask') await runFarmTaskJob(id);
      else if (type === 'daily') await runDailyJob(id, c);
      else if (type === 'pasture') await runPastureJob(id, c);
      else if (type === 'pasturefeed') await runPastureFeedJob(id, c);
      else if (type === 'pioneer') await runPioneerJob(id, c);
      else if (type === 'pettrain') await runPetTrainJob(id, c);
      else if (type === 'grab') await runGrabJob(id);
      else if (type === 'goldfight') await runGoldFightJob(id);
      else if (type === 'msgwatch') await runMsgWatchJob(id, c);
    })();
    // 看门狗兜底：单次请求已有超时保护，这里再兜一层，防止任何未预见的挂起
    // (死循环/异常累积)把 running 锁永久卡死、该任务从此再也不被调度
    const timeout = new Promise((_, reject) => setTimeout(() => {
      const e = new Error(`${type} 执行超过20分钟未完成，判定为卡死`);
      e.code = 'JOB_TIMEOUT';
      reject(e);
    }, 20 * 60 * 1000));
    await Promise.race([task, timeout]);
    store.setStatus(id, { state: 'idle' });
  } catch (e) {
    if (e.code === 'JOB_TIMEOUT') {
      log(id, `❌ ${e.message}，强制重新排期`);
      store.setStatus(id, { state: 'error', lastResult: `${type}执行超时` });
      setJob(id, type, Date.now() + jitter(10 * 60000));
      return; // finally 仍会执行，释放锁
    }
    if (e.code === 'NOT_LOGGED_IN' && acc.useruid && acc.password && !retried) {
      running.delete(key); activeCount--;
      try { await relogin(id); } catch (le) {
        store.setStatus(id, { state: 'error', needLogin: true, lastResult: '自动登录失败: ' + le.message });
        log(id, '❌ 自动登录失败: ' + le.message);
        return;
      }
      return runJob(id, type, true);
    }
    if (e.code === 'NOT_LOGGED_IN') {
      store.setStatus(id, { state: 'error', needLogin: true, lastResult: 'Cookie失效，请重登或配账密' });
      log(id, '❌ Cookie失效');
    } else {
      store.setStatus(id, { state: 'error', lastResult: '错误: ' + e.message });
      log(id, `❌ ${type} 出错: ${e.message}`);
      // 出错也要排下次，避免卡死（延后重试）
      setJob(id, type, Date.now() + jitter(10 * 60000));
    }
  } finally {
    running.delete(key); activeCount--;
  }
}

// ==================== 全局调度 tick ====================
function tick() {
  const s = store.getSettings();
  const now = Date.now();
  // 收集到期 job
  const due = [];
  for (const acc of store.list()) {
    if (!acc.config.enabled || acc.status.needLogin) continue;
    const jobs = acc.status.jobs || {};
    let dirty = false;
    for (const type of ['farm', 'friendland', 'steal', 'care', 'farmtask', 'daily', 'pasture', 'pasturefeed', 'pioneer', 'pettrain', 'grab', 'goldfight', 'msgwatch']) {
      if (!jobEnabled(acc, type)) continue;
      if (running.has(`${acc.id}:${type}`)) continue; // 该账号该任务已在跑（同账号不同任务可并行）
      let nr = jobs[type];
      // 定时类(daily/grab)未排期时按设定时间初始化，不立即执行
      if (nr == null && (type === 'daily' || type === 'grab')) {
        jobs[type] = nr = type === 'daily' ? computeDailyNext(acc) : computeGrabNext(acc.config, acc);
        dirty = true;
        continue;
      }
      if (nr == null || nr <= now) due.push({ id: acc.id, type, nr: nr || 0 });
    }
    if (dirty) store.setStatus(acc.id, { jobs });
  }
  due.sort((a, b) => a.nr - b.nr); // 最早到期优先
  // 跨账号也把"每日任务"(签到/每日领取)单独限流串行——即使总并发槽还有空，
  // 也不让多个账号同时刷签到类操作，避免被风控识别成"批量刷"
  let dailyRunning = [...running].filter((k) => k.endsWith(':daily')).length;
  const dailyCap = s.dailyMaxConcurrent || 1;
  for (const d of due) {
    if (activeCount >= s.maxConcurrent) break;         // 负载均衡：满则等下个 tick
    if (running.has(`${d.id}:${d.type}`)) continue;    // 同账号同任务不重复
    if (d.type === 'daily' && dailyRunning >= dailyCap) continue; // 每日任务额外限流，留到下轮
    runJob(d.id, d.type);
    if (d.type === 'daily') dailyRunning++;
  }
}

function startLoop() {
  if (tickTimer) return;
  const s = store.getSettings();
  tickTimer = setInterval(tick, (s.tickSec || 20) * 1000);
  tick();
}

// ==================== 对外接口 ====================
// 开启账号：初始化各 job 的 nextRun（farm 立即错峰、daily 按窗口）
function start(id) {
  const acc = store.get(id);
  if (!acc) return;
  const jobs = {};
  jobs.farm = Date.now() + Math.random() * 30000; // 错峰启动
  jobs.daily = computeDailyNext(acc);
  if (acc.config.pastureLoop) jobs.pasture = Date.now() + Math.random() * 60000;
  if (acc.config.pioneer) jobs.pioneer = Date.now() + Math.random() * 60000;
  if (acc.config.petTrain) jobs.pettrain = Date.now() + Math.random() * 30000;
  if (acc.config.grabPoints) jobs.grab = computeGrabNext(acc.config, acc);
  if (acc.config.goldFight) jobs.goldfight = Date.now() + Math.random() * 30000;
  store.update(id, { config: { enabled: true } });
  store.setStatus(id, { jobs });
  startLoop();
  log(id, '已加入调度');
}

function stop(id) {
  store.update(id, { config: { enabled: false } });
  store.setStatus(id, { state: 'idle' });
}

// 立即执行一次（手动）：farm + 到期的 daily（各自按类型锁，可与其他任务并行）
async function runCycle(id, manual = true) {
  const acc = store.get(id);
  if (!acc) return;
  if (!running.has(`${id}:farm`)) runJob(id, 'farm');
  if (jobEnabled(acc, 'daily') && acc.status.lastDaily !== todayStr() && !running.has(`${id}:daily`)) {
    // 手动触发也要遵守 dailyMaxConcurrent 限流：否则用户/前端对多个账号连点"立即执行"
    // 会绕过 tick() 里的每日任务节流，同样有被风控识别成批量刷的风险
    const s = store.getSettings();
    const dailyRunning = [...running].filter((k) => k.endsWith(':daily')).length;
    if (dailyRunning < (s.dailyMaxConcurrent || 1)) {
      runJob(id, 'daily');
    } else {
      // 标记为"现在到期"，交给下一次 tick() 按限流顺序排队执行，而不是立刻抢跑
      store.setStatus(id, { jobs: { ...(acc.status.jobs || {}), daily: Date.now() } });
    }
  }
}

// 服务启动恢复：为已启用账号补齐缺失的 job 时间，然后开循环
function resume() {
  for (const acc of store.list()) {
    if (!acc.config.enabled || acc.status.needLogin) continue;
    const jobs = acc.status.jobs || {};
    if (jobs.farm == null) jobs.farm = Date.now() + Math.random() * 30000;
    if (jobs.daily == null) jobs.daily = computeDailyNext(acc);
    if (acc.config.pastureLoop && jobs.pasture == null) jobs.pasture = Date.now() + Math.random() * 60000;
    if (acc.config.pioneer && jobs.pioneer == null) jobs.pioneer = Date.now() + Math.random() * 60000;
    if (acc.config.petTrain && jobs.pettrain == null) jobs.pettrain = Date.now() + Math.random() * 30000;
    if (acc.config.grabPoints && jobs.grab == null) jobs.grab = computeGrabNext(acc.config, acc);
    if (acc.config.goldFight && jobs.goldfight == null) jobs.goldfight = Date.now() + Math.random() * 30000;
    store.setStatus(acc.id, { jobs, state: 'idle' });
  }
  startLoop();
}

// 清理"留言骚扰待处理列表"：ids 不传则清空全部；传了就只删这几条，其余留着
async function cleanMsgPending(id, ids) {
  const acc = store.get(id);
  if (!acc) return { deleted: 0, failed: 0 };
  const pending = acc.status.msgPending || [];
  const targets = ids && ids.length ? pending.filter((p) => ids.includes(p.id)) : pending;
  const c = getClient(acc);
  let deleted = 0, failed = 0;
  for (const p of targets) {
    try { await c.deleteMessage(p.id); deleted++; log(id, `已删除留言#${p.id}(来自${p.from})`); }
    catch (e) { failed++; log(id, `删除留言#${p.id}失败: ${e.message}`); }
    await sleep(300 + Math.random() * 300);
  }
  const targetIds = new Set(targets.map((p) => p.id));
  store.setStatus(id, { msgPending: pending.filter((p) => !targetIds.has(p.id)) });
  return { deleted, failed };
}

module.exports = { runCycle, start, stop, resume, resetClient, getClient, relogin, logs, log, cleanMsgPending };
