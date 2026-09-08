// 各类签到（自动 OCR 验证码）。传入已登录的 FarmClient（其 req 支持绝对 URL）
const { FarmClient } = require('./client');
const { solveCaptcha } = require('./captcha');
const R = FarmClient.resultText;
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

const grab = (html, name) => (html.match(new RegExp(`name=['"]${name}['"][^>]*value=['"]([^'"]*)['"]`)) || html.match(new RegExp(`value=['"]([^'"]*)['"][^>]*name=['"]${name}['"]`)) || [])[1];
const imgid = (html) => (html.match(/fltregimg\.jsp\?imgid=(\d+)/) || [])[1];

// 农场每日签到：verification.do → gift.do
async function farmSignin(c) {
  const v = await c.req('https://tx.com.cn/plugins/farm/cs/verification.do');
  const regkey = grab(v, 'regkey');
  if (!regkey) return '无需签到或已签';
  const code = await solveCaptcha(imgid(v) || regkey);
  return R(await c.req('https://tx.com.cn/plugins/farm/cs/gift.do', { method: 'POST', body: `regkey=${regkey}&authnum=${code}` }));
}

// 群组签到：summation.do → summationresult.do
async function groupSignin(c) {
  const g = await c.req('https://tx.com.cn/myroom/visitor/cs/summation.do?appid=1&referer=zoneIndex');
  const gt = strip(g);
  if (/已.*领取|已签到|明天再来|今日已/.test(gt)) return '今日已签';
  const regkey = grab(g, 'regkey');
  if (!regkey) return '无签到入口';
  const is = grab(g, 'is') || '1';
  const code = await solveCaptcha(imgid(g) || regkey);
  const res = strip(await c.req('https://tx.com.cn/myroom/visitor/cs/summationresult.do', { method: 'POST', body: `authnum=${code}&appid=1&referer=zoneIndex&is=${is}&regkey=${regkey}` }));
  const i = res.search(/成功|获得|失败|错误|验证码|已签/);
  return i >= 0 ? res.slice(i, i + 60).trim() : '已提交';
}

// QQ签到：sign.do（通常无验证码）
async function qqSignin(c) {
  const q = await c.req('https://tx.com.cn/activity/qq/cs/sign.do');
  const qt = strip(q);
  if (/已.*领取|已签到|今日已/.test(qt)) return '今日已签';
  let body = 'type=1&confirm=1&authnum=';
  if (/fltregimg/.test(q)) { const rk = grab(q, 'regkey'); body += await solveCaptcha(imgid(q) || rk); if (rk) body += `&regkey=${rk}`; }
  const res = strip(await c.req('https://tx.com.cn/activity/qq/cs/sign.do', { method: 'POST', body }));
  const i = res.search(/成功|获得|积分|失败|已领|已签/);
  return i >= 0 ? res.slice(i, i + 60).trim() : '已提交';
}

module.exports = { farmSignin, groupSignin, qqSignin };
