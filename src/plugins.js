// 牧场/宠物/圣衣 插件客户端：复用 FarmClient 的登录与请求逻辑（继承）
const { FarmClient, strip } = require('./client');
const R = FarmClient.resultText;

// ===================== 天下牧场 =====================
class PastureClient extends FarmClient {
  constructor(cookie, opts) { super(cookie, opts); this.base = 'https://tx.com.cn/plugins/pasture/cs/'; }

  async getInfo() {
    const html = await this.req('index.do');
    const t = strip(html);
    // 解析每个圈舍：雌舍N:动物(状态) 倒计时/产量
    const corrals = [];
    const blocks = t.split(/(?=雌舍\d+\s*[:：])/).slice(1);
    for (const b of blocks) {
      const head = b.match(/雌舍(\d+)\s*[:：]\s*([^\s(（]*)\s*[(（]?([^)）]*)[)）]?/);
      if (!head) continue;
      const seg = b.slice(0, 80);
      corrals.push({
        pos: +head[1],
        animal: /闲置/.test(seg) ? null : (head[2] || null),
        status: /闲置/.test(seg) ? '闲置' : (head[3] || (/收获期/.test(seg) ? '收获期' : '')),
        matureIn: (seg.match(/(\d+小时)?(\d+分钟)?后(?:成熟|发情|收获)/) || [])[0] || null,
        matureMin: FarmClient.matureMinutes(seg),
        harvestable: /收获期/.test(seg) || /产\d+\/剩[1-9]/.test(seg),
        idle: /闲置/.test(seg),
      });
    }
    const mins = corrals.map((c) => c.matureMin).filter((x) => x != null);
    return {
      level: +(t.match(/等级[:：]\s*(\d+)/) || [])[1] || 0,
      waCoin: +((t.match(/哇币[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      happyCoin: +((t.match(/开心币[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      harvestable: [...html.matchAll(/harvest\.do\?id=(\d+)/g)].map((m) => +m[1]),
      idleCorrals: [...new Set([...html.matchAll(/myFemales\.do\?id=(\d+)/g)].map((m) => +m[1]))],
      needFeed: [...new Set([...html.matchAll(/feedConfirm\.do\?id=(\d+)/g)].map((m) => +m[1]))].length,
      corrals,
      nextMatureMin: mins.length ? Math.min(...mins) : null,
      dogHungry: /挨饿中/.test(t),
      text: t.slice(t.indexOf('我的牧场'), t.indexOf('我的牧场') + 400),
    };
  }
  async dailyAward() { return R(await this.req('getAward.do')); }      // 每日登录大礼包
  async feedAll() { return R(await this.req('oneKeyFeed.do')); }        // 一键喂食（需狗技能）
  async disinfectAll() { return R(await this.req('disinfectAll.do')); }// 一键打针（需狗技能）
  async cleanAll() { return R(await this.req('cleanAll.do')); }        // 一键洗澡（需狗技能）
  async harvestAll() { return R(await this.req('harvestAll.do')); }     // 一键收获
  async fattenAll(toolid = 2) { return R(await this.req(`oneKeyChuiQing.do?toolid=${toolid}`)); } // 一键催肥/催情
  async nurseAll(toolid = 82) { return R(await this.req(`oneKeyYuer.do?toolid=${toolid}`)); }     // 一键育儿
  async harvest(id) { return R(await this.req(`harvest.do?id=${id}`)); }

  // 闲置圈舍 id 列表（可饲养）
  async getIdleCorrals() {
    const html = await this.req('index.do');
    return [...new Set([...html.matchAll(/myFemales\.do\?id=(\d+)/g)].map((m) => +m[1]))];
  }
  // 幼仔库存 [{femaleid, name, count}]（用一键饲养页解析，无需圈舍）
  async getBabies() {
    const html = await this.req('myFemales.do?oneKey=oneKey');
    return [...html.matchAll(/([一-龥A-Za-z0-9]+)\((\d+)\)[\s\S]{0,120}?(?:oneKeyFeedAnimal|feed)\.do\?femaleid=(\d+)/g)]
      .map((m) => ({ name: m[1], count: +m[2], femaleid: +m[3] }));
  }
  // 单圈舍饲养
  async feed(femaleid, corralId) { return R(await this.req(`feed.do?femaleid=${femaleid}&fcorralid=${corralId}&pn=0`)); }
  // 补栏：把所有闲置圈舍放入指定幼仔（默认库存最多的）；返回饲养数量
  async restockAll(femaleid = null) {
    const corrals = await this.getIdleCorrals();
    if (!corrals.length) return { n: 0, name: null };
    let fid = femaleid, name = null;
    if (!fid) {
      const babies = (await this.getBabies()).filter((b) => b.count > 0).sort((a, b) => b.count - a.count);
      if (!babies.length) return { n: 0, name: null };
      fid = babies[0].femaleid; name = babies[0].name;
    }
    let n = 0;
    for (const cid of corrals) { const r = await this.feed(fid, cid); if (/饲养成功/.test(r)) n++; }
    return { n, name };
  }
  // 喂狗（狗粮 toolid=6）；uid 取自登录 cookie
  async feedDog() {
    const uid = this.jar.txuid || '';
    return R(await this.req(`useTool.do?toolid=6&fcorralid=0&uid=${uid}&pn=0`));
  }
  // 喂食所有饥饿动物(吃饭)：停止成长的动物必须喂食才会继续生长
  async feedAnimals() {
    const uid = this.jar.txuid || '';
    const h = await this.req('index.do');
    const ids = [...new Set([...h.matchAll(/feedConfirm\.do\?id=(\d+)/g)].map((m) => m[1]))];
    let n = 0;
    for (const id of ids) { await this.req(`feedConfirm.do?id=${id}&uid=${uid}`); n++; }
    return n;
  }
  // 给动物洗澡(clean)
  async cleanAnimals() {
    const uid = this.jar.txuid || '';
    const h = await this.req('index.do');
    const ids = [...new Set([...h.matchAll(/clean\.do\?id=(\d+)/g)].map((m) => m[1]))];
    let n = 0;
    for (const id of ids) { await this.req(`clean.do?id=${id}&from=${uid}`); n++; }
    return n;
  }
  async getFriendPasture(uid) { return this.req(`index.do?uid=${uid}`); } // 串门（偷）

  // 神殿拓荒：sceneid 1野猪林/2九寨沟/3西双版纳；action 1木材30分/2干草30分/3石块50分/4兽骨10分（免费）
  // 到点自动掉落战利品；若已在拓荒返回“进行中”
  async pioneer(sceneid = 1, action = 1) {
    const t = strip(await this.req('pioneer.do', { method: 'POST', body: `action=${action}&sceneid=${sceneid}` }));
    if (/正在.*(消灭|拓荒)|只能同时进行一种/.test(t)) return '拓荒进行中';
    if (/请选择拓荒类型/.test(t)) return '已发起拓荒(选类型)';
    const i = t.indexOf('神殿'); return (t.slice(i + 2, i + 60).trim() || '已发起拓荒');
  }
  async pioneerStatus() {
    const t = strip(await this.req('scene.do'));
    return /正在.*拓荒|你正在.*消灭/.test(t) ? '进行中' : '空闲';
  }
}

// ===================== 幻宠乐园（宠物） =====================
class PetClient extends FarmClient {
  constructor(cookie, opts) { super(cookie, opts); this.base = 'https://tx.com.cn/plugins/pet2/cs/'; }

  async getInfo() {
    const html = await this.req('fossa.do');
    const t = strip(html);
    return {
      level: +(t.match(/等级[:：]\s*(\d+)/) || [])[1] || 0,
      pearl: +((t.match(/珍珠[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      hunger: (t.match(/饥饿[:：]\s*[\d/]+/) || [])[0] || null,
      stamina: (t.match(/体力[:：]\s*[\d/]+/) || [])[0] || null,
      sick: /生病/.test(t),
      text: t.slice(t.indexOf('昵称'), t.indexOf('昵称') + 300),
    };
  }
  async dailyAllowance() { // 每日报道津贴（allowance.do 直接领取）
    const t = strip(await this.req('allowance.do?tpi=0'));
    const m = t.match(/(领取报道津贴[^,。]*[,，]?[^。]{0,40}|你今天已经领过了[^。]{0,20}|获得[^。]{0,30})/);
    return m ? m[0] : '已访问津贴页';
  }
  // 劳动·种花：收获所有花圃（被动产出，定期收）
  async harvestWork() {
    const html = await this.req('work.do?tpi=0');
    const links = [...new Set([...html.matchAll(/harvest\.do\?tpi=0&(?:amp;)?ht=\d+&(?:amp;)?gid=\d+&(?:amp;)?pp=\d+/g)].map((m) => m[0].replace(/&amp;/g, '&')))];
    let n = 0;
    for (const l of links) { await this.req(l); n++; }
    return n;
  }
  async attendance() { const t = strip(await this.req('care.do?tpi=0')); const i = t.search(/全勤|报道|喂养记录|奖/); return i >= 0 ? t.slice(i, i + 40) : '已报到'; } // 到访/全勤
  async feed() { await this.ensureZ(); return R(await this.req(`eatLink.do?tpi=0&z=${this.z}`)); } // 喂食(生病时需先治疗)
  async work() { return R(await this.req('work.do?tpi=0')); }
  async getTasks() { return this.req('task.do?tpi=0'); }

  // 培养：wt 3智慧(学习)/2斗志(练武)/1气质(跳舞)/4体贴(做家务)；每次5分钟、30体力、300珍珠
  async getTrain() {
    const t = strip(await this.req('train.do?tpi=0'));
    const cur = (t.match(/正在(学习|练武|跳舞|做家务)/) || [])[1] || null;
    return {
      training: !!cur, current: cur,
      remainMin: +(t.match(/还剩(\d+)分钟/) || [])[1] || 0,
      attrs: { 智慧: +(t.match(/智慧[:：]\s*(\d+)/) || [])[1] || 0, 斗志: +(t.match(/斗志[:：]\s*(\d+)/) || [])[1] || 0, 气质: +(t.match(/气质[:：]\s*(\d+)/) || [])[1] || 0, 体贴: +(t.match(/体贴[:：]\s*(\d+)/) || [])[1] || 0 },
      pressure: +(t.match(/压力[:：]\s*(\d+)/) || [])[1] || 0,
    };
  }
  async train(wt = 3) {
    const r = strip(await this.req(`trainChk.do?wt=${wt}&tpi=0`));
    if (/体力不足|体力不够|体力不能/.test(r)) return { ok: false, reason: '体力不足' };
    if (/珍珠不足|珍珠不够/.test(r)) return { ok: false, reason: '珍珠不足' };
    if (/正在(学习|练武|跳舞|做家务)/.test(r)) return { ok: true, reason: '培养中' };
    return { ok: true, reason: '已发起培养' };
  }
  // 减压：special.do?t=5 用动感MP3(每个减10压力)；无道具则提示需购买
  async reducePressure() {
    const h = await this.req('special.do?tpi=0&t=5');
    if (/去商店购买|没有|购买\[?动感MP3/.test(strip(h))) return '无动感MP3(需商店购买)';
    const use = (h.match(/href=['"]([^'"]*(?:use|special|eat)[^'"]*)['"]/i) || [])[1];
    if (!use) return '无可用减压道具';
    return R(await this.req(use.replace(/&amp;/g, '&')));
  }
}

// ===================== 黄金圣衣 =====================
class GoldClient extends FarmClient {
  constructor(cookie, opts) { super(cookie, opts); this.base = 'https://tx.com.cn/plugins/gold/cs/'; }

  async getInfo() {
    const html = await this.req('index.do');
    const t = strip(html);
    return {
      level: +(t.match(/等级[:：]\s*(\d+)/) || [])[1] || 0,
      hp: (t.match(/体力[:：]\s*[\d/]+/) || [])[0] || null,
      coin: +((t.match(/铜币[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''),
      cosmos: +(t.match(/小宇宙[:：]\s*(\d+)/) || [])[1] || 0,
      text: t.slice(t.indexOf('我的状态'), t.indexOf('我的状态') + 300),
    };
  }
  async dailyReward() { // 领取每日奖励（chestsTask 页开每日宝箱）
    const page = await this.req('chestsTask.do');
    const m = page.match(/chestsOpen\.do\?chestsId=(\d+)/);
    if (!m) return strip(page).match(/(已开|已领|明日|每日宝箱)[^。]{0,30}/)?.[0] || '今日无可开宝箱';
    return R(await this.req(`chestsOpen.do?chestsId=${m[1]}`));
  }
  async practice() { return R(await this.req('practiceMess.do')); }         // 修炼
  async dig(digType = 2) { return R(await this.req(`areaDig.do?digType=${digType}`)); } // 搜寻/打怪
  async arena() { return this.req('arenaInfo.do'); }                        // 竞技

  // 全部地图列表(圣地档 t=1..6)：{name, level(进入等级), mapId}[]
  async getAreaList() {
    const tiers = await Promise.all([1, 2, 3, 4, 5, 6].map((t) => this.req(`areas.do?t=${t}`)));
    const seen = new Set();
    const areas = [];
    for (const html of tiers) {
      for (const m of html.matchAll(/([一-龥Ａ-ｚA-Za-z0-9\-]+)\((\d+)级\)<a href="areaDig\.do\?id=(\d+)"/g)) {
        const id = +m[3];
        if (seen.has(id)) continue;
        seen.add(id);
        areas.push({ name: m[1], level: +m[2], mapId: id });
      }
    }
    return areas;
  }

  // 某地图当前的 boss 状态：[{name, level, mapId, bossId(null=冷却中), available, respawnSec}]
  async getAreaBosses(mapId) {
    const html = await this.req(`areaDig.do?id=${mapId}&digType=5`);
    const blocks = html.split(/(?=★[一-龥]+\(\d+级\))/).slice(1);
    const bosses = [];
    for (const b of blocks) {
      const m = b.match(/★([一-龥]+)\((\d+)级\)/);
      if (!m) continue;
      const bossIdM = b.match(/name="bossId"\s+value="(\d+)"/);
      const cd = strip(b).match(/(\d+)分钟(\d+)秒后复活|(\d+)秒后复活/);
      bosses.push({
        name: m[1], level: +m[2], mapId,
        bossId: bossIdM ? +bossIdM[1] : null,
        available: !!bossIdM,
        respawnSec: cd ? (cd[1] ? (+cd[1] * 60 + +cd[2]) : +cd[3]) : null,
      });
    }
    return bosses;
  }

  // 汇总所有"进入等级 <= maxLevel"的地图，找出当前等级<=maxLevel且存活可攻击的boss
  // 公会地图(需占领该区域的公会成员身份才能打，个人打不了；来自玩家攻略帖确认)
  static GUILD_MAP_IDS = new Set([28, 31]); // 圣殿花园、神域保卫战

  // 返回该等级范围内全部 boss(含冷却中的，供调度器算下次唤醒时间)
  // 按地图入场门槛(<=maxLevel)筛选地图；地图内所有怪都打，不再额外按怪物自身等级过滤
  // (同一地图常混有远超入场门槛的怪，例如"陽-末日试炼"入场29级但内有30/32级的怪，也要打)
  async getFightStatus(maxLevel = 29) {
    const areas = (await this.getAreaList()).filter((a) => a.level <= maxLevel && !GoldClient.GUILD_MAP_IDS.has(a.mapId));
    const results = await Promise.all(areas.map((a) => this.getAreaBosses(a.mapId).catch(() => [])));
    const bosses = [];
    results.forEach((list, i) => { for (const b of list) bosses.push({ ...b, areaName: areas[i].name }); });
    return bosses;
  }

  async getFightTargets(maxLevel = 29) {
    return (await this.getFightStatus(maxLevel)).filter((b) => b.available);
  }

  // 攻击 boss；返回 {ok, reason, text}。已知失败原因：等级过高不能进入该地图、非该区域占领公会成员、体力不足
  async fightBoss(mapId, bossId) {
    const html = await this.req('fightingBoss.do', { method: 'POST', body: `mapId=${mapId}&bossId=${bossId}` });
    const t = strip(html);
    const i = t.search(/战斗|胜利|失败|获得|挑战/);
    const text = (i >= 0 ? t.slice(i, i + 200) : t.slice(0, 150)).trim();
    if (/等级过高/.test(text)) return { ok: false, reason: '等级过高不能进入', text };
    if (/不是.*公会成员|公会/.test(text)) return { ok: false, reason: '非占领公会成员', text };
    if (/体力不足/.test(text)) return { ok: false, reason: '体力不足', text };
    if (/胜利|获得|击败|击杀/.test(text)) return { ok: true, reason: '战斗胜利', text };
    return { ok: false, reason: '未知结果', text };
  }
}

module.exports = { PastureClient, PetClient, GoldClient };
