# GitHub Actions 构建并发布 Docker Hub

流程文件：`.github/workflows/dockerhub.yml`。使用 GitHub 托管的 Ubuntu runner，无需自建 runner，也不依赖本机 Docker、代理或 registry.xb-22.com。

## 一次性配置

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

## 触发方式和标签

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

## 服务器使用

```bash
# 替换为自己的 Docker Hub 用户名或组织名；私有仓库先执行 docker login。
docker pull yourname/txbot:latest
# 固定版本示例：
docker pull yourname/txbot:v1.2.3
```

使用此前的 Docker Compose 部署包时，将服务的 `image` 改为：

```yaml
image: yourname/txbot:${TXBOT_IMAGE_TAG:-latest}
```

并将部署目录 `.env` 中原有的 `TXBOT_IMAGE_TAG=20260910-e72199c` 改成 Docker Hub 实际发布的标签，例如 `latest`、`v1.2.3` 或 `sha-<完整提交SHA>`。原私有仓库的版本标签不会自动复制到 Docker Hub。之后执行：

```bash
docker compose pull
docker compose up -d
```

保留原有数据卷、登录配置和时区即可。构建镜像不包含本机账号数据或凭证。
