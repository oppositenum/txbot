# txbot — 天下农场多账号协议托管

tx.com.cn 天下农场的纯协议 bot：不开浏览器，全部游戏操作走 HTTP 请求。支持多账号托管、按账号配置任务、H5 管理面板。

## 运行环境

纯 Node.js，**Linux / Windows / macOS 通用**，唯一要求：**Node.js 20 或更高**（[下载](https://nodejs.org/)）。检查版本：`node -v`。

## 快速开始

**Linux / macOS：**
```bash
./start.sh
```

**Windows：** 双击 `start.bat`，或在命令行运行：
```cmd
start.bat
```

**任意平台（手动）：**
```bash
npm install
npm start
```

启动后终端会打印本机地址和局域网地址。手机/其他设备访问：同一局域网下打开 `http://<本机IP>:8787`。

可用环境变量：`PORT`（默认 8787）、`HOST`（默认 `0.0.0.0` 监听所有网卡；设为 `127.0.0.1` 则仅本机可访问）。
```bash
PORT=9000 npm start          # Linux/macOS
set PORT=9000&& npm start     # Windows cmd
```

## 登录保护

默认**不带任何认证**——只要能连到这个端口，任何人打开网页就能看到并操作你托管的全部账号。局域网内使用、或者对外网开放前，强烈建议设置 `TXBOT_USER` / `TXBOT_PASS` 两个环境变量开启 HTTP Basic Auth（浏览器会弹出系统自带的登录框）：

```bash
TXBOT_USER=admin TXBOT_PASS=你的密码 npm start          # Linux/macOS
set TXBOT_USER=admin&& set TXBOT_PASS=你的密码&& npm start # Windows cmd
```

不设置这两个变量时终端会打印一行警告提醒当前没有登录保护。PM2/systemd/launchd 等常驻方式下，把这两个变量写进对应配置的环境变量里即可（`ecosystem.config.js` 的 `env` 字段、systemd 的 `Environment=`、launchd 的 `EnvironmentVariables`）。

## 后台常驻 / 开机自启

推荐 **PM2**（跨三平台统一方案）：
```bash
npm i -g pm2
pm2 start ecosystem.config.js   # 启动并守护
pm2 logs txbot                  # 看日志
pm2 save && pm2 startup         # 开机自启（按提示执行返回的命令）
```

原生方案（可选）：
- **Linux**：`systemd` 服务，`ExecStart=/usr/bin/node /path/to/txbot/src/server.js`
- **macOS**：`launchd` plist 放 `~/Library/LaunchAgents/`
- **Windows**：`nssm install txbot` 注册为 Windows 服务，或用「任务计划程序」设开机运行 `start.bat`

## 添加账号

管理页点右下角 **+**，两种方式：

**方式一 · 账号密码（推荐）**
直接填天下账号（天下号/手机号/邮箱）+ 密码，点"保存并登录"。系统纯协议登录验证后保存。
**优势：Cookie 失效后系统会用账密自动重新登录，无需人工干预**，真正长期无人值守。

**方式二 · Cookie**
浏览器登录 tx.com.cn → F12 → Network → 任意请求 → 复制整串 `Cookie`（含 `JSESSIONID`）→ 粘贴保存。
Cookie 失效后需手动更新（此模式不能自动重登）。

添加后打开账号卡片右侧开关即开始托管（先立即跑一轮，之后按间隔自动执行）。
账密账号 Cookie 失效时会自动重登；也可随时点卡片上"重新登录"手动刷新。

## 每账号可配置的任务

| 任务 | 默认 | 说明 |
|---|---|---|
| 一键收割 / 一键耕地 / 自动种植 | ✅ | 收→耕→种闭环；种子可选"自动（数量最多）"或指定 |
| 除草 / 杀虫 / 浇水 | ✅ | 一键接口未开通时自动逐块处理 |
| 施肥 | ❌ | 需游戏内花金币开通一键施肥 |
| 友情地收割 | ✅ | 收自己的友情地 |
| 偷好友菜 | ❌ | 按偷菜排行遍历，每轮上限可配 |
| 帮好友护理 | ❌ | 除草/杀虫/浇水，每轮上限可配 |
| 自动全售 | ❌ | 只卖未锁定果实，慎开 |

**多游戏每日任务**（每天自动执行一次）：
| 任务 | 说明 |
|---|---|
| 牧场每日 | 每日大礼包 + 圈舍收获 |
| 宠物每日 | 每日报道津贴 |
| 圣衣每日 | 每日奖励宝箱 |
| 牧场定时收获 | 按间隔巡检收获圈舍 |

## 调度系统（事件驱动 + 负载均衡）

不是傻轮询，而是每账号拆成多个独立 job，各自按需要的时间点唤醒：

- **农场 job**：收割→耕→种→护理后，解析每块地的**成熟倒计时**，把下次唤醒精确设在最近成熟时刻；并设一个**兜底上限**（默认30分钟必查一次），所以别人帮你浇水加速成熟、或作物被偷，最多延迟这个上限就能发现。上限可在「任务配置」调。
- **每日 job**：每天 `dailyStartHour`（默认0点）之后，在错峰范围内随机一个时刻执行所有签到/每日领取；按自然日去重，一天只跑一次。服务中途启动若当天没做过会补做。
- **牧场 job**：按「牧场巡检间隔」定时收获圈舍。

**负载均衡（为大量账号设计）**：全局一个调度循环按到期时间扫描所有 job，受**最大并发账号数**（默认5，「设置」里调）限制地投入执行，超出的排队到下一轮。新账号启动、每日任务都自动错峰，几百个账号也不会同时打请求。请求间隔 ≥1.5 秒，一键种植遵守服务端 10 秒限流。

## 代理

每个账号可在添加/更新凭证时填 **代理**（`http://[user:pass@]host:port`），该账号所有协议请求（含登录、农场、牧场等）都走这个代理。不填则直连。可给不同账号分配不同代理。基于 undici ProxyAgent，支持 http/https 代理。

## 按需调用接口（API）

所有功能都可通过 REST 直接调用，方便你自己组合。农场动作：
```
POST /api/accounts/:id/action   body {"type":"harvestAll"}  # 或 digAll/weedAll/killAll/waterAll/muckAll/sellAll
POST /api/accounts/:id/action   body {"type":"buy","seedsId":46,"num":10}
POST /api/accounts/:id/action   body {"type":"sowFriend","seedsId":103,"landUid":88888888}
```
插件动作（牧场/宠物/圣衣，复用农场登录态）：
```
POST /api/accounts/:id/plugin/pasture  body {"type":"dailyAward"}   # info/harvestAll/feedAll/disinfectAll/cleanAll/harvest
POST /api/accounts/:id/plugin/pet      body {"type":"dailyAllowance"} # info/feed/work/recover
POST /api/accounts/:id/plugin/gold     body {"type":"dailyReward"}   # info/practice/dig
```
完整端点清单见 `FARM_API.md`；客户端实现见 `src/client.js`（农场）和 `src/plugins.js`（牧场/宠物/圣衣）。

## 手动操作控制台

账号卡片 → **详情/操作**，是一个多标签控制台，站内功能都能点：

- **农场**：一键收/耕/除草/杀虫/浇水/施肥/全锁/全售/签到；下方子标签：
  - 土地：每块地单独收割/浇水/施肥
  - 种子袋：选数量一键种植
  - 仓库：果实出售 / 锁定解锁
  - 商店：分档浏览、输入数量购买
  - 任务：查看日常/随机任务，确认后上交
  - 偷菜：偷/除草/杀虫/浇水各排行榜好友
  - 功能：地卡使用、开通一键施肥/浇水/锁定
- **牧场**：状态一览 + 每日礼包 / 一键收获 / 逐舍收获 / 喂养 / 打针 / 洗澡 / 催肥 / 育儿
- **宠物**：状态 + 每日津贴 / 喂食 / 劳动 / 照顾恢复
- **圣衣**：状态 + 每日奖励 / 修炼 / 搜寻打怪
- **日志**：该账号实时运行日志

**签到**有图片验证码，点"签到"弹出验证码图片人工输入即可领取。

## 结构

```
src/client.js       FarmClient：全部协议接口封装 + HTML 解析 + 账密登录
src/scheduler.js    多账号调度循环 + Cookie 失效自动重登
src/store.js        data/accounts.json 持久化
src/server.js       Express API + 静态页
web/index.html      H5 管理面板（单文件，无构建）
start.sh/start.bat  跨平台启动脚本
ecosystem.config.js PM2 守护配置
FARM_API.md         完整协议分析文档
probe/              接口探索脚本与抓包存档（运行时不需要）
```

## 注意

- `data/accounts.json` 存有各账号 Cookie **和账号密码明文**，务必勿外泄（生产可自行加密该文件）
- 运行时不依赖浏览器/Playwright（`probe/` 里的探测脚本才需要，已列入 devDependencies）
- 任务上交、摊位摆摊、预售、土地升级等接口已在 FARM_API.md 记录，可按需扩展到调度器
