# Sherlock WebUI

基于 [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock)（MIT）改造的**浏览器版用户名侦查工具**：输入一个用户名，跨数百个社交网站检查该账号是否已被注册，实时查看进度与结果。

上游 sherlock 是纯命令行工具（不监听任何端口），本项目在容器内加了 Web 界面，使其可以通过 `http://<host>:3101` 直接使用。

## 快速部署

```bash
mkdir sherlock-webui && cd sherlock-webui
# 把 docker-compose.yml 放到当前目录
docker compose up -d
```

`docker-compose.yml`（与仓库内一致）：

```yaml
services:
  sherlock:
    container_name: sherlock
    image: ghcr.io/kevinlidk/sherlock-webui
    volumes:
      - ./sherlock/:/opt/sherlock/results/
    ports:
      - "3101:80"
    restart: unless-stopped
    networks:
      - sherlock_network

networks:
  sherlock_network:
    driver: bridge
```

打开 `http://localhost:3101` 即可使用。

- **结果导出**：每次任务完成，JSON / CSV / TXT 三种格式自动写入容器 `/opt/sherlock/results/`，即宿主机 `./sherlock/` 目录，页面内也可直接下载。
- **实时进度**：后端直接调用 sherlock 库函数（20 线程并发探测），前端轮询展示逐站点的结果流。

## 界面功能

- 用户名侦查（支持 sherlock 的 `{?}` 多变体语法，如 `foo{?}bar`）
- 高级选项：每站点超时（默认 15s）、是否包含 NSFW 站点（默认排除）、限定站点白名单
- 进度条 + 逐站点结果流：已命中 / 未注册 / 未知 / 格式不符 / 被 WAF 拦截
- “只看命中”过滤、命中链接直达（新标签页）
- 历史任务（存于内存，默认保留最近 100 条）、结果文件下载、一键重新侦查

## 环境变量（可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SHERLOCK_WEB_USER` / `SHERLOCK_WEB_PASSWORD` | 空 | 两者都设置后启用 HTTP Basic 认证（强烈建议暴露到公网时开启） |
| `SHERLOCK_MAX_CONCURRENT` | `2` | 同时进行的侦查任务数上限 |
| `SHERLOCK_HISTORY_LIMIT` | `100` | 内存中保留的历史任务数 |
| `SHERLOCK_PROXY` | 空 | 让 sherlock 的探测请求走代理，如 `socks5://192.168.1.10:1080` |
| `SHERLOCK_RESULTS_DIR` | `/opt/sherlock/results` | 结果导出目录 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/search` | `{username, timeout?, nsfw?, sites?}` → 创建任务 |
| `GET` | `/api/jobs` | 历史任务列表（摘要） |
| `GET` | `/api/jobs/{id}` | 任务详情（含逐站点结果） |
| `DELETE` | `/api/jobs/{id}` | 删除已完成的历史任务 |
| `GET` | `/api/sites` | 已收录站点清单 |
| `GET` | `/api/results/{file}` | 下载结果文件 |
| `GET` | `/healthz` | 健康检查（免认证） |

## 构建与发布镜像

### 方式一：GitHub Actions 自动发布（推荐）

将本仓库推到 GitHub（仓库名 `kevinlidk/sherlock-webui`），仓库自带 `.github/workflows/docker-publish.yml`：推送到默认分支即自动构建并发布 `ghcr.io/kevinlidk/sherlock-webui:latest`（打 `v*` tag 会额外发布版本号 tag）。首次需在 GitHub 仓库 → Packages 里把镜像设为 Public（或在 compose 所在机器 `docker login ghcr.io` 拉取）。

### 方式二：本地构建推送

```bash
docker build -t ghcr.io/kevinlidk/sherlock-webui:latest .
docker login ghcr.io          # 用户名 kevinlidk，密码用 GitHub PAT（勾选 write:packages）
docker push ghcr.io/kevinlidk/sherlock-webui:latest
```

## 安全说明

- Web 层只接受用户名 / 超时 / 站点过滤三类输入，**服务端代码在运行时零出站请求**（排除清单快照随镜像分发）；所有出站请求都是 sherlock 库对其内置站点清单的用户名探测。
- 结果文件下载接口有文件名白名单 + 路径包含校验，无目录穿越。
- 用户名输入有字符白名单（字母/数字/空格及 `._-~{}?`），库内调用（无 shell、无命令注入面）。
- 服务本身无内置认证，默认面向受信任网络（内网/localhost）；如需暴露公网，务必设置 `SHERLOCK_WEB_USER` / `SHERLOCK_WEB_PASSWORD`。
- 容器以 root 运行（监听 80 端口需要该能力），任务状态存于单进程内存，因此镜像固定 `--workers 1`。

## 与上游的差异

- 新增 `app/`：FastAPI 后端（`main.py` 路由 + `runner.py` 任务管理）与前端单页（原生 JS，无外部 CDN 依赖）。
- 直接进程内调用 `sherlock_project.sherlock.sherlock()`，通过自定义 `QueryNotify` 收集结构化结果；不解析 CLI 文本输出。
- 站点清单使用镜像内置的 `data.json`（离线可用）；上游误报排除清单以**快照形式随镜像分发**（`app/resources/false_positive_exclusions.txt`），运行时零服务端出站请求。上游更新后可手动刷新快照：

  ```bash
  curl -o app/resources/false_positive_exclusions.txt https://raw.githubusercontent.com/sherlock-project/sherlock/refs/heads/exclusions/false_positive_exclusions.txt
  ```
- 上游代码本身未改动，仅作为依赖（`sherlock-project==0.16.2`）安装，后续版本可平移升级。

## 许可

MIT（继承上游 sherlock-project 的 MIT 许可）。
