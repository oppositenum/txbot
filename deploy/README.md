# 部署 / 开机自启

三平台都推荐先用 **PM2**（最省事，跨平台统一）；需要系统级服务再用各平台原生方案。

## PM2（Linux / macOS / Windows 通用）

```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # 按提示复制执行返回的命令，实现开机自启
```
常用：`pm2 logs txbot`、`pm2 restart txbot`、`pm2 stop txbot`、`pm2 delete txbot`

---

## Linux · systemd

见 `deploy/txbot.service`，改好路径后：
```bash
sudo cp deploy/txbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now txbot
systemctl status txbot
journalctl -u txbot -f          # 实时日志
```

## macOS · launchd

见 `deploy/com.txbot.plist`，改好路径后：
```bash
cp deploy/com.txbot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.txbot.plist
launchctl start com.txbot
tail -f /tmp/txbot.log
```

## Windows · nssm（注册为 Windows 服务）

[下载 nssm](https://nssm.cc/download)，解压后管理员命令行：
```cmd
nssm install txbot
```
在弹出的界面填：
- **Path**：`node` 的完整路径（`where node` 查，如 `C:\Program Files\nodejs\node.exe`）
- **Startup directory**：项目目录（如 `C:\txbot`）
- **Arguments**：`src\server.js`
- Details 选项卡可设开机自启（默认 Automatic）

然后：
```cmd
nssm start txbot
nssm status txbot
```
卸载：`nssm remove txbot confirm`

### Windows · 任务计划程序（免装 nssm 的简易方案）
任务计划程序 → 创建基本任务 → 触发器选「计算机启动时」→ 操作选「启动程序」→ 程序填 `node`，参数 `src\server.js`，起始于填项目目录。
