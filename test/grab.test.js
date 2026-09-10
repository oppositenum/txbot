const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { FarmClient } = require('../src/client');
const { parseGrabResult } = require('../src/grab-result');
const empty = () => ({ found: 0, attempted: 0, claimed: 0, points: 0, full: false, limited: false, results: [] });
const full = () => ({ ...empty(), full: true, results: ['已达今日上限'] });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(count = 1, round = async () => empty()) {
  let now = new Date(2026, 8, 10, 0, 21).getTime();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const today = () => { const d = new Clock(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const accounts = Array.from({length:count}, (_,i) => ({ id:'a'+i, config:{enabled:true,grabPoints:true,grabHour:0,grabMin:20,grabPollSec:1}, status:{lastGrab:today(),jobs:{}} }));
  const calls=[],writes=[],timers=new Map(); let tick;
  const store = { list:()=>accounts, get:id=>accounts.find(a=>a.id===id), setStatus(id,patch,opts={}) { const a=this.get(id); if(a)Object.assign(a.status,patch); writes.push({id,patch:structuredClone(patch),persist:opts.persist!==false}); } };
  const logs=[];
  class Client { constructor(jar,{proxy}) { this.id=jar.id;this.proxy=proxy||null; } async grabRoomCards(room,opts) { calls.push({id:this.id,room});return round(this.id,opts); } }
  const sandbox={module:{exports:{}},Date:Clock,Map,Math,
    setInterval(fn) { tick=fn;return 1; },
    setTimeout(fn,ms) { const token={};timers.set(token,{fn,at:now+ms});return token; },clearTimeout(token){timers.delete(token);},
    require(name){if(name==='./client')return {FarmClient:Client};if(name==='./daily-result')return {todayStr:today};throw Error(name);}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/grab-scheduler'),'utf8'),sandbox);
  let logins=0;
  const scheduler=sandbox.module.exports.createGrabScheduler({store,log:(id,msg)=>logs.push(msg),getClient:a=>({jar:{id:a.id}}),relogin:async()=>{logins++;return false;}});
  return {scheduler,accounts,calls,writes,logs,timers,store,get logins(){return logins;},get now(){return now;},today,
    next:acc=>sandbox.module.exports.computeGrabNext(acc.config,acc),
    async advance(ms){now+=ms;for(const [token,t] of [...timers])if(t.at<=now){timers.delete(token);t.fn();}tick?.();await flush();},
    async start(){scheduler.start();await flush();}};
}

test('开始小时0按00:20处理；旧lastGrab不作为抢满证据', async()=>{
  const f=fixture();assert.equal(f.next(f.accounts[0]),f.now);
  f.accounts[0].config.grabMin=30;assert.equal(new Date(f.next(f.accounts[0])).getHours(),0);
  assert.equal(new Date(f.next(f.accounts[0])).getMinutes(),30);
  await f.start();assert.equal(f.calls.length,0);
  await f.advance(9*60000);assert.equal(f.calls.length,1);
});

test('无活动及超过10/20分钟均继续；上限才完成，跨天重新开始',async()=>{
  let rounds=0;const f=fixture(1,async()=>++rounds===3?full():empty());
  delete f.accounts[0].status.lastGrab;
  await f.start();assert.equal(f.calls.length,1);assert.equal(f.accounts[0].status.lastGrab,undefined);
  await f.advance(21*60000);assert.equal(f.calls.length,2);assert.equal(f.accounts[0].status.lastGrab,undefined);
  await f.advance(1000);assert.equal(f.calls.length,3);assert.equal(f.accounts[0].status.lastGrab,f.today());assert.equal(f.accounts[0].status.grabStatus.state,'full');
  await f.advance(10000);assert.equal(f.calls.length,3);
  await f.advance(24*60*60000);assert.equal(f.calls.length,4);
});

test('20个账号独立运行，单账号不重叠；手动请求不重复抢取',async()=>{
  const pending=[];const f=fixture(20,()=>new Promise(resolve=>pending.push(resolve)));
  await f.start();assert.equal(f.calls.length,20);
  await f.advance(3000);assert.equal(f.calls.length,20);
  assert.match(await f.scheduler.once('a0'),/正在运行/);assert.equal(f.calls.length,20);
  for(const acc of f.accounts)acc.config.grabPoints=false;
  await f.advance(1000);for(const resolve of pending)resolve(empty());await flush();
  await f.advance(1000);assert.equal(f.calls.length,20);
});

test('关闭任务唤醒等待并停止；跨午夜等待配置开始时间',async()=>{
  const f=fixture();await f.start();f.accounts[0].config.grabPoints=false;await f.advance(100);
  assert.equal(f.accounts[0].status.grabStatus.state,'paused');await f.advance(10000);assert.equal(f.calls.length,1);
  const g=fixture();await g.start();await g.advance(23*60*60000+39*60000);
  assert.equal(new Date(g.now).getHours(),0);assert.equal(g.calls.length,1);
  await g.advance(20*60000);assert.equal(g.calls.length,2);
});

test('网络错误保留未完成并重试；限流退避；登录失效不虚报抢满',async()=>{
  let n=0;const f=fixture(1,async()=>{if(++n===1)throw Error('timeout');return {...empty(),limited:true,results:['操作过于频繁']};});
  delete f.accounts[0].status.lastGrab;await f.start();assert.equal(f.accounts[0].status.grabStatus.state,'retrying');assert.equal(f.accounts[0].status.lastGrab,undefined);
  await f.advance(1000);assert.equal(f.calls.length,1);await f.advance(4000);assert.equal(f.calls.length,2);
  await f.advance(29000);assert.equal(f.calls.length,2);await f.advance(1000);assert.equal(f.calls.length,3);
  const g=fixture(1,async()=>{const e=Error('login');e.code='NOT_LOGGED_IN';throw e;});delete g.accounts[0].status.lastGrab;
  await g.start();assert.equal(g.logins,1);assert.equal(g.accounts[0].status.needLogin,true);assert.equal(g.accounts[0].status.lastGrab,undefined);
  await g.advance(60000);assert.equal(g.calls.length,1);
});

test('成功立即落盘，空轮询进度不每秒写盘',async()=>{
  let n=0;const f=fixture(1,async()=>++n===2?{...empty(),attempted:1,claimed:1,points:10,results:['获得10积分']}:empty());
  await f.start();await f.advance(1000);
  assert.ok(f.writes.some(w=>w.persist&&w.patch.grabStatus?.points===10));
  const before=f.writes.filter(w=>w.persist).length;
  await f.advance(1000);await f.advance(1000);assert.equal(f.writes.filter(w=>w.persist).length,before);
});

test('抢先/过期不是成功，“已抢完”不是本账号当日上限',()=>{
  for(const text of ['来晚了，积分已被抢完','没有抢到积分','积分已经过期','今日上限100积分']) {
    const r=parseGrabResult(text);assert.equal(r.success,false);assert.equal(r.full,false,text);
  }
  assert.equal(parseGrabResult('已达上限').full,true);
  assert.equal(parseGrabResult('你今天已经抢满，不能再抢').full,true);
  assert.equal(parseGrabResult('赢得 20 积分').points,20);
  assert.equal(parseGrabResult('操作过于频繁，请稍后再试').limited,true);
});

test('发现表单只计发现：去重、携带隐藏字段、遇上限立刻停止剩余提交',async()=>{
  const c=new FarmClient(null),requests=[];
  const form=(n)=>`<form action='/room/exchangeCard.do?id=${n}&amp;room=696'><input name='nonce' value='example'><input name='is' value='1'></form>`;
  c.req=async(url,opts)=>{requests.push({url,opts});return requests.length===1?form(1)+form(1)+form(2)+form(3):requests.length===2?'来晚了，已被抢完':'你今天已达上限';};
  const r=await c.grabRoomCards(696);assert.equal(r.found,3);assert.equal(r.attempted,2);assert.equal(r.claimed,0);assert.equal(r.full,true);assert.equal(requests.length,3);
  assert.equal(new URLSearchParams(requests[1].opts.body).get('nonce'),'example');
});

test('真实提示页隔离导航；下手慢和单轮限制不会当成今日满额',async()=>{
  const page=msg=>`<title>聊室</title><nav>首页 市场活动</nav><!-- 已达上限 --><h3>提示</h3><p>${msg}</p><a>返回聊室</a><footer>用户获得999积分</footer>`;
  const lost=parseGrabResult(page('衰,下手慢了,下轮再继续吧!'));
  assert.equal(lost.message,'下手慢了,下轮再继续吧!');assert.equal(lost.success,false);assert.equal(lost.full,false);assert.equal(lost.points,0);
  const once=parseGrabResult(page('敲!一轮游戏只能参与一次呢,下轮再继续吧!'));
  assert.equal(once.message,'一轮游戏只能参与一次呢,下轮再继续吧!');assert.equal(once.roundComplete,true);assert.equal(once.full,false);assert.equal(once.success,false);
  assert.equal(parseGrabResult(page('恭喜你获得50积分')).points,50);
  const c=new FarmClient(null);let requests=0;
  c.req=async()=>++requests%2===1?'<form action="exchangeCard.do?id=1"></form><form action="exchangeCard.do?id=2"></form>':page('敲!一轮游戏只能参与一次呢,下轮再继续吧!');
  assert.equal((await c.grabRoomCards()).attempted,1);assert.equal(requests,2);
  assert.equal((await c.grabRoomCards()).full,false);assert.equal(requests,4);
});

test('房间普通聊天不能标记抢满；取消后不提交；部分成功后网络错误保留积分',async()=>{
  const c=new FarmClient(null);c.req=async()=>'<p>聊天：我今日已达上限</p>';assert.equal((await c.grabRoomCards()).full,false);
  c.req=async()=>'<title>温馨提示</title><p>你今天已达上限</p>';assert.equal((await c.grabRoomCards()).full,true);
  let active=true,n=0;c.req=async()=>{n++;active=false;return '<form action="exchangeCard.do?id=1"></form>';};await c.grabRoomCards(696,{shouldContinue:()=>active});assert.equal(n,1);
  n=0;c.req=async()=>{if(++n===1)return '<form action="exchangeCard.do?id=1"></form><form action="exchangeCard.do?id=2"></form>';if(n===2)return '获得10积分';throw Error('timeout');};
  await assert.rejects(c.grabRoomCards(),e=>e.grabProgress.points===10&&e.grabProgress.claimed===1&&e.grabProgress.attempted===2);
});
