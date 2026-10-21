// 验证码 OCR 识别（第三方服务）
const OCR_BASE = process.env.TXBOT_OCR || 'https://ocr.xb-22.com/ocr';

// 识别 tx.com.cn 验证码图片，返回识别到的数字串
async function solveCaptcha(imgid) {
  const imgUrl = `https://tx.com.cn/in/fltregimg.jsp?imgid=${imgid}`;
  const r = await fetch(`${OCR_BASE}?url=${encodeURIComponent(imgUrl)}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('OCR服务返回 ' + r.status);
  const txt = (await r.text()).trim();
  let raw = txt;
  try {
    const body = JSON.parse(txt);
    if (body && body.result != null) raw = String(body.result);
  } catch (_) { /* 兼容旧版纯文本 */ }
  const code = (String(raw).match(/\d{4,6}/) || [])[0] || String(raw).replace(/[^0-9]/g, '');
  if (!code) throw new Error('OCR未识别出验证码: ' + txt.slice(0, 40));
  return code;
}

module.exports = { solveCaptcha };
