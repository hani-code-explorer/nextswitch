---
name: deploy-docs
description: 编译 VitePress 设计文档并部署到本机 nginx 目录。在文档修改后需要部署时使用，或当用户要求部署文档时触发。
version: "1.1.0"
---

# 文档部署技能

## 概述

将 `docs/design/` 下的 VitePress 设计文档编译为静态 HTML 并部署到 `/var/www/nextswitch-docs`，供 nginx 提供服务。

当服务器内存不足时，自动回退到 dev server 模式。

## 部署模式

| 模式 | 条件 | 特点 |
|------|------|------|
| **静态模式**（首选） | 可用内存 > 1.2GB | 编译为静态 HTML，性能最佳 |
| **Dev Server 模式**（回退） | 内存不足导致编译失败 | 使用 VitePress dev server + nginx 反代 |

## 部署流程

### 1. 检查内存并选择模式

```bash
AVAILABLE_MB=$(free -m | awk '/^Mem:/{print $7}')
if [ "$AVAILABLE_MB" -lt 1200 ]; then
    echo "LOW_MEMORY"
else
    echo "OK"
fi
```

### 2. 停止已有服务

```bash
# 停止 dev server（如正在运行）
pkill -f "vitepress dev" 2>/dev/null || true
sleep 1
```

### 3A. 静态模式部署

#### 3A-1. 释放内存

```bash
sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
```

#### 3A-2. 编译文档

```bash
cd /root/nextswitch/docs/design && npm run build
```

- 预期输出：`build complete in XX.XXs`
- 产物目录：`docs/design/.vitepress/dist/`
- **如果 exit code 137（OOM kill），切换到 Dev Server 模式（步骤 3B）**

#### 3A-3. 部署到 nginx 目录

```bash
rm -rf /var/www/nextswitch-docs/*
cp -r /root/nextswitch/docs/design/.vitepress/dist/* /var/www/nextswitch-docs/
```

#### 3A-4. 设置目录权限

```bash
chown -R nginx:nginx /var/www/nextswitch-docs
chmod -R 755 /var/www/nextswitch-docs
```

#### 3A-5. 配置 nginx 静态模式

```bash
cat > /etc/nginx/conf.d/nextswitch-docs.conf << 'NGINX_EOF'
server {
    listen 9980;
    root /var/www/nextswitch-docs;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 1024;

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX_EOF
```

### 3B. Dev Server 模式部署（内存不足时）

#### 3B-1. 启动 dev server

```bash
cd /root/nextswitch/docs/design
nohup npx vitepress dev --host 0.0.0.0 --port 5173 > /tmp/vitepress-dev.log 2>&1 &
sleep 3
```

验证启动：
```bash
curl -sI http://127.0.0.1:5173/ | head -3
```

#### 3B-2. 配置 nginx 反代模式

```bash
cat > /etc/nginx/conf.d/nextswitch-docs.conf << 'NGINX_EOF'
server {
    listen 9980;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX_EOF
```

### 4. 重载 nginx

```bash
nginx -t && nginx -s reload
```

### 5. 验证部署

```bash
curl -sI http://127.0.0.1:9980/ | head -3
```

预期返回 `HTTP/1.1 200 OK`。

## 完成后报告

部署成功后报告：
- 部署模式（静态 / dev server）
- 编译耗时（静态模式）
- 部署文件数量（静态模式）
- 访问地址：`http://47.238.155.219/`

## 注意事项

- Dev Server 模式下文件修改会自动热更新，无需重新部署
- 如需从 dev server 模式切回静态模式，先确保有足够内存，执行静态模式步骤后 dev server 会被自动停止
- 静态模式性能更好，适合生产环境；dev server 模式适合开发调试或内存受限的服务器
