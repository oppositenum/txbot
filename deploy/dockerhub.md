# Docker 部署与 Docker Hub 自动发布

**直接使用程序，只需要 Docker，无需下载源码、安装 Node.js 或配置 GitHub Actions。** 已发布镜像：[myuwhn/txbot](https://hub.docker.com/r/myuwhn/txbot)，支持 Linux amd64 和 arm64，Docker 会自动选择当前机器的架构。

## 拉取镜像并启动

以下命令适用于 Linux 或 macOS 的终端（Bash / zsh）。服务器需安装并启动 Docker；macOS 可使用 Docker Desktop。

先拉取镜像：

```bash
docker pull myuwhn/txbot:latest
```

如提示需要认证，先执行 `docker login` 登录有权限的 Docker Hub 账号，再重新拉取。

**将下面的 `替换成你的登录密码` 改成自己的管理页面密码，再复制执行整段启动命令：**

```bash
docker run -d \
  --name txbot \
  --restart unless-stopped \
  -p 8787:8787 \
  -e TZ=Asia/Shanghai \
  -e TXBOT_USER=admin \
  -e TXBOT_PASS='替换成你的登录密码' \
  -v txbot-data:/app/data \
  myuwhn/txbot:latest
```

行尾的 `\` 表示命令换行，复制时需保留，且 `\` 后不要再添加空格或注释。用户名和密码不要包含冒号；示例使用单引号包裹密码，密码若含单引号则需使用正确的 Shell 转义。

### 每个参数是什么意思

| 参数 | 作用 | 需要改吗 |
|---|---|---|
| `docker run -d` | 创建并在后台运行容器；关闭终端后程序继续运行 | 保留即可 |
| `--name txbot` | 将容器命名为 `txbot`，便于查看日志、停止和重启 | 通常保留；改名后，后文命令也要使用新名称 |
| `--restart unless-stopped` | 程序退出后自动重启，Docker 服务启动后也会恢复；手动停止的容器除外 | 建议保留 |
| `-p 8787:8787` | 左边是服务器访问端口，右边是容器内程序端口 | 左边可改；例如 `18787:8787`，浏览器就访问 `18787` |
| `-e TZ=Asia/Shanghai` | 使用北京时间计算每日任务和抢积分开始时间 | 默认保留 |
| `-e TXBOT_USER=admin` | 设置管理页面的登录用户名 | 可以改成自己的用户名 |
| `-e TXBOT_PASS='替换成你的登录密码'` | 设置管理页面的登录密码 | **必须改成自己的密码** |
| `-v txbot-data:/app/data` | 将账号、任务配置和状态保存在名为 `txbot-data` 的持久化数据卷中 | 升级、重建容器时保持卷名不变 |
| `myuwhn/txbot:latest` | 使用 Docker Hub 发布的最新镜像 | 可换成已发布的固定版本或提交号标签 |

`TXBOT_USER` / `TXBOT_PASS` 是 **txbot 管理页面的登录凭证**，不是 Docker Hub 账号，也不是天下游戏账号。

## 打开管理页面并添加账号

- 部署在服务器上：浏览器打开 `http://服务器IP:8787`。
- 部署在本机：打开 [http://localhost:8787](http://localhost:8787)。
- 如果左侧映射端口改成了 `18787`，上面的访问地址也要使用 `18787`。

浏览器会弹出登录框：用户名填写启动命令中的 `TXBOT_USER`（示例为 `admin`），密码填写自己设置的 `TXBOT_PASS`。

镜像首次启动没有托管账号。在管理页点击右下角 **+** 添加天下账号或 Cookie，设置任务后打开账号开关，才会开始托管。本机原来运行的账号不会自动迁移到新容器；同一批账号转到 Docker 托管前，先停止旧实例，避免重复执行任务。

## 查看状态、日志和启停

```bash
# 查看状态：运行中显示 Up，健康检查通过后显示 healthy
docker ps -a --filter name=txbot

# 实时查看最近 100 行日志；按 Ctrl+C 退出查看，不会停止程序
docker logs --tail 100 -f txbot

# 停止 / 再次启动 / 重启现有容器（分别按需要执行）
docker stop txbot
docker start txbot
docker restart txbot
```

容器创建成功后，再次启动使用 `docker start txbot`，不需要重复执行 `docker run`。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 提示容器名 `txbot` 已存在 | 先用 `docker ps -a --filter name=txbot` 查看；已有容器用 `docker start txbot` 启动，升级则按下节重建 |
| 提示端口被占用 | 将 `-p 8787:8787` 改为 `-p 18787:8787`，并使用新端口访问 |
| 容器运行正常，但其他电脑打不开页面 | 检查服务器安全组、防火墙是否放行了宿主机的访问端口；访问地址应使用服务器 IP |
| 页面提示登录或返回 HTTP 401 | 输入启动命令中设置的管理页用户名和密码 |
| 修改密码后仍然使用旧密码 | 环境变量在创建容器时确定；用新密码按下节重建容器，单纯重启不会更新环境变量 |

## 升级镜像并保留账号数据

先拉取新镜像，拉取成功后再停止并删除旧容器：

```bash
docker pull myuwhn/txbot:latest && \
docker stop txbot && \
docker rm txbot
```

然后重新执行上方完整的 `docker run` 命令，使用原来的端口、管理页面用户名和密码，以及 **相同的 `-v txbot-data:/app/data`**。删除容器不会删除这个命名数据卷，账号、配置和任务状态会保留。

**不要删除 `txbot-data` 数据卷。** `docker volume rm txbot-data` 会删除其中的账号数据。需要回退时，将拉取和启动命令中的 `latest` 换成此前已发布的固定标签，例如 `sha-<完整提交SHA>`。

## 已使用 Docker Compose 的部署

使用原有 Compose 部署文件时，将服务的镜像地址改为：

```yaml
image: myuwhn/txbot:${TXBOT_IMAGE_TAG:-latest}
```

将部署目录 `.env` 中的 `TXBOT_IMAGE_TAG` 改为 Docker Hub 已发布的标签，例如 `latest` 或 `sha-<完整提交SHA>`。此前私有仓库的 `20260910-e72199c` 标签不会自动复制到 Docker Hub。保留现有数据卷、登录配置和时区，再执行：

```bash
docker compose pull
docker compose up -d
```

上面的 `docker run` 与 Docker Compose 是两种启动方式，选择一种即可。已有 Compose 部署升级时，应继续使用原来的 Compose 项目和数据卷。

## 维护者：配置 GitHub Actions 自动发布

下面的配置仅供需要自行构建和发布镜像的维护者使用，直接拉取 `myuwhn/txbot` 的使用者可以跳过。

流程文件：`.github/workflows/dockerhub.yml`。使用 GitHub 托管的 Ubuntu runner，无需自建 runner，也不依赖本机 Docker、代理或 registry.xb-22.com。

### 一次性配置

1. 在 Docker Hub 创建 `txbot` 镜像仓库，选择自己需要的公开或私有可见性。
2. 在 Docker 账号设置的 Personal access tokens 中创建一个用于 GitHub Actions 的令牌，赋予 **Read & Write** 权限；不需要 Delete 权限。令牌账号必须有目标仓库的推送权限。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置下表。用户名放在 Variables，令牌放在 Secrets；不要将令牌写进代码、Dockerfile、仓库文件或聊天中。

| 名称 | 类型 | 必填 | 内容 |
|---|---|---|---|
| `DOCKERHUB_USERNAME` | Repository variable | 是 | Docker Hub 登录用户名，例如 `yourname`，不是邮箱 |
| `DOCKERHUB_TOKEN` | Repository secret | 是 | 上面创建的 Docker Hub 访问令牌 |
| `DOCKERHUB_IMAGE` | Repository variable | 否 | 默认 `<DOCKERHUB_USERNAME>/txbot`；组织仓库可填 `yourorg/txbot`，全小写，不带 `docker.io/` 或标签 |

本仓库的配置入口：

- Variables：https://github.com/oppositenum/txbot/settings/variables/actions
- Secrets：https://github.com/oppositenum/txbot/settings/secrets/actions
- Actions：https://github.com/oppositenum/txbot/actions
- Docker 访问令牌说明：https://docs.docker.com/security/access-tokens/

仓库必须允许 GitHub Actions，以及 `actions/*`、`docker/*` 的官方 Actions；流程仅需要 GitHub `contents: read` 权限，Docker Hub 推送使用单独的访问令牌。所有外部 Actions 均固定到已核对的版本提交。

### 触发方式和标签

将 Dockerfile、.dockerignore、流程和本文档提交并推送到 GitHub 的 `main` 后，流程才会出现在远端并自动执行。

| 触发 | 验证 | 发布的镜像标签 |
|---|---|---|
| 推送到 `main` | 测试、构建、隔离容器检查 | `latest` 和 `sha-<完整提交SHA>` |
| 推送 `v*` 标签，例如 `v1.2.3` | 同上 | `v1.2.3` 和 `sha-<完整提交SHA>` |
| Actions → Build & Publish Docker Hub → Run workflow，选择 `main` | 同上 | `latest` 和 `sha-<完整提交SHA>` |
| 向 `main` 提交 Pull Request | 同上 | 不登录 Docker Hub、不发布 |
| 手动选择其他普通分支 | 同上 | 不发布 |

版本标签发布不会覆盖 `latest`；`latest` 始终由 `main` 发布更新。两个架构使用同一个镜像标签，Docker 会按机器架构自动选择。原有二进制发布流程保持独立，因此推送 `v*` 标签会同时触发二进制和 Docker 两个流程。

验证阶段使用 Node.js 24 运行项目测试，构建 Linux amd64 镜像，并在无外网、空数据的容器内检查页面、登录保护、数据写入、普通用户、北京时间和运行依赖。验证成功后才执行 Docker Hub 登录，通过 QEMU/Buildx 构建并发布 Linux amd64、arm64 镜像。GitHub 流程不执行真实账号托管任务；arm64 的持续发布步骤负责构建，本地首次容器验证记录见此前 Docker 交付结果。

首次配置完成后，可从 Actions 手动运行一次。成功后在运行 Summary 中查看完整镜像标签、摘要和架构。缺少用户名或令牌时，发布步骤会明确报错；配置好后重新运行即可。
