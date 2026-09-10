const { FarmClient } = require('./client');
const { todayStr } = require('./daily-result');

function fullToday(acc) {
  return acc.status.grabStatus?.date === todayStr() && acc.status.grabStatus?.state === 'full';
}

function computeGrabNext(cfg, acc) {
  const start = new Date();
  start.setHours(cfg.grabHour ?? 12, cfg.grabMin ?? 0, 0, 0);
  if (fullToday(acc)) start.setDate(start.getDate() + 1);
  return Math.max(Date.now(), start.getTime());
}

// 独立于农场并发槽与20分钟看门狗：每个账号只保留一个轮询任务。
function createGrabScheduler({ store, log, getClient, relogin }) {
  const sessions = new Map();
  let timer = null;

  function stop(id) {
    const session = sessions.get(id);
    if (session) { session.cancelled = true; session.wake?.(); }
  }

  function enabled(acc) {
    return !!(acc && acc.config.enabled && acc.config.grabPoints && !acc.status.needLogin);
  }

  function publish(id, status, next, persist) {
    const acc = store.get(id);
    if (acc) store.setStatus(id, {
      grabStatus: { ...status },
      ...(status.state === 'full' ? { lastGrab: status.date } : {}),
      jobs: { ...(acc.status.jobs || {}), grab: next },
    }, { persist });
  }

  async function run(id, session, manual) {
    let acc = store.get(id);
    const day = todayStr();
    const prior = acc.status.grabStatus;
    const status = prior?.date === day ? { ...prior } : { date: day, rounds: 0, attempted: 0, claimed: 0, points: 0 };
    let client, lastSave = 0, lastLog = 0, loginRetried = false;
    const canRun = () => {
      const a = store.get(id);
      return !!(a && !session.cancelled && todayStr() === day && (manual || (enabled(a) && computeGrabNext(a.config, a) <= Date.now())));
    };
    log(id, manual ? '手动抢积分一次' : '开始持续抢积分：达到今日上限才结束');
    try {
      do {
        acc = store.get(id);
        if (!canRun()) break;
        const room = acc.config.grabRoom || 696;
        if (!client || client.proxy !== (acc.proxy || null)) {
          client = new FarmClient(getClient(acc).jar, { proxy: acc.proxy });
          client.minGap = 0;
          client.maxRetries = 0; // 超时交给下一轮，领取提交不在网络层重复发送。
        }
        let pause = Math.max(1000, (Number(acc.config.grabPollSec) || 1) * 1000);
        let significant = false, rewarded = false;
        status.room = room;
        status.rounds++;
        try {
          const r = await client.grabRoomCards(room, { shouldContinue: canRun });
          status.attempted += r.attempted;
          status.claimed += r.claimed;
          status.points += r.points;
          status.state = r.full ? 'full' : r.limited ? 'retrying' : 'running';
          status.message = r.results.join(' / ').slice(0, 300) || '当前没有可抢积分，继续等待';
          significant = r.full || r.limited;
          rewarded = r.claimed > 0;
          if (r.claimed) log(id, `抢积分成功：${r.claimed}次，获得${r.points}积分`);
          if (r.full) {
            log(id, '网站确认已达今日抢积分上限，当天停止');
          }
          if (r.limited) pause = Math.max(pause, 30000);
        } catch (e) {
          if (e.grabProgress) {
            status.attempted += e.grabProgress.attempted;
            status.claimed += e.grabProgress.claimed;
            status.points += e.grabProgress.points;
            rewarded = e.grabProgress.claimed > 0;
          }
          status.state = 'retrying';
          status.message = '抢积分请求失败：' + String(e.message || e).slice(0, 180);
          significant = true;
          pause = Math.max(pause, 5000);
          if (e.code === 'NOT_LOGGED_IN') {
            let restored = false;
            if (!loginRetried && canRun()) {
              loginRetried = true;
              try { restored = await relogin(id); } catch { /* 保留登录失败状态，等待更新凭证 */ }
            }
            if (restored) { client = null; status.message = '登录已恢复，继续抢积分'; }
            else {
              status.state = 'needLogin';
              status.message = '抢积分登录失效，请更新凭证';
              store.setStatus(id, { needLogin: true });
            }
          }
        }
        status.at = Date.now();
        const finished = status.state === 'full' || status.state === 'needLogin';
        // 成功/达到上限即时保存；普通进度30秒一次，避免每秒创建账号文件备份。
        const persist = finished || rewarded || significant && Date.now() - lastSave >= 5000 || Date.now() - lastSave >= 30000;
        let next = Date.now() + pause;
        if (status.state === 'full') {
          const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(acc.config.grabHour ?? 12, acc.config.grabMin ?? 0, 0, 0);
          next = tomorrow.getTime();
        }
        publish(id, status, next, persist || manual);
        if (persist) lastSave = Date.now();
        if (Date.now() - lastLog >= 60000 || finished) {
          log(id, `抢积分：${status.rounds}轮，成功${status.claimed}次，获得${status.points}积分；${status.message}`);
          lastLog = Date.now();
        }
        if (manual || finished || !canRun()) break;
        await new Promise(resolve => {
          const handle = setTimeout(() => { session.wake = null; resolve(); }, pause);
          session.wake = () => { clearTimeout(handle); session.wake = null; resolve(); };
        });
      } while (canRun());
    } finally {
      if (status.state !== 'full' && status.state !== 'needLogin') status.state = 'paused';
      acc = store.get(id);
      if (acc) publish(id, status, computeGrabNext(acc.config, acc), true);
      sessions.delete(id);
    }
    return status;
  }

  function launch(id, manual = false) {
    const session = { cancelled: false, wake: null, manual };
    sessions.set(id, session);
    return run(id, session, manual).catch(e => {
      sessions.delete(id);
      log(id, '抢积分任务异常：' + String(e.message || e).slice(0, 180));
      return { state: 'error', message: '抢积分任务异常' };
    });
  }

  function tick() {
    for (const [id, session] of sessions) if (!session.manual && !enabled(store.get(id))) stop(id);
    for (const acc of store.list()) {
      if (!enabled(acc) || sessions.has(acc.id)) continue;
      const next = computeGrabNext(acc.config, acc);
      if (next <= Date.now()) launch(acc.id);
      else if (acc.status.jobs?.grab !== next) store.setStatus(acc.id, { jobs: { ...(acc.status.jobs || {}), grab: next } });
    }
  }

  return {
    nextRun: acc => computeGrabNext(acc.config, acc),
    start() { if (!timer) { timer = setInterval(tick, 1000); tick(); } },
    stop,
    async once(id) {
      const acc = store.get(id);
      if (!acc) return '账号不存在';
      if (fullToday(acc)) return '已达今日上限，今天不再抢取';
      if (sessions.has(id)) return '持续抢积分正在运行，请查看任务状态';
      const status = await launch(id, true);
      return `成功${status.claimed || 0}次，获得${status.points || 0}积分；${status.message || '本轮结束'}`;
    },
  };
}

module.exports = { createGrabScheduler, computeGrabNext, fullToday };
