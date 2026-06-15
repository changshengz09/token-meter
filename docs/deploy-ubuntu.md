# New API — Ubuntu 裸机部署手册（非 Docker）

> 适用于：Ubuntu 20.04 / 22.04 / 24.04 LTS（amd64）
> 本手册基于当前源码实测编写。后端为 Go 单一可执行文件，前端构建后已通过 `//go:embed` 嵌入二进制，**最终只需上传一个可执行文件即可运行**。

---

## 目录

1. [部署架构与思路](#1-部署架构与思路)
2. [编译（在开发机 / 构建机上完成）](#2-编译在开发机--构建机上完成)
3. [Ubuntu 服务器环境准备](#3-ubuntu-服务器环境准备)
4. [创建专用系统用户](#4-创建专用系统用户)
5. [上传文件与目录规划](#5-上传文件与目录规划)
6. [配置 .env](#6-配置-env)
7. [配置 systemd 服务](#7-配置-systemd-服务)
8. [启动与验证](#8-启动与验证)
9. [可选：Nginx 反向代理 + HTTPS](#9-可选nginx-反向代理--https)
10. [可选：MySQL / PostgreSQL / Redis](#10-可选mysql--postgresql--redis)
11. [运维：日志、升级、备份](#11-运维日志升级备份)
12. [常见问题排查](#12-常见问题排查)

---

## 1. 部署架构与思路

- **后端**：Go 编译为单一静态可执行文件 `new-api`，无运行时依赖。
- **前端**：React（default + classic 两套主题），`bun run build` 后产物被 `//go:embed` 嵌入二进制，**不需要单独部署前端、也不需要 Nginx 托管静态文件**。
- **SQLite 驱动**：使用纯 Go 的 `glebarez/sqlite`，可 `CGO_ENABLED=0` 静态编译，无 glibc 依赖问题。
- **数据库**：默认 SQLite（零依赖，单文件）；也可切换 MySQL / PostgreSQL。
- **缓存**：默认内存缓存；可选 Redis。

**推荐流程**：在开发机（你现在的 Windows / 或一台 Linux 构建机）完成编译，把单个 `new-api` 二进制上传到 Ubuntu 服务器，用 systemd 托管运行。

> 命令行参数（源码 `common/init.go`）：
> - `--port 3000`：监听端口（也可用环境变量 `PORT` 覆盖）
> - `--log-dir ./logs`：日志目录
> - `--version`：打印版本退出
> - `--help`：打印帮助退出

---

## 2. 编译（在开发机 / 构建机上完成）

> 需要：Go 1.25+、Bun。
>
> ⚠️ **本节同时给出 Linux / macOS / Git Bash / WSL 的 `bash` 写法，和 Windows 原生 `PowerShell` 写法。**
> 下面的 `bash` 代码块**不能**直接粘到 PowerShell 或 CMD 里执行（`VAR=value command`、`$(cat ...)`、`$(date ...)` 都是 Unix shell 语法，PowerShell 会报 `无法将"CGO_ENABLED=0"项识别为 cmdlet...`）。
> Windows 用户请使用每一步里的 **「PowerShell」** 版本；或者干脆在 **Git Bash / WSL** 里跑 `bash` 版本。

### 2.1 写入版本号（重要）

源码里 `VERSION` 文件当前为空。编译前建议写入一个版本号，便于后续运维识别：

**bash（Linux / macOS / Git Bash / WSL）：**

```bash
echo "v1.0.0-$(date +%Y%m%d)" > VERSION
```

**PowerShell（Windows）：**

```powershell
# 用 ascii 编码避免写入 BOM，否则 Go/Bun 读取版本号时可能带上不可见字符
"v1.0.0-$(Get-Date -Format yyyyMMdd)" | Out-File -Encoding ascii -NoNewline VERSION
```

### 2.2 构建前端（default + classic 两套主题都要构建）

`main.go` 中通过 `//go:embed web/default/dist` 与 `web/classic/dist` 嵌入，**两套 dist 必须都存在，否则 Go 编译会失败**。

**bash（Linux / macOS / Git Bash / WSL）：**

```bash
cd web
bun install --frozen-lockfile

# default 主题
cd default
DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION=$(cat ../../VERSION) bun run build
cd ..

# classic 主题
cd classic
VITE_REACT_APP_VERSION=$(cat ../../VERSION) bun run build
cd ../..
```

**PowerShell（Windows）：**

```powershell
cd web
bun install --frozen-lockfile

# default 主题
cd default
$env:DISABLE_ESLINT_PLUGIN = 'true'
$env:VITE_REACT_APP_VERSION = (Get-Content ../../VERSION -Raw).Trim()
bun run build
cd ..

# classic 主题
cd classic
$env:VITE_REACT_APP_VERSION = (Get-Content ../../VERSION -Raw).Trim()
bun run build
cd ../..
```

### 2.3 编译后端（关键：CGO_ENABLED=0 静态编译）

**bash（Linux / macOS / Git Bash / WSL）：**

```bash
go mod download

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -ldflags "-s -w -X 'github.com/QuantumNous/new-api/common.Version=$(cat VERSION)'" \
  -o new-api
```

**PowerShell（Windows，交叉编译出 Linux 二进制）：**

```powershell
go mod download

# PowerShell 用 $env: 逐个设置环境变量（注意值要带引号，0 也是字符串）
$env:CGO_ENABLED = '0'
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$ver = (Get-Content VERSION -Raw).Trim()
go build -ldflags "-s -w -X 'github.com/QuantumNous/new-api/common.Version=$ver'" -o new-api
```

- `CGO_ENABLED=0`：纯静态编译，生成的二进制不依赖目标机 glibc，可在任意 Linux 发行版运行。
- `-s -w`：去除调试符号，减小体积。
- ARM64 服务器请改 `GOARCH=arm64`（纯 Go SQLite 同样支持 `CGO_ENABLED=0`）。
- ⚠️ PowerShell 里设置的 `$env:GOOS/GOARCH` 只在**当前窗口**有效；编完想继续在本机跑原生命令，可执行 `Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED` 还原，或直接新开一个窗口。

编译产物为当前目录下的 `new-api`（因为设了 `GOOS=linux`，**不带 `.exe` 后缀**），确认一下：

**bash：**

```bash
file new-api
./new-api --version    # 在 Linux 上可验证
```

**PowerShell：** Windows 上无 `file` 命令，且这是 Linux 二进制**无法在 Windows 直接运行**，只确认文件存在即可，验证留到 Linux 服务器上做：

```powershell
Get-Item new-api       # 确认产物已生成
```

> 一条龙脚本见本手册末尾「附录 A：一键构建脚本」。

---

## 3. Ubuntu 服务器环境准备

用 root 或具备 sudo 权限的账号执行：

```bash
sudo apt update && sudo apt upgrade -y

# 基础工具与时区/证书
sudo apt install -y ca-certificates tzdata curl wget vim

# 设置时区（按需，推荐与业务一致）
sudo timedatectl set-timezone Asia/Shanghai

# 开放防火墙端口（如果启用了 ufw）
sudo ufw allow 3000/tcp   # 直连方式；若走 Nginx 则改为放行 80/443
```

> 由于二进制是静态编译的，**Ubuntu 服务器上不需要安装 Go、Bun、Node 等任何运行时**。

---

## 4. 创建专用系统用户

为了安全，不要用 root 直接跑服务。创建一个不可登录的专用系统用户 `newapi`：

```bash
sudo useradd --system --create-home --home-dir /opt/new-api --shell /usr/sbin/nologin newapi
```

- `--system`：系统账户
- `--shell /usr/sbin/nologin`：禁止交互式登录
- 家目录直接设为部署目录 `/opt/new-api`

验证：

```bash
id newapi
```

---

## 5. 上传文件与目录规划

目录规划：

```
/opt/new-api/
├── new-api          # 可执行文件
├── .env             # 配置文件
├── logs/            # 日志目录
└── data/            # SQLite 数据库等数据（建议）
```

从开发机上传二进制（在开发机执行，替换为你的服务器 IP）：

```bash
scp new-api  your_user@SERVER_IP:/tmp/new-api
```

在服务器上就位并设置权限：

```bash
sudo mkdir -p /opt/new-api/logs /opt/new-api/data
sudo mv /tmp/new-api /opt/new-api/new-api
sudo chmod +x /opt/new-api/new-api
sudo chown -R newapi:newapi /opt/new-api
```

---

## 6. 配置 .env

`.env` 放在工作目录（`/opt/new-api/`），程序启动时通过 `godotenv.Load(".env")` 加载（见 `main.go: InitResources()`）。

创建 `/opt/new-api/.env`：

```bash
sudo -u newapi tee /opt/new-api/.env >/dev/null <<'EOF'
# ===== 基础 =====
PORT=3000
TZ=Asia/Shanghai

# 会话密钥：务必改成随机字符串（可用 openssl rand -hex 32 生成）
SESSION_SECRET=请替换为随机字符串

# ===== 数据库（默认 SQLite，最简单）=====
# 不配置 SQL_DSN 即使用 SQLite，路径由 SQLITE_PATH 指定
SQLITE_PATH=/opt/new-api/data/one-api.db

# 如需 MySQL，取消注释并配置（同时注释掉上面的 SQLITE_PATH 不影响，但 SQL_DSN 优先）
# SQL_DSN=user:password@tcp(127.0.0.1:3306)/newapi?parseTime=true

# 如需 PostgreSQL：
# SQL_DSN=postgres://user:password@127.0.0.1:5432/newapi

# ===== 缓存（可选 Redis）=====
# REDIS_CONN_STRING=redis://default:password@127.0.0.1:6379/0
MEMORY_CACHE_ENABLED=true
SYNC_FREQUENCY=60

# ===== 多机部署才需要（单机无需配置）=====
# 单节点部署保持默认即可；多节点时从节点设为 slave
# NODE_TYPE=master

# ===== 其他可选 =====
# DEBUG=true
# STREAMING_TIMEOUT=300
EOF
```

> 生成随机 SESSION_SECRET：
> ```bash
> openssl rand -hex 32
> ```
> 把输出填入 `.env` 的 `SESSION_SECRET`。

设置权限（`.env` 含密钥，限制读取）：

```bash
sudo chown newapi:newapi /opt/new-api/.env
sudo chmod 600 /opt/new-api/.env
```

---

## 7. 配置 systemd 服务

项目自带 `new-api.service` 模板，这里给出适配本手册目录结构的最终版本。创建 `/etc/systemd/system/new-api.service`：

```bash
sudo tee /etc/systemd/system/new-api.service >/dev/null <<'EOF'
[Unit]
Description=New API Service
After=network.target
# 若使用本机 MySQL/PostgreSQL/Redis，可解除下面注释以保证启动顺序
# After=network.target mysql.service redis-server.service

[Service]
Type=simple
User=newapi
Group=newapi
WorkingDirectory=/opt/new-api
ExecStart=/opt/new-api/new-api --port 3000 --log-dir /opt/new-api/logs
Restart=always
RestartSec=5
LimitNOFILE=65535

# 安全加固（可选但推荐）
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/new-api

[Install]
WantedBy=multi-user.target
EOF
```

> 说明：
> - `WorkingDirectory=/opt/new-api` 保证程序能在该目录找到 `.env` 和 SQLite 数据文件。
> - `LimitNOFILE=65535`：API 网关高并发场景需要更高的文件描述符上限。
> - 端口也可在 `.env` 里用 `PORT=` 设置；命令行 `--port` 与环境变量 `PORT` 二选一即可（源码中 `PORT` 环境变量优先）。

---

## 8. 启动与验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable new-api      # 开机自启
sudo systemctl start new-api       # 启动
sudo systemctl status new-api      # 查看状态
```

查看实时日志：

```bash
sudo journalctl -u new-api -f
```

应能看到类似 `New API <version> started`、数据库初始化、`i18n initialized ...` 等日志。

本机验证 HTTP：

```bash
curl -I http://127.0.0.1:3000/
```

浏览器访问 `http://SERVER_IP:3000/`，首次访问会进入初始化向导（创建管理员账号）。

---

## 9. 可选：Nginx 反向代理 + HTTPS

生产环境推荐前置 Nginx，提供 80/443、HTTPS、域名访问。

```bash
sudo apt install -y nginx
```

创建 `/etc/nginx/conf.d/new-api.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 上传大文件 / 长上下文请求
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式响应必需：关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        # 流式长连接超时
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS（Let's Encrypt 免费证书）：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

> ⚠️ 走 Nginx 后，建议关闭直接对外的 3000 端口：`sudo ufw delete allow 3000/tcp`，只放行 80/443。

---

## 10. 可选：MySQL / PostgreSQL / Redis

默认 SQLite 已足够中小规模使用。若需要更强的并发/多节点，再切换数据库。

### MySQL（>= 5.7.8）

```bash
sudo apt install -y mysql-server
sudo mysql -e "CREATE DATABASE newapi CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
sudo mysql -e "CREATE USER 'newapi'@'127.0.0.1' IDENTIFIED BY 'YOUR_PASSWORD';"
sudo mysql -e "GRANT ALL PRIVILEGES ON newapi.* TO 'newapi'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

`.env` 中设置：

```
SQL_DSN=newapi:YOUR_PASSWORD@tcp(127.0.0.1:3306)/newapi?parseTime=true
```

### PostgreSQL（>= 9.6）

```bash
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE DATABASE newapi;"
sudo -u postgres psql -c "CREATE USER newapi WITH PASSWORD 'YOUR_PASSWORD';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE newapi TO newapi;"
```

`.env` 中设置：

```
SQL_DSN=postgres://newapi:YOUR_PASSWORD@127.0.0.1:5432/newapi
```

### Redis（可选缓存）

```bash
sudo apt install -y redis-server
```

`.env` 中设置：

```
REDIS_CONN_STRING=redis://127.0.0.1:6379/0
```

> 切换数据库后重启服务：`sudo systemctl restart new-api`。程序首次启动会自动建表（GORM AutoMigrate）。

---

## 11. 运维：日志、升级、备份

### 日志

- systemd 日志：`sudo journalctl -u new-api -f`
- 应用日志文件：`/opt/new-api/logs/`

### 升级（替换二进制）

```bash
# 1) 开发机重新构建（见第 2 节），得到新的 new-api
# 2) 上传到服务器 /tmp
scp new-api your_user@SERVER_IP:/tmp/new-api

# 3) 服务器上替换并重启
sudo systemctl stop new-api
sudo mv /tmp/new-api /opt/new-api/new-api
sudo chmod +x /opt/new-api/new-api
sudo chown newapi:newapi /opt/new-api/new-api
sudo systemctl start new-api
sudo systemctl status new-api
```

### 备份

- **SQLite**：备份 `/opt/new-api/data/one-api.db`（停服或低峰期 cp 即可）。
- **MySQL/PostgreSQL**：用 `mysqldump` / `pg_dump`。
- `.env` 也一并备份（含密钥）。

---

## 12. 常见问题排查

| 现象 | 排查方向 |
|------|----------|
| `systemctl start` 后立即退出 | `journalctl -u new-api -e` 看具体报错；常见为 `.env` 权限/路径、端口被占用 |
| 端口被占用 | `sudo ss -ltnp | grep 3000`，改端口或杀占用进程 |
| 浏览器 502（经 Nginx） | 确认 `new-api` 已监听 3000：`curl -I http://127.0.0.1:3000/` |
| 流式响应（SSE）卡住/不输出 | 确认 Nginx 已设 `proxy_buffering off`；勿对其启用 gzip |
| SQLite 写入失败 / 只读 | `data/` 目录属主是否为 `newapi`，`ReadWritePaths` 是否包含该路径 |
| 数据库连接失败 | 检查 `SQL_DSN` 格式、数据库服务是否启动、账号权限 |
| `GLIBC_x.xx not found` | 说明二进制不是静态编译，重新用 `CGO_ENABLED=0` 编译 |
| 启动报找不到 `web/default/dist` | 是**编译期**问题：编译前未构建前端，回到第 2.2 节构建后再编译 |

---

## 附录 A：一键构建脚本

在开发机（Linux / WSL / Git Bash）项目根目录保存为 `build.sh`：

> 这是 **bash 脚本，不能在 PowerShell / CMD 里运行**。Windows 用户请用 Git Bash / WSL 执行本脚本，或改用第 2 节的 PowerShell 分步命令。

```bash
#!/usr/bin/env bash
set -euo pipefail

# 版本号（VERSION 文件为空时用此默认）
if [ ! -s VERSION ]; then
  echo "v1.0.0-$(date +%Y%m%d)" > VERSION
fi
VERSION=$(cat VERSION)
echo ">>> Building version: $VERSION"

# 1. 前端
echo ">>> [1/3] bun install"
( cd web && bun install --frozen-lockfile )

echo ">>> [2/3] build frontend (default + classic)"
( cd web/default && DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION="$VERSION" bun run build )
( cd web/classic && VITE_REACT_APP_VERSION="$VERSION" bun run build )

# 2. 后端（静态编译）
echo ">>> [3/3] build backend (CGO_ENABLED=0)"
go mod download
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -ldflags "-s -w -X 'github.com/QuantumNous/new-api/common.Version=${VERSION}'" \
  -o new-api

echo ">>> Done: ./new-api ($VERSION)"
file new-api
```

运行：

```bash
chmod +x build.sh
./build.sh
```

---

## 附录 B：部署速查（已构建好二进制后）

```bash
# 服务器环境
sudo apt update && sudo apt install -y ca-certificates tzdata
# 用户
sudo useradd --system --create-home --home-dir /opt/new-api --shell /usr/sbin/nologin newapi
# 目录
sudo mkdir -p /opt/new-api/logs /opt/new-api/data
# 上传后就位
sudo mv /tmp/new-api /opt/new-api/new-api && sudo chmod +x /opt/new-api/new-api
# .env（见第 6 节）、service（见第 7 节）
sudo chown -R newapi:newapi /opt/new-api
# 启动
sudo systemctl daemon-reload && sudo systemctl enable --now new-api
sudo systemctl status new-api
sudo journalctl -u new-api -f
```
