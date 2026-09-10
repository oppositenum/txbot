// 只把网站明确确认的奖励计为成功；“发现表单”和“被别人抢完”都不是抢到。
const plainText = html => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function parseGrabResult(html) {
  const text = plainText(html);
  // 网站提示页带完整导航和用户页脚，先隔离真正的操作结果再判定。
  const notice = text.split(/(?:温馨提示|操作提示|提示信息|(?:^|\s)提示(?=\s|[：:]))[：:]?\s*/).at(-1)
    .split(/返回聊天室|返回聊室|返回房间|聊天室首页|心动聊吧首页|在线名单|聊天记录/)[0].trim();
  const roundComplete = /一轮游戏只能参与一次|本轮.{0,8}已(?:经)?参与/.test(notice);
  const full = !roundComplete && /已(?:经)?(?:达|达到).{0,8}上限|(?:今日|今天|当天).{0,25}(?:抢满|已满|不能再抢|不可再抢)|(?:积分|字卡).{0,10}已抢满/.test(notice);
  const rejected = roundComplete || /失败|未抢到|没(?:有)?抢到|来晚了|下手慢了|已被抢|已抢完|不存在|已过期|已经过期|已被领完/.test(notice);
  const limited = /操作.{0,8}频繁|请求.{0,8}频繁|访问.{0,8}频繁|请稍后再试/.test(notice);
  const reward = notice.match(/(?:赢得|获得|得到|抢到)(?:了)?[：:\s]*(\d+)\s*(?:个)?\s*积分/);
  const success = !rejected && !limited && !!(reward || /兑换成功|成功抢到|抢到(?:了)?(?:\d+张|一张)?字卡/.test(notice));
  const marker = notice.search(/赢得|获得|得到|抢到|成功|已达|已经达到|今日|今天|失败|来晚|下手慢了|一轮游戏|本轮|操作|请求|访问|温馨提示/);
  const message = notice.slice(Math.max(0, marker), Math.max(0, marker) + 180).trim();
  return { success, points: success && reward ? Number(reward[1]) : 0, full, limited, roundComplete, message: message || '未确认领取结果' };
}

module.exports = { parseGrabResult };
