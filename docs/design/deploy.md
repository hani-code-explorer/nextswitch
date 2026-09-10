# 部署指南

## 构建产物

```bash
cd docs/design
npm ci
npm run build
```

构建产物位于 `docs/design/.vitepress/dist/`，为纯静态文件，可直接部署到任意 Web 服务器。

## Nginx 部署

### 基础配置

```nginx
server {
    listen 80;
    server_name docs.nextswitch.io;
    root /var/www/nextswitch-docs;
    index index.html;

    # gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 1024;

    # 静态资源缓存（VitePress 构建产物含 hash，可长期缓存）
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA 路由回退
    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

### 启用 HTTPS（Let's Encrypt）

```nginx
server {
    listen 80;
    server_name docs.nextswitch.io;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name docs.nextswitch.io;
    root /var/www/nextswitch-docs;
    index index.html;

    ssl_certificate     /etc/letsencrypt/live/docs.nextswitch.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/docs.nextswitch.io/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

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
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
}
```

### 子路径部署

如果站点部署在子路径下（如 `https://example.com/docs/`），需要修改两处：

**1. VitePress 配置**（`.vitepress/config.ts`）：

```ts
export default defineConfig({
  base: '/docs/',
  // ... 其余配置
})
```

**2. Nginx 配置**：

```nginx
location /docs/ {
    alias /var/www/nextswitch-docs/;
    index index.html;

    location ~ ^/docs/assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    try_files $uri $uri.html $uri/ /docs/index.html;
}
```

## 部署步骤

```bash
# 1. 构建
cd docs/design
npm ci
npm run build

# 2. 上传产物到服务器
rsync -avz --delete .vitepress/dist/ user@server:/var/www/nextswitch-docs/

# 3. 重载 Nginx（如有配置变更）
sudo nginx -t && sudo systemctl reload nginx
```

## GitHub Actions 自动部署

CI 工作流（`.github/workflows/docs.yml`）在 `main` 分支的 `docs/design/**` 路径变更时自动构建，产物可通过以下方式获取：

- **GitHub Pages**：自动部署到 `https://<org>.github.io/nextswitch/`
- **自托管**：从 Actions 的 Artifacts 中下载 `nextswitch-docs`，解压后上传到 Nginx 目录
