// 每日任务结果：业务失败与 HTTP 请求成功分开；网站限制不能自动重试。
const SIGNIN_KEYS = ['farmSignin', 'groupSignin', 'qqSignin'];
const DAILY_KEYS = [...SIGNIN_KEYS, 'pastureDaily', 'petDaily', 'goldDaily'];
// 使用服务端本地日期，避免 UTC 导致北京时间凌晨误判成昨天。
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const blockedPattern = /系统检测\s*多号刷签到|多号刷签到/;
const failurePattern = /失败|系统检测|验证码.{0,12}(?:错误|不正确|失效|填错)|请稍后再试|操作过于频繁|错误|未成功/;
const successPattern = /签到成功|领取成功|成功签到|成功领取|成功获得|今日奖励你\s*\d+|^成功[!！：:\s]|(?:获得|获赠|得到|领取了)\s*\d|已(?:经)?(?:签到|领取)|(?:今日|今天).{0,12}(?:已签|已领)|明天再来/;

function classifyResult(key, value, error = false) {
  const message = String(value || '未返回结果');
  if (blockedPattern.test(message)) return { state: 'failed', code: 'SIGNIN_MULTI_ACCOUNT', retryable: false, message };
  if (error || failurePattern.test(message)) return { state: 'failed', code: 'REQUEST_FAILED', retryable: true, message };
  if (SIGNIN_KEYS.includes(key) && !successPattern.test(message)) {
    return { state: 'failed', code: 'UNCONFIRMED', retryable: true, message };
  }
  return { state: 'success', code: 'OK', retryable: false, message };
}

function signinResultText(html) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').replace(/\s+/g, ' ').trim();
  // 在截短导航文字前找拒绝原因，避免前面的“积分”等导航把真正失败截掉。
  const excerpt = start => text.slice(start, start + 200).split(/签到排行榜|返回我的农场|你还可以|返回群组首页/)[0].trim();
  const blocked = text.search(blockedPattern);
  if (blocked >= 0) return excerpt(Math.max(0, blocked - 4));
  const failed = text.search(failurePattern);
  if (failed >= 0) return excerpt(failed);
  const success = text.search(successPattern);
  if (success >= 0) return excerpt(success);
  return text.slice(0, 200) || '未返回签到结果';
}

const isBlocked = (acc, key) => acc.status.dailyResults?.[key]?.code === 'SIGNIN_MULTI_ACCOUNT';
const isSettled = (acc, key, today = todayStr()) => isBlocked(acc, key) || acc.status.dailyDone?.[key] === today;

module.exports = { SIGNIN_KEYS, DAILY_KEYS, todayStr, classifyResult, signinResultText, isBlocked, isSettled };
