# New API — Nginx 负载均衡部署（双节点 7:3 加权分流）

> 场景：两台 Ubuntu 主机分别部署了 new-api 服务：
> - **192.168.0.201:3000**
> - **192.168.0.202:3000**
>
> 在 **192.168.0.201** 上部署 Nginx，对外暴露 80 端口作为统一入口，
> 按 **7:3** 权重分发流量（.201 承载 70%，.202 承载 30%）。

---

## 0. 前置：两个必须确认的点（否则负载均衡后会出诡异问题）

负载均衡会让同一个用户的请求**随机落到不同节点**，所以两台 new-api 必须满足：

1. **`SESSION_SECRET` 两台必须完全相同** ⚠️ 最容易踩的坑
   后台登录用的是 cookie session，用 `SESSION_SECRET` 签名。如果两台不一样，用户登录后下一次请求被分到另一台，cookie 校验失败 → 反复掉登录。两台 `.env` 里设成同一个值：
   ```bash
   SESSION_SECRET=<同一个随机串，两台一致>
   ```

2. **共享 DB + Redis，且只有一个 master**
   - 两台连同一个 `SQL_DSN`（MySQL/PG，不能是各自的 SQLite）和同一个 `REDIS_CONN_STRING`。
   - 一台 `NODE_TYPE=master`（建议就是 .201），另一台 `NODE_TYPE=slave`。

如果这两点没满足，先别上 Nginx，先把它们配好。

---

## 1. 安装 Nginx（在 192.168.0.201 上执行）

```bash
sudo apt update
sudo apt install -y nginx

# 确认运行
sudo systemctl enable --now nginx
sudo systemctl status nginx --no-pager
```

`new-api` 占 3000，Nginx 占 80，**同机不冲突**。

---

## 2. 防火墙放行（如果启用了 ufw）

```bash
# 对外只需放行 80（以后上 HTTPS 再放 443）
sudo ufw allow 80/tcp

# 内网两台之间 3000 端口要互通：
#  - .201 的 Nginx 要能访问 .202:3000
#  - 原来对外的 3000 建议收回，只允许内网/本机访问
# 如果之前放行了 3000/tcp 对所有人，可改成只允许本网段：
sudo ufw delete allow 3000/tcp 2>/dev/null || true
sudo ufw allow from 192.168.0.0/24 to any port 3000 proto tcp
```

> .202 上同理：确保 `192.168.0.201` 能访问它的 `3000`
> （`sudo ufw allow from 192.168.0.201 to any port 3000 proto tcp`）。

---

## 3. 写负载均衡配置

删掉默认站点，避免抢占 80：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

创建 `/etc/nginx/conf.d/new-api-lb.conf`：

```bash
sudo tee /etc/nginx/conf.d/new-api-lb.conf >/dev/null <<'EOF'
# ===== 上游：两台 new-api，按 7:3 权重分发 =====
upstream new_api_backend {
    # weight 决定流量比例：7+3=10，即 70% / 30%
    server 192.168.0.201:3000 weight=7 max_fails=2 fail_timeout=30s;
    server 192.168.0.202:3000 weight=3 max_fails=2 fail_timeout=30s;

    # 复用到后端的长连接，降低握手开销（配合下面 http_version 1.1 + Connection "")
    keepalive 64;
}

server {
    listen 80;
    server_name _;          # 有域名就填域名，没有就用 _ 接收所有

    # 上传大文件 / 长上下文请求放宽
    client_max_body_size 64m;

    location / {
        proxy_pass http://new_api_backend;

        # 长连接到上游
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # 透传真实客户端信息（new-api 记录日志/风控用）
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式响应必需：关闭缓冲，否则流式输出会卡住或一次性吐出
        proxy_buffering            off;
        proxy_cache                off;
        chunked_transfer_encoding  on;

        # 流式长连接超时（AI 回答可能很久）
        proxy_connect_timeout 10s;
        proxy_read_timeout    600s;
        proxy_send_timeout    600s;

        # 某个后端挂了/超时，自动重试另一台
        proxy_next_upstream error timeout http_502 http_503 http_504;
    }
}
EOF
```

校验并生效：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 4. 验证

### 4.1 后端可达性（在 .201 上）

```bash
curl -I http://192.168.0.201:3000/
curl -I http://192.168.0.202:3000/
```

两条都应返回 HTTP 头（200/302 等）。`.202` 这条不通就是防火墙/服务没起。

### 4.2 通过 Nginx 入口访问

```bash
curl -I http://192.168.0.201/        # 走 80，经 Nginx 分发
```

浏览器访问 `http://192.168.0.201/` 应正常打开。

### 4.3 验证 7:3 分流

最直观的方式：给两台配不同的 `NODE_NAME`（`.env` 里），它会写进访问日志的 `node_name`，到后台日志页面看分布即可。

或者临时用脚本压一批请求，在两台分别看 systemd 日志哪台收得多：

```bash
# 在入口机连发 100 次（注意这访问的是首页，主要看连接落点）
for i in $(seq 1 100); do curl -s -o /dev/null http://192.168.0.201/; done
# 两台分别：
sudo journalctl -u new-api --since "2 min ago" | wc -l
```

大致会是 70 / 30 的比例（权重轮询是平滑的，不是严格每 10 个里 7+3，但总量趋近）。

---

## 5. 几个建议（按需）

- **真实客户端 IP**：上面已透传 `X-Forwarded-For`。如果 new-api 后台看到的来源 IP 都是 192.168.0.201，需要在 new-api 侧开启「信任上游代理 / trusted proxy」相关设置（系统设置里），让它取 `X-Forwarded-For` 的真实 IP。

- **粘性会话（可选）**：本项目用共享 Redis + 同一 `SESSION_SECRET`，理论上无需粘性。但若你想让同一客户端尽量固定落到同一台（比如减少缓存抖动），把 `upstream` 改成：
  ```nginx
  upstream new_api_backend {
      ip_hash;     # 按客户端 IP 哈希固定后端
      server 192.168.0.201:3000 weight=7;
      server 192.168.0.202:3000 weight=3;
  }
  ```
  注意 `ip_hash` 下权重的精确度会变差，且不能和 `keepalive` 同时用得太激进。**默认不加，先用上面的加权轮询即可。**

- **上 HTTPS**：等域名解析到 .201 后：
  ```bash
  sudo apt install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d your-domain.com
  ```
  certbot 会自动改 `server_name` 和加 443 配置。

- **.201 自己既是 LB 又是后端**：完全没问题，Nginx(80) 和 new-api(3000) 端口不冲突。只是 .201 负载会比 .202 高（这正是你要的 7:3）。
