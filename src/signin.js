// 各类签到（自动 OCR 验证码）。传入已登录的 FarmClient（其 req 支持绝对 URL）
const { solveCaptcha } = require('./captcha');
const { signinResultText: R, classifyResult } = require('./daily-result');

function terminalResult(key, html) {
  const text = R(html);
  const result = classifyResult(key, text);
  return result.state === 'success' || result.code === 'SIGNIN_MULTI_ACCOUNT' || result.code === 'REQUEST_FAILED' ? text : null;
}

const grab = (html, name) => (html.match(new RegExp(`name=['"]${name}['"][^>]*value=['"]([^'"]*)['"]`)) || html.match(new RegExp(`value=['"]([^'"]*)['"][^>]*name=['"]${name}['"]`)) || [])[1];
const imgid = (html) => (html.match(/fltregimg\.jsp\?imgid=(\d+)/) || [])[1];

// 农场每日签到：verification.do → gift.do
async function farmSignin(c) {
  const v = await c.req('https://tx.com.cn/plugins/farm/cs/verification.do');
  const terminal = terminalResult('farmSignin', v);
  if (terminal) return terminal;
  const regkey = grab(v, 'regkey');
  if (!regkey) return '未找到签到入口，无法确认是否已签';
  const code = await solveCaptcha(imgid(v) || regkey);
  return R(await c.req('https://tx.com.cn/plugins/farm/cs/gift.do', { method: 'POST', body: `regkey=${regkey}&authnum=${code}` }));
}

// 群组签到：summation.do → summationresult.do
async function groupSignin(c) {
  const g = await c.req('https://tx.com.cn/myroom/visitor/cs/summation.do?appid=1&referer=zoneIndex');
  const terminal = terminalResult('groupSignin', g);
  if (terminal) return terminal;
  const regkey = grab(g, 'regkey');
  if (!regkey) return '未找到签到入口，无法确认是否已签';
  const is = grab(g, 'is') || '1';
  const code = await solveCaptcha(imgid(g) || regkey);
  return R(await c.req('https://tx.com.cn/myroom/visitor/cs/summationresult.do', { method: 'POST', body: `authnum=${code}&appid=1&referer=zoneIndex&is=${is}&regkey=${regkey}` }));
}

// QQ签到：sign.do（通常无验证码）
async function qqSignin(c) {
  const q = await c.req('https://tx.com.cn/activity/qq/cs/sign.do');
  const terminal = terminalResult('qqSignin', q);
  if (terminal) return terminal;
  let body = 'type=1&confirm=1&authnum=';
  if (/fltregimg/.test(q)) { const rk = grab(q, 'regkey'); body += await solveCaptcha(imgid(q) || rk); if (rk) body += `&regkey=${rk}`; }
  return R(await c.req('https://tx.com.cn/activity/qq/cs/sign.do', { method: 'POST', body }));
}

module.exports = { farmSignin, groupSignin, qqSignin };
