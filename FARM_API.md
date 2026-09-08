# 天下网农场 (tx.com.cn) 协议分析

> 2026-09-07 实测。所有接口均为纯 HTTP 调用验证通过，无需浏览器。

## 结论

**可以完全用纯协议实现。** 农场是 2000 年代 WAP 风格的服务端渲染 HTML 应用：
- 无 Flash / 无 canvas / 无 iframe / 无前端 JS 逻辑
- 无签名、无时间戳、无加密参数
- 鉴权只靠 Cookie（核心是 `JSESSIONID`，辅以 `txuid`、`txEncodeUid`）
- 部分链接带 `z=` 参数（会话内固定，可从任意页面 HTML 中正则提取，如 `z=)422xUYNUN`）
- 响应是 HTML，需正则/解析器提取状态（土地、成熟时间、结果提示）

## 基础

- Base URL: `https://tx.com.cn/plugins/farm/cs/`
- 请求头：`Cookie` + 正常浏览器 `User-Agent`（建议带 `Referer`）
- 已知服务端限流：一键种植需间隔 10 秒（响应文本中明示）

## 接口清单

### 查询（GET，返回 HTML）
| 功能 | 路径 |
|---|---|
| 农场首页/土地列表 | `index.do?pn=页码`（每页5块地，共12页） |
| 种子袋 | `myBag.do?keySow=1&pn=页码` |
| 果实仓库 | `myStore.do` |
| 道具 | `myTools.do` |
| 金币 | `myCoin.do` |
| 等级信息 | `myInfo.do` |
| 种子详情 | `seedsInfo.do?seedsId=X` |

土地状态解析要点（index.do）：
- 可收割：`harvest.do?landId=(\d+)` 链接存在
- 未成熟：文本形如 `14小时23分钟后成熟`
- 地块名：`黑土地N` / `土地N`，作物名和星级在括号内

### 操作（实测通过 ✅）
| 功能 | 请求 | 实测响应 |
|---|---|---|
| 单地收割 | `GET harvest.do?landId=X` | ✅ "果实收获了,获得经验+180点" |
| 一键收 | `GET harvestAll.do?z=TOKEN` | 同类 |
| 一键耕 | `GET digLands.do?z=TOKEN` | ✅ "成功耕地1块!获得经验+2点" |
| 一键种 | `POST sowSeedsAll.do?seedsId=X`，body `num=数量` | ✅ "成功种植了1粒夏枯草种子!"（限10秒/次） |
| 一键除草 | `GET weedingAll.do?z=TOKEN` | 未测，同构 |
| 一键杀虫 | `GET killInsectsAll.do?z=TOKEN` | 未测，同构 |
| 一键浇水 | `GET waterAll.do?z=TOKEN` | 未测，同构 |
| 一键施肥 | `GET muckAll.do?z=TOKEN` | 未测，同构 |

已知 seedsId：杜仲=95，夏枯草=103，风流果=10032，六月雪=10025，夕颜花=10035

### 好友互动（实测通过 ✅）
| 功能 | 请求 | 说明 |
|---|---|---|
| 偷菜排行 | `GET rank.do?oper=N` | 0偷菜/1杂草/2害虫/3浇水，翻页 `&order=2&oper=4&pn=N` |
| 好友农场 | `GET index.do?uid=X`，翻页 `myLand.do?uid=X&flag=0&pn=N` | 含可偷/可护理链接 |
| 偷菜 | `GET steal.do?landId=X&tuid=UID` | ✅ "你成功偷走1个兰花" |
| 浇水 | `GET water.do?landId=X&tuid=UID` | ✅ 自己的地 tuid=自己uid，同一接口 |
| 除草/杀虫 | `weeding.do` / `killInsect.do?landId&tuid` | 页面出现时链接同构 |
| 友情地收割 | `GET harvestFriendLand.do?landId=X` | ✅ 实测通过 |
| 友情地种植 | `cropsInfo.do?uid&landId&seedsId&action=sow` | |

### 商店/仓库/道具（表单已解析）
| 功能 | 请求 |
|---|---|
| 商店列表 | `GET shop.do?category=0&lv=N&pn=N`（category=1礼物种子；landList.do土地；tools.do道具；paySeeds.do魔种） |
| 买种子 | `POST buySeeds.do?seedsId=X`，body `num=N&z=TOKEN`（也有 GET 快捷链接） |
| 卖果实 | `POST sales.do`，body `num=N&seedsId=X&z=TOKEN` |
| 全售 | `GET salesAll.do`（只卖未锁定） |
| 锁定/解锁 | `GET lock.do?seedsId=X&lock=0锁/1解`、`lockAll.do?lock=1/0` |
| 道具列表 | `GET myTools.do`（肥料toolsId=1/2、经验卡7、杀虫剂8、除草剂9） |
| 使用道具 | `GET useTools.do?landId=X&toolsId=Y&tuid=0` |

### 任务/签到/其他
| 功能 | 请求 |
|---|---|
| 任务列表 | `GET taskOrders.do` → `orderInfo.do?taskId=X`（含需求/库存/一键种植链接） |
| 签到 | `GET verification.do`（图片验证码+regkey）→ `POST gift.do`，body `regkey=X&authnum=4位码` ⚠️需人工识别 |
| 土地升级 | `upLandInfo.do?landId=X`、黑土地合并 `upLand.do` |
| 一键功能开通 | `openFun.do?actionId=N`（5浇水/6施肥/7锁定/8禁施肥），`exp2All.do`/`coin2All.do` 地卡 |
| 农场动态 | `farmRadio.do`、`moreRadio.do?uid=X` |
| 摊位/预售 | `stallMy.do`、`salesGoods.do?goodsId&type`、`futuresSell.do?goodsId&type`、`stallList.do?stype=1` |
| 协议登录 | ✅ 已实现纯协议账号密码登录（见下） |

### 账号密码登录（实测通过 ✅ 纯协议）

密码**明文**提交、**无验证码**、**无 JS 加密**。关键：登录前必须走完浏览器的「Cookie 支持检测」预热链，否则服务端把 POST 打回 `pcCookieCheck`，密码验证结果不入 session。

完整流程（同一 Cookie jar 贯穿）：
1. `GET /in/fltin_t.jsp?z=900000019&type=login` — 拿初始 Cookie
2. 补上百度统计 Cookie（`Hm_lvt_*` / `Hm_lpvt_*` / `HMACCOUNT`，浏览器由 JS 设置，服务端 Cookie 检测会校验回传；用时间戳/随机 hex 伪造即可）
3. `GET /in/login.do?kid=&type=passwdforward&cfrom=tx` — 跟随 302 → `pcCookieCheck.do` → `in/login.do?kid=`，完成 Cookie 检测预热
4. `POST /in/cs/login.do?type=passwd`
   - Header：`Origin: https://tx.com.cn`，`Referer: https://tx.com.cn/in/login.do?kid=`
   - Body：`useruid=账号&password=明文密码&kid=&hidden=`
   - 成功直接返回 200（无重定向），Set-Cookie 下发 `txuid`、`txEncodeUid`
5. 成功判据：Cookie jar 出现 `txuid`

实现见 `src/client.js` 的 `FarmClient.login(useruid, password)`。Cookie 失效时调度器会自动用保存的账密重登（`scheduler.js` 的 `relogin`）。

## Bot 实现建议

1. 登录态：从浏览器导出 Cookie（本目录 `cookies.json`），或做协议登录（登录接口未分析）
2. 会话保活：定期 GET `index.do`；`JSESSIONID` 失效则需重新登录
3. 主循环：拉 `index.do?pn=1..12` → 解析每块地状态 → 收割/耕地/种植/护理 → 遵守 10 秒限流
4. z token：启动时从 `index.do` HTML 里 `z=([^"'&]+)` 提取一次即可

---

# 其他插件（牧场 / 宠物 / 圣衣）— 2026-09-08 实测

所有插件共用同一登录态（同一 Cookie jar，账密登录后即可访问全站）。实现见 `src/plugins.js`。

## 天下牧场  base `/plugins/pasture/cs/`
| 功能 | 请求 | 实测 |
|---|---|---|
| 牧场首页/圈舍 | `index.do`（`harvest.do?id=X` 为可收获舍） | ✅ |
| 每日登录大礼包 | `getAward.do` | ✅ "恭喜你获得500开心币" |
| 单个收获 | `harvest.do?id=X` | ✅ "收获了15匹马…" |
| 一键饲养/喂食 | `oneKeyFeed.do` | ✅（需狗狗学技能） |
| 一键打针 | `disinfectAll.do` | ✅（需技能） |
| 一键洗澡 | `cleanAll.do` | ✅（需技能） |
| 一键收获 | `harvestAll.do` | ✅（需技能） |
| 一键催肥/催情 | `oneKeyChuiQing.do?toolid=2` | 端点确认 |
| 一键育儿 | `oneKeyYuer.do?toolid=82` | 端点确认 |
| 仓库/神殿/配种/母舍/公舍 | `myStores.do` / `altar.do` / `mate.do` / `listFemale.do` / `myMales.do` | |
| 串门(偷) | `index.do?uid=好友uid` | |

## 幻宠乐园（宠物）  base `/plugins/pet2/cs/`
所有页面带 `?tpi=0`。
| 功能 | 请求 | 实测 |
|---|---|---|
| 宠物首页 | `fossa.do` | ✅ |
| 每日报道津贴 | `allowance.do?tpi=0`（直接领取） | ✅ "你今天已经领过了" |
| 喂食 | `eatLink.do?tpi=0&z=TOKEN` | 端点确认 |
| 劳动/照顾/培养/技能 | `work.do` / `care.do` / `train.do` / `skill.do` | |
| 仓库/任务/商店/市场/串门 | `store.do` / `task.do` / `shop.do` / `stall.do` / `relate.do` | |

## 黄金圣衣  base `/plugins/gold/cs/`
| 功能 | 请求 | 实测 |
|---|---|---|
| 圣衣首页 | `index.do` | ✅ |
| 每日奖励(宝箱) | `chestsTask.do` 找 `chestsOpen.do?chestsId=X` 开箱 | ✅ "今日无可开宝箱" |
| 修炼 | `practiceMess.do` | 端点确认 |
| 搜寻/打怪 | `areaDig.do?digType=2/5` | 端点确认 |
| 熔炼/竞技/圣殿/通天塔 | `smeltingGoods.do` / `arenaInfo.do` / `sanctury.do` / `tower.do` | |
| 圣衣/仓库/商店/市场/任务 | `cloth.do` / `box.do` / `shopList.do` / `tradeList.do` / `chestsTask.do` | |

## 各类签到/每日领取汇总
| 位置 | 端点 |
|---|---|
| 农场每日报道 | `verification.do`(验证码) → `POST gift.do` regkey+authnum |
| 牧场每日大礼包 | `getAward.do` |
| 宠物每日津贴 | `allowance.do?tpi=0` |
| 圣衣每日宝箱 | `chestsTask.do` → `chestsOpen.do?chestsId=X` |
| 空间/QQ签到 | `/activity/qq/cs/sign.do` |

## 补充：农场其余端点
| 功能 | 请求 |
|---|---|
| 使用道具 | `useTools.do?landId=X&toolsId=Y&tuid=0`（1普通肥/2强力肥/7双倍经验/8杀虫剂/9除草剂）✅ |
| 单地施肥 | = useTools toolsId=1/2 ✅ |
| 赠送道具 | `proxy.do?toolsId=X&friendId=Y` |
| 好友友情地种植 | `sowFriendSeeds.do?landId=0&seedsId=X&landUid=好友uid` ✅ "种植成功" |
| 摆摊出售 | `POST salesGoods.do` body `nums&price&pwd&goodsId&type=1&confirm=1` |
| 换季节 | `changeSeason.do?season=1春/3秋/4夏&landId=X`（2万金币） |
| 特殊地(草园/市花) | `toSpecialLand.do?sowSpecial=1/2&landId=X`（3万金币） |
| 三倍经验地卡 | `exp2All.do?z=TOKEN` |
| 十倍金币地卡 | `coin2All.do?z=TOKEN` |
| 开通一键功能 | `openFun.do?actionId=5浇水/6施肥/7锁定/8禁被施肥` |
| 任务上交 | 库存≥需求时 `orderInfo.do` 出现上交按钮（消耗性，"同人多号做任务会清全仓"，谨慎） |
| 摊位搜索 | `stallSearch.do?stype=1&skey=物品id` |
| 预售市场 | `futuresRank.do`、`futuresMyBuy.do`、`futuresMySell.do` |
