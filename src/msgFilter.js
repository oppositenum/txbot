// 好友留言骚扰内容判定：纯本地规则，不调用任何AI接口。
// 用真实账号(3777)的历史留言做过标注测试：纯色情词库只能命中约1/4，
// 发件人会用"插空格"(做 爱)、同音字替换(做 哎)、纯口语脏话(日逼/爱爱)、
// 不带脏字的软性招嫖话术(语音或者视频玩吗/两个男的伺候你)规避——
// 所以判定分三层：内容关键词 + 发件人昵称信号 + 招嫖话术短句，任一命中即判定。
// 命中一次的发件人 uid 记入"惯犯名单"(settings.msgOffenders)，以后这人发的
// 任何消息（哪怕单看内容很正常，比如"最近忙吗宝贝"）都直接判定，不必每次都命中关键词。

// 消息正文里常见的插字规避符号，比对前先去掉
function normalize(s) {
  return String(s || '').replace(/[\s·.,，。、~!！?？…]/g, '');
}

// 显式色情描写/脏话（已包含同音字替换的常见变体，如"做哎"）
const EXPLICIT_KW = [
  '做爱', '做哎', '抽插', '阴唇', '骚逼', '骚货', '鸡巴', '小穴', '肉穴', '浪叫',
  '光着身子', '呻吟', '高潮', '插到底', '用力插', '强吻', '咪咪头', '爱抚', '操你',
  '插入你', '脱了衣服', '打炮', '啪啪', '日逼', '日你', '爱爱', '摸吗', '射你',
  '叫爸爸', '奶大', '骚水', '开苞', '潮吹', '内射',
];
// 昵称本身就是招嫖/挑逗类信号
const SUS_NAME = [
  '爱搭子', '寻女', '找美女', '粗鲁调教', '刺激的粗鲁', '酥麻', '腹肌你想摸',
  '进出的', '喜欢眼镜反差', '慢慢地进入', '不停的干', '日逼', '约炮', '包养',
];
// 短句招嫖/开车话术（本身不带脏字，但结合语境是骚扰搭讪）
const SOLICIT_PHRASE = [
  '视频玩吗', '两个男的', '伺候你', '不能说的秘密', '刺激的游戏', '新鲜的玩法',
  '喝酒吗', '聊天喝酒', '爱爱吗', '爱爱丫头', '好想日', '你嗨有无湿', '日你',
  '语音聊', '裸聊', '一夜情', '开房吗',
];

/**
 * 判定一条留言是否是骚扰内容。
 * @param {string} body 留言正文
 * @param {string} fromName 发件人昵称
 * @param {boolean} isKnownOffender 该发件人 uid 是否已在惯犯名单里
 */
function classify(body, fromName, isKnownOffender) {
  if (isKnownOffender) return { suspicious: true, matched: ['惯犯名单'] };
  const norm = normalize(body);
  const nameNorm = normalize(fromName);
  const matched = [
    ...EXPLICIT_KW.filter((k) => norm.includes(k)),
    ...SUS_NAME.filter((k) => nameNorm.includes(k)),
    ...SOLICIT_PHRASE.filter((k) => norm.includes(k)),
  ];
  return { suspicious: matched.length > 0, matched };
}

module.exports = { classify, normalize, EXPLICIT_KW, SUS_NAME, SOLICIT_PHRASE };
