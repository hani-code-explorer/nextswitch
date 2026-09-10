# NextSWITCH 平台安全设计规格书

## 文档信息

| 项目 | 内容 |
|------|------|
| Version | 2.0.0 |
| Date | 2026-09-09 |
| Status | Active |
| Supersedes | auth-service-design v1.1.0, service-to-service-auth-design Draft, security-mlps3-supplement v1.0.0 |

---

## 1. 概述

### 1.1 设计目标

本文档是 NextSWITCH 平台安全的统一设计规格书，覆盖用户认证授权、服务间认证、通信加密、敏感数据保护、入侵检测、审计日志、密钥管理、备份容灾、网络安全与应急响应等方面。

**核心设计目标**：

- **身份认证**：用户认证（JWT + RBAC + 2FA）与服务间认证（HMAC-SHA256）双层体系
- **通信安全**：全链路 TLS/mTLS 加密，从客户端到数据库、从服务间 gRPC 到 Redis Pub/Sub
- **数据保护**：敏感字段分级加密存储、日志脱敏、内存清零
- **入侵检测**：登录/操作/系统三层异常检测，自动响应与告警
- **审计合规**：链式哈希防篡改审计日志，满足等保三级要求
- **密钥管理**：分层密钥体系，支持自动/手动轮换
- **备份容灾**：全量 + binlog 实时复制，跨站点灾备，RPO <= 30 min / RTO <= 4 h
- **应急响应**：P1-P4 分级响应流程

**设计原则**：

- **独立 crate**：`nextswitch-auth` crate 负责认证授权，`nextswitch-service-auth` crate 负责服务间认证
- **共享数据库**：复用 Config Service 的数据库，表在同一数据库中
- **无外键约束**：应用层保证引用完整性（宪法 Principle IX）
- **BIGINT 主键**：所有表使用 BIGINT AUTO_INCREMENT 主键
- **应用管理时间戳**：`created_at` 和 `updated_at` 由应用写入
- **CacheStore trait 抽象**：所有缓存操作通过 `nextswitch-cache` crate 执行，不直接依赖 Redis

### 1.2 安全架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Web UI / 客户端                                │
│                   (HTTPS, JWT Token, CAPTCHA)                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   API Gateway / Load Balancer                         │
│                   (TLS 1.2+, WAF, DDoS 防护)                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
       ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
       │ Config API  │  │  Auth API   │  │ Monitor API │
       │ (配置管理)   │  │ (认证授权)   │  │ (监控查询)   │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                               ▼
              ┌─────────────────────────────────┐
              │         应用服务层                 │
              │                                  │
              │  ┌─────────┐  ┌──────────────┐  │
              │  │sipserver │  │signalserver  │  │
              │  │(SIP信令) │  │(信号处理)     │  │
              │  └────┬─────┘  └──────┬───────┘  │
              │       │   gRPC mTLS    │          │
              │       │  + HMAC签名    │          │
              │       ▼               │          │
              │  ┌─────────┐          │          │
              │  │medserver │          │          │
              │  │(RTP媒体) │          │          │
              │  └─────────┘          │          │
              └─────────────────────────────────┘
                         │
            ┌────────────┼────────────┐
            │ Redis Pub/Sub           │
            │ (签名信封 + TLS)         │
            │                         │
            ▼                         ▼
┌──────────────────────┐   ┌──────────────────────┐
│  Redis Cluster       │   │    MySQL 8            │
│  (TLS + mTLS)        │   │    (TLS 连接加密)      │
│  权限缓存, Token 存储 │   │  用户, 角色, 权限, 菜单│
│  心跳, 集群事件       │   │  配置, 审计日志        │
└──────────────────────┘   └──────────────────────┘
            │                         │
            └────────┬────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────┐
│              安全基础设施层                         │
│                                                   │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ 入侵检测   │  │ 审计归档   │  │ 密钥管理      │ │
│  │ 引擎      │  │ (Parquet) │  │ (KMS/Vault)  │ │
│  └───────────┘  └───────────┘  └──────────────┘ │
│                                                   │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ 异地备份   │  │ 证书 CA   │  │ CRL 吊销检查  │ │
│  │ (站点 B)  │  │ (Root+Int)│  │              │ │
│  └───────────┘  └───────────┘  └──────────────┘ │
└──────────────────────────────────────────────────┘
```

### 1.3 威胁模型

| 威胁类别 | 威胁描述 | 防护措施 | 文档章节 |
|---------|---------|---------|---------|
| 暴力破解 | 自动化密码猜测攻击 | CAPTCHA + 渐进式锁定 + IP 封禁 | 2.3, 7.1 |
| 撞库攻击 | 使用泄露凭据批量尝试 | IP 维度检测 + 封禁 | 7.1 |
| 中间人攻击 | 窃听/篡改通信数据 | 全链路 TLS/mTLS | 4 |
| Token 劫持 | Access/Refresh Token 泄露 | 短有效期 + 黑名单 + 会话绑定 | 2.2, 2.3 |
| 服务伪造 | 冒充合法服务发送指令 | HMAC-SHA256 签名 + mTLS | 3 |
| 重放攻击 | 截获并重发认证消息 | 时间戳窗口 (30s) + 防重放 | 3.2, 3.3 |
| SQL 注入 | 恶意 SQL 语句 | WAF + 参数化查询 + 白名单校验 | 8.2 |
| 数据泄露 | 敏感数据暴露 | 字段加密 + 日志脱敏 + 内存清零 | 5 |
| 审计篡改 | 修改/删除审计日志 | 链式哈希防篡改 | 8.1 |
| 密钥泄露 | 加密密钥被盗 | 分层密钥 + 定期轮换 + 安全存储 | 9 |
| 内部威胁 | 合法用户滥用权限 | RBAC + 数据权限隔离 + 操作审计 | 2, 8 |

---

## 2. 用户认证与授权

Auth Service 是 NextSWITCH 的认证授权中心，负责用户认证、权限管理、菜单管理和数据权限控制。

### 2.1 数据模型

#### 2.1.1 数据库所有权划分

Auth Service 与 Config Service 共享同一数据库。表的 ownership 划分如下：

**Config Service 拥有的表**（Auth Service 只引用，不修改）：

| 表名 | 说明 |
|------|------|
| `tenants` | 租户表，定义在 config-and-gateway-design |
| `sites` | 站点表，定义在 config-and-gateway-design |
| `extensions` | 分机表，Auth Service 查询用于分机级权限过滤 |
| `config_changelog` | 配置审计日志，Auth Service 写入认证相关审计记录 |
| `operation_logs` | 操作日志，Auth Service 写入安全管理类操作记录 |
| `tenant_security_policies` | 租户安全策略表，定义在 config-and-gateway-design，Auth Service 读取 |
| `system_security_defaults` | 系统安全默认值表，定义在 config-and-gateway-design |

**Auth Service 拥有的表**：

| 表名 | 说明 |
|------|------|
| `users` | 系统登录用户 |
| `user_extensions` | 用户-分机关联 |
| `tenant_users` | 租户-用户关联（含 email 盲索引） |
| `roles` | 角色 |
| `permissions` | 权限 |
| `role_permissions` | 角色-权限关联 |
| `user_roles` | 用户-角色关联 |
| `menus` | 菜单 |
| `role_menus` | 角色-菜单关联 |
| `departments` | 部门 |
| `user_departments` | 用户-部门关联 |
| `data_scopes` | 数据权限规则 |
| `mfa_sessions` | 2FA 会话 |
| `login_logs` | 登录审计日志 |
| `password_history` | 历史密码记录 |
| `sessions` | 登录会话管理 |
| `auth_audit_log` | 认证审计日志 |

#### 2.1.2 users 与 extensions 的关系

系统中存在两种身份概念：

**users（系统用户）**：
- 用于 Web UI / API 登录
- 密码使用 argon2id 哈希
- 拥有角色、权限、菜单
- 可以是管理员、经理、操作员等

**extensions（SIP 分机）**：
- 用于 SIP 协议注册和认证
- 密码使用 SIP DIGEST 认证（不同哈希方式）
- 属于某个租户
- 是分机号（如 1001）

**关系**：
- 一个 `user` 可以关联零个或多个 `extension`
- 通过 `user_extensions` 关联表实现
- `config_changelog.changed_by` 和 `auth_audit_log.user_id` 引用 `users.id`

```
┌──────────┐         ┌───────────────┐         ┌────────────┐
│  users   │         │user_extensions│         │ extensions │
│ (Web登录) │<───────│  (关联表)      │────────>│ (SIP分机)   │
└──────────┘         └───────────────┘         └────────────┘
     │                                              │
     │ 1:N                                          │ N:1
     ▼                                              ▼
┌──────────┐                                  ┌────────────┐
│user_roles│                                  │  tenants   │
│ (角色)    │                                  │  (租户)     │
└──────────┘                                  └────────────┘
```

#### 2.1.3 用户表（users）

```sql
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(512),                                      -- 加密存储（AES-256-GCM）
    display_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active',                     -- active/inactive/locked
    last_login_at DATETIME,
    login_failed_count INT DEFAULT 0,
    locked_until DATETIME,
    password_changed_at DATETIME,                            -- 上次密码修改时间
    password_expires_at DATETIME,                            -- 密码过期时间
    password_grace_logins INT DEFAULT 0,                     -- 过期后剩余允许登录次数
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_type VARCHAR(50),                                    -- totp/sms/email
    mfa_secret VARCHAR(255),                                 -- TOTP 密钥（AES-256-GCM 加密）
    mfa_phone VARCHAR(512),                                  -- 短信验证手机号（加密）
    phone VARCHAR(512),                                      -- 手机号（加密）
    password_must_change BOOLEAN DEFAULT FALSE,              -- 首次登录强制改密
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(username)
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_password_expires ON users(password_expires_at);
```

#### 2.1.4 用户-分机关联表（user_extensions）

```sql
CREATE TABLE user_extensions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    extension_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(user_id, extension_id)
);
CREATE INDEX idx_user_extensions_user_id ON user_extensions(user_id);
CREATE INDEX idx_user_extensions_extension_id ON user_extensions(extension_id);
```

#### 2.1.5 租户-用户关联表（tenant_users）

```sql
CREATE TABLE tenant_users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    email_blind_index VARCHAR(64),                           -- 应用层 HMAC 盲索引
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, user_id)
);
CREATE INDEX idx_tenant_users_tenant_id ON tenant_users(tenant_id);
CREATE INDEX idx_tenant_users_user_id ON tenant_users(user_id);
CREATE UNIQUE INDEX idx_tenant_users_email_blind ON tenant_users(tenant_id, email_blind_index);
```

> **盲索引位置说明**：`email_blind_index` 放在 `tenant_users` 表而非 `users` 表，因为 `users` 表没有 `tenant_id` 列，盲索引需要按租户隔离保证唯一性。

#### 2.1.6 角色表（roles）

```sql
CREATE TABLE roles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT,                                        -- NULL 表示系统级角色
    name VARCHAR(100) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT FALSE,                         -- 系统内置角色不可删除
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);
```

#### 2.1.7 权限表（permissions）

```sql
CREATE TABLE permissions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(100) NOT NULL,                              -- 如 extensions:read, trunks:write
    display_name VARCHAR(255) NOT NULL,
    resource VARCHAR(100) NOT NULL,                          -- 资源类型
    action VARCHAR(50) NOT NULL,                             -- 操作：read, write, delete, import, export
    description TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(code)
);
CREATE INDEX idx_permissions_resource ON permissions(resource);
```

#### 2.1.8 角色-权限关联表（role_permissions）

```sql
CREATE TABLE role_permissions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    role_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(role_id, permission_id)
);
CREATE INDEX idx_role_permissions_role_id ON role_permissions(role_id);
CREATE INDEX idx_role_permissions_permission_id ON role_permissions(permission_id);
```

#### 2.1.9 用户-角色关联表（user_roles）

```sql
CREATE TABLE user_roles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    tenant_id BIGINT,                                        -- NULL 表示全局角色
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(user_id, role_id, tenant_id)
);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);
CREATE INDEX idx_user_roles_tenant_id ON user_roles(tenant_id);
```

#### 2.1.10 菜单表（menus）

```sql
CREATE TABLE menus (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    parent_id BIGINT,                                        -- 父菜单 ID，NULL 表示顶级
    tenant_id BIGINT,                                        -- NULL 表示系统级菜单
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL,
    path VARCHAR(500),                                       -- 前端路由路径
    icon VARCHAR(100),
    sort_order INT DEFAULT 0,
    is_visible BOOLEAN DEFAULT TRUE,
    permission_code VARCHAR(100),                            -- 关联的权限编码
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, code)
);
CREATE INDEX idx_menus_parent_id ON menus(parent_id);
CREATE INDEX idx_menus_tenant_id ON menus(tenant_id);
CREATE INDEX idx_menus_sort_order ON menus(tenant_id, sort_order);
```

#### 2.1.11 角色-菜单关联表（role_menus）

```sql
CREATE TABLE role_menus (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    role_id BIGINT NOT NULL,
    menu_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(role_id, menu_id)
);
CREATE INDEX idx_role_menus_role_id ON role_menus(role_id);
CREATE INDEX idx_role_menus_menu_id ON role_menus(menu_id);
```

#### 2.1.12 部门表（departments）

```sql
CREATE TABLE departments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    parent_id BIGINT,                                        -- 父部门 ID，支持树形结构
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL,
    leader_user_id BIGINT,                                   -- 部门负责人
    sort_order INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, code)
);
CREATE INDEX idx_departments_tenant_id ON departments(tenant_id);
CREATE INDEX idx_departments_parent_id ON departments(parent_id);
```

#### 2.1.13 用户-部门关联表（user_departments）

```sql
CREATE TABLE user_departments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    department_id BIGINT NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,                        -- 是否主部门
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(user_id, department_id)
);
CREATE INDEX idx_user_departments_user_id ON user_departments(user_id);
CREATE INDEX idx_user_departments_department_id ON user_departments(department_id);
```

#### 2.1.14 数据权限规则表（data_scopes）

```sql
CREATE TABLE data_scopes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    resource VARCHAR(100) NOT NULL,                          -- 资源类型
    scope_type VARCHAR(50) NOT NULL,                         -- all/department/self/custom
    scope_config JSON,                                       -- 自定义范围配置
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(role_id, resource)
);
CREATE INDEX idx_data_scopes_tenant_id ON data_scopes(tenant_id);
CREATE INDEX idx_data_scopes_role_id ON data_scopes(role_id);
```

**`scope_type` 说明**：

| scope_type | 含义 | scope_config 示例 |
|------------|------|------------------|
| `all` | 全部数据 | `null` |
| `department` | 本部门及子部门 | `null` |
| `self` | 仅自己的数据 | `null` |
| `custom` | 自定义范围 | `{"department_ids": [1,2,3], "user_ids": [10,20]}` |

#### 2.1.15 2FA 会话表（mfa_sessions）

```sql
CREATE TABLE mfa_sessions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    session_token VARCHAR(255) NOT NULL,                     -- 临时会话 Token
    mfa_type VARCHAR(50) NOT NULL,                           -- totp/sms/email
    code_hash VARCHAR(255),                                  -- 验证码哈希
    attempts INT DEFAULT 0,
    expires_at DATETIME NOT NULL,                            -- 过期时间（5 分钟）
    verified_at DATETIME,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(session_token)
);
CREATE INDEX idx_mfa_sessions_user_id ON mfa_sessions(user_id);
CREATE INDEX idx_mfa_sessions_expires_at ON mfa_sessions(expires_at);
```

#### 2.1.16 登录审计日志表（login_logs）

> 遵循宪法 X.1：所有认证事件必须记录，不可通过 API 篡改。

```sql
CREATE TABLE login_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT,                                          -- 登录失败且用户不存在时为 NULL
    username VARCHAR(128) NOT NULL,                          -- 提交的用户名（始终记录）
    tenant_id BIGINT,                                        -- 未解析时为 NULL
    event_type VARCHAR(30) NOT NULL,                         -- login_success/login_failure/logout/session_expired/password_changed/account_locked
    ip_address VARCHAR(45) NOT NULL,                         -- 客户端 IP
    user_agent VARCHAR(512),
    failure_reason VARCHAR(128),                             -- invalid_password/account_locked/account_disabled/user_not_found
    session_id VARCHAR(64),                                  -- JWT session identifier
    prev_hash VARCHAR(64),                                   -- 签名链：前一条记录的 SHA-256 哈希
    chain_hash VARCHAR(64) NOT NULL DEFAULT '',              -- 签名链：当前记录的链哈希
    created_at DATETIME NOT NULL
);
CREATE INDEX idx_login_logs_user_id ON login_logs(user_id);
CREATE INDEX idx_login_logs_username ON login_logs(username);
CREATE INDEX idx_login_logs_tenant_id ON login_logs(tenant_id);
CREATE INDEX idx_login_logs_event_type ON login_logs(event_type);
CREATE INDEX idx_login_logs_ip_address ON login_logs(ip_address);
CREATE INDEX idx_login_logs_created_at ON login_logs(created_at DESC);
```

#### 2.1.17 历史密码表（password_history）

> 遵循宪法 X.3：记住最近 5 次密码，防止密码复用。

```sql
CREATE TABLE password_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    password_hash VARCHAR(256) NOT NULL,                     -- argon2id 哈希
    created_at DATETIME NOT NULL
);
CREATE INDEX idx_password_history_user_id ON password_history(user_id);
CREATE INDEX idx_password_history_user_created ON password_history(user_id, created_at DESC);
```

#### 2.1.18 会话表（sessions）

> 遵循宪法 X.5：管理登录会话，支持空闲超时、绝对超时、并发会话限制。

```sql
CREATE TABLE sessions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    session_id VARCHAR(64) NOT NULL,                         -- UUID v4 会话标识
    refresh_token_hash VARCHAR(128) NOT NULL,                -- Refresh Token 哈希
    ip_address VARCHAR(45) NOT NULL,
    user_agent VARCHAR(512),
    expires_at DATETIME NOT NULL,                            -- 会话绝对过期时间
    last_active_at DATETIME NOT NULL,                        -- 最后活动时间
    created_at DATETIME NOT NULL,
    UNIQUE(session_id)
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_sessions_last_active ON sessions(last_active_at);
```

#### 2.1.19 认证审计日志表（auth_audit_log）

> Auth Service 拥有，记录所有认证操作的审计信息。

```sql
CREATE TABLE auth_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT,                                          -- 操作对象用户 ID
    operator_id BIGINT,                                      -- 操作者用户 ID（系统操作为 NULL）
    tenant_id BIGINT,                                        -- 租户 ID
    action VARCHAR(100) NOT NULL,                            -- password_change/mfa_enable/mfa_disable/role_assign/role_revoke/account_unlock/password_reset/mfa_reset
    target_type VARCHAR(50),                                 -- user/role/permission/session
    target_id BIGINT,                                        -- 操作目标 ID
    ip_address VARCHAR(45),
    user_agent VARCHAR(512),
    success BOOLEAN NOT NULL DEFAULT TRUE,
    details JSON,                                            -- 附加详情
    prev_hash VARCHAR(64),                                   -- 签名链：前一条记录哈希
    chain_hash VARCHAR(64) NOT NULL DEFAULT '',              -- 签名链：当前记录链哈希
    created_at DATETIME NOT NULL
);
CREATE INDEX idx_auth_audit_log_user_id ON auth_audit_log(user_id);
CREATE INDEX idx_auth_audit_log_operator_id ON auth_audit_log(operator_id);
CREATE INDEX idx_auth_audit_log_tenant_id ON auth_audit_log(tenant_id);
CREATE INDEX idx_auth_audit_log_action ON auth_audit_log(action);
CREATE INDEX idx_auth_audit_log_created_at ON auth_audit_log(created_at DESC);
```

### 2.2 JWT Token 设计

#### 2.2.1 JWT Payload 结构

```json
{
  "sub": "100",                    // user_id
  "tid": 1,                        // tenant_id
  "sid": "uuid-v4",                // session_id
  "iat": 1725868800,               // issued at
  "exp": 1725870600,               // expires at（30 分钟）
  "jti": "uuid-v4"                 // token id，用于撤销
}
```

**设计要点**：
- JWT 只包含最小信息：用户 ID、租户 ID、会话 ID、时间戳
- 权限信息从 Redis 缓存获取
- Access Token 有效期 30 分钟（可按租户配置 5-120 分钟）
- Refresh Token 有效期 8 小时（可按租户配置 1-24 小时）
- JWT Header 携带 `kid`（Key ID），用于密钥轮换时选择验证密钥

#### 2.2.2 Token 类型

| Token 类型 | 有效期 | 用途 | 存储位置 |
|-----------|--------|------|---------|
| Access Token | 30 分钟（可配置） | API 请求认证 | 客户端内存/LocalStorage |
| Refresh Token | 8 小时（可配置） | 刷新 Access Token | sessions 表 + Redis |

> 有效期可通过 `tenant_security_policies` 表按租户配置。

### 2.3 登录流程

#### 2.3.1 完整登录流程（含 CAPTCHA + MFA）

```
第零阶段：获取验证码（连续失败 >= 3 次时要求）
  GET /api/v1/auth/captcha
  -> 返回 captcha_id + captcha_image

第一阶段：验证码 + 密码验证
  POST /api/v1/auth/login
  { "username": "admin", "password": "xxx" }
  // 或（连续失败 >= 3 次时）：
  { "username": "admin", "password": "xxx", "captcha_id": "uuid", "captcha_code": "A3x9" }

  -> (1) 验证验证码有效性（一次性，验证后删除）
  -> (2) 验证用户名密码
  -> (3) 检查账号锁定状态（渐进式锁定）
  -> (4) 检查密码过期状态
  -> (5) 查询租户安全策略 tenant_security_policies.mfa_mode
     |-- disabled -> 跳过 2FA，直接签发 Token
     |-- optional -> 检查用户是否已启用 2FA（users.mfa_enabled）
     |   |-- 已启用 -> 进入第二阶段
     |   +-- 未启用 -> 跳过，直接签发 Token
     +-- required -> 检查用户是否已启用 2FA
         |-- 已启用 -> 进入第二阶段
         +-- 未启用 -> 返回 MFA_SETUP_REQUIRED

第二阶段：2FA 验证（按需）
  POST /api/v1/auth/mfa/verify
  { "mfa_session_token": "xxx", "code": "123456" }

  -> 验证 mfa_session_token 有效性
  -> 验证 code 正确性
  |-- TOTP：使用 mfa_secret 验证
  |-- SMS/Email：验证 code_hash
  |-- 验证失败 -> 增加 attempts，超过 5 次锁定
  +-- 验证成功 -> 继续签发流程

签发阶段：
  (6) 生成 session_id（UUID v4）
  (7) 生成 Access Token（30 min）+ Refresh Token（8 hours）
  (8) 将 session 写入 sessions 表（含 refresh_token_hash）
  (9) 将 Refresh Token 存入 Redis（Key: auth:refresh:{jti}，TTL = refresh TTL）
  (10) 加载用户权限到 Redis 缓存
  (11) 写入 login_logs（event_type=login_success）
  (12) 重置 login_failed_count 和 password_grace_logins
```

#### 2.3.2 Token 刷新流程

```
(1) 客户端用 Refresh Token 请求新 Access Token
(2) 验证 Refresh Token 有效性（Redis 中存在且未过期）
(3) 检查 sessions 表：last_active_at + idle_timeout 是否过期
    -> 过期 -> 返回 401 Session Expired，删除 session
(4) 更新 sessions.last_active_at = NOW()
(5) 生成新 Access Token
(6) 可选：轮换 Refresh Token
```

#### 2.3.3 登出流程

```
(1) 删除 Redis 中的 Refresh Token（auth:refresh:{jti}）
(2) 删除 sessions 表中的 session 记录
(3) 将 Access Token 的 jti 加入黑名单（auth:blacklist:{jti}）
(4) 删除用户权限缓存（auth:permissions:{user_id}:{tenant_id}）
(5) 删除用户菜单缓存（auth:menus:{user_id}:{tenant_id}）
(6) 删除用户数据权限缓存（auth:data_scopes:{user_id}:{tenant_id}）
(7) 删除用户信息缓存（auth:user_info:{user_id}）
(8) 写入 login_logs（event_type=logout）
```

> **修正说明**：原 security-mlps3-supplement 中登出流程引用了不存在的 `auth:perms:{user_id}` 和 `auth:config_cache:{user_id}` Redis Key，已修正为正确的 Key 格式。

#### 2.3.4 空闲超时检查（每次 API 请求）

```
(1) 从 JWT 提取 session_id
(2) 检查 Redis 或 sessions 表的 last_active_at
(3) 如果 NOW() > last_active_at + idle_timeout -> 返回 401 Session Expired
(4) 否则更新 last_active_at = NOW()
```

#### 2.3.5 登录验证码（CAPTCHA）

防止暴力破解和自动化攻击。遵循宪法 X.6：连续 3 次登录失败后触发 CAPTCHA 验证。

**验证码触发策略**：

| 条件 | 是否要求 CAPTCHA | 说明 |
|------|-----------------|------|
| 连续失败 0-2 次 | 否 | 正常登录 |
| 连续失败 3-4 次 | **是** | 触发 CAPTCHA |
| 连续失败 >= 5 次 | 是 + 账号锁定 | 渐进式锁定 |

> "连续失败"按用户名 + IP 双维度检测（取先触发者）。

**图形验证码流程**：

```
(1) 客户端请求验证码
  GET /api/v1/auth/captcha
  -> 生成 4 位字母数字验证码
  -> 渲染为带噪点/干扰线的图片（200x60 PNG）
  -> 答案哈希存入 Redis：auth:captcha:{captcha_id} = hash(answer), TTL=5min

(2) 客户端提交登录（携带验证码）
  POST /api/v1/auth/login
  { "username": "admin", "password": "xxx", "captcha_id": "uuid-v4", "captcha_code": "A3x9" }

(3) 服务端验证
  -> 从 Redis 获取 auth:captcha:{captcha_id}
  -> 不存在 -> 返回 "验证码已过期"
  -> 比对 hash(code) 与存储值（不区分大小写）
  -> 不匹配 -> 返回 "验证码错误"，删除该 captcha_id
  -> 匹配 -> 删除 captcha_id（一次性使用），继续密码验证
```

**验证码安全策略**：

| 策略 | 配置 | 说明 |
|------|------|------|
| 有效期 | 5 分钟 | 超时自动失效 |
| 一次性使用 | 验证后立即删除 | 防止重放攻击 |
| 不区分大小写 | 比对时统一转小写 | 用户友好 |
| 字符集 | `A-Z, a-z, 0-9`（去除 `0/O/1/l/I`） | 降低识别错误 |
| 干扰 | 噪点 + 干扰线 + 字符扭曲 | 防止 OCR 识别 |
| 频率限制 | 同一 IP 每分钟最多 10 次 | 防止资源耗尽 |

#### 2.3.6 双因子认证（2FA）

**支持的 2FA 类型**：

| 类型 | 说明 | 适用场景 |
|------|------|---------|
| `totp` | 基于时间的一次性密码（Google Authenticator） | 推荐，安全性高 |
| `sms` | 短信验证码 | 用户友好 |
| `email` | 邮件验证码 | 用户友好 |

> **租户策略驱动**：用户可用的 2FA 类型由 `tenant_security_policies.mfa_allowed_methods` 控制。
>
> **2FA 模式**由 `tenant_security_policies.mfa_mode` 控制：
> - `disabled` -- 该租户下所有用户无法启用 2FA
> - `optional` -- 用户可自行决定是否启用
> - `required` -- 所有用户必须启用 2FA

**TOTP 设置流程**：

```
POST /api/v1/auth/mfa/setup
{ "type": "totp" }

-> 校验租户安全策略：
  1. mfa_mode != disabled（否则返回 FORBIDDEN）
  2. "totp" in mfa_allowed_methods（否则返回 FORBIDDEN）

-> 校验通过，生成 TOTP 密钥

响应：
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qr_code_url": "data:image/png;base64,...",
  "otpauth_url": "otpauth://totp/NextSWITCH:admin?secret=JBSWY3DPEHPK3PXP&issuer=NextSWITCH"
}

用户扫码后：
POST /api/v1/auth/mfa/verify-setup
{ "code": "123456" }

-> 验证 code 与 secret 匹配
-> 更新 users 表：mfa_enabled=true, mfa_type=totp, mfa_secret=加密(secret)
```

**2FA 安全要求**：

- TOTP 密钥 AES-256-GCM 加密存储
- 验证码有效期：5 分钟
- 尝试次数限制：5 次
- 短信/邮件验证码：6 位数字

#### 2.3.7 超级管理员初始化

系统首次启动时自动创建超级管理员用户 `dadmin`。

**触发条件**：`users` 表为空（首次启动 / 数据库重建）

**初始化动作**：

```
1. 创建超级管理员用户：
   username: "dadmin"
   password: 随机生成 16 位强密码
   display_name: "超级管理员"
   status: "active"
   mfa_enabled: false

2. 创建系统级超级角色：
   name: "super_admin"
   display_name: "超级管理员"
   is_system: true
   tenant_id: NULL

3. 关联用户与角色

4. 超级管理员绕过权限检查

5. 输出初始密码到 stdout（仅首次启动）
```

**安全要求**：

| 要求 | 说明 |
|------|------|
| 首次登录强制改密 | `password_must_change = true` |
| 密码强度 | 最少 12 位，包含大小写 + 数字 + 特殊字符 |
| 不可删除 | `is_system = true` |
| 绕过租户隔离 | 可管理所有租户 |
| 审计日志 | 所有操作记录到 `auth_audit_log` |

### 2.4 权限缓存设计（CacheStore trait，宪法 XI）

> 所有缓存操作通过 `nextswitch-cache` crate 的 `CacheStore` trait 执行，不直接依赖 Redis。

#### 2.4.1 缓存 Key 设计

```
auth:permissions:{user_id}:{tenant_id}     # 用户权限列表
auth:menus:{user_id}:{tenant_id}           # 用户菜单树
auth:data_scopes:{user_id}:{tenant_id}     # 用户数据权限规则
auth:user_info:{user_id}                   # 用户基本信息（含部门）
auth:refresh:{jti}                         # Refresh Token
auth:blacklist:{jti}                       # Access Token 黑名单
auth:session:{session_id}                  # 会话信息（含 last_active_at，TTL = idle_timeout）
auth:security_policy:{tenant_id}           # 租户安全策略缓存（TTL = 1h）
auth:failures:user:{username}              # 用户名维度登录失败计数
auth:failures:ip:{ip_address}              # IP 维度登录失败计数
auth:captcha:{captcha_id}                  # 图形验证码（TTL = 5min）
heartbeat:{service}:{instance_id}          # 服务心跳（如 heartbeat:sipserver:sipserver-03）
security:blocked_ip:{ip}                   # 动态 IP 封禁列表
```

> **心跳 Key 格式**：统一使用 `heartbeat:{service}:{instance_id}` 结构化格式，例如 `heartbeat:sipserver:sipserver-03`、`heartbeat:medserver:medserver-01`。

#### 2.4.2 缓存 Value 示例

**权限缓存**：
```json
{
  "user_id": 100,
  "tenant_id": 1,
  "roles": ["manager", "operator"],
  "permissions": ["extensions:read", "extensions:write", "agents:read", "call_records:read"],
  "data_scopes": {
    "extensions": {"scope_type": "department"},
    "agents": {"scope_type": "self"},
    "call_records": {"scope_type": "all"}
  },
  "expires_at": "2026-09-09T12:00:00Z"
}
```

**安全策略缓存**：
```json
{
  "tenant_id": 1,
  "password": {
    "min_length": 8, "require_uppercase": true, "require_lowercase": true,
    "require_digit": true, "require_special": true, "history_count": 5,
    "max_age_days": 90, "expiry_warn_days": 7, "grace_logins": 3
  },
  "session": {
    "access_token_ttl_minutes": 30, "refresh_token_ttl_hours": 8,
    "idle_timeout_minutes": 15, "max_concurrent_sessions": 5
  },
  "lockout": { "threshold": 5, "initial_minutes": 15, "captcha_threshold": 3 },
  "mfa": { "mode": "optional", "allowed_methods": ["totp", "sms"] },
  "expires_at": "2026-09-09T13:00:00Z"
}
```

#### 2.4.3 缓存更新策略

| 场景 | 更新方式 |
|------|---------|
| 用户登录 | 加载权限到 Redis，TTL = 2 小时 |
| 权限/角色变更 | 删除受影响用户的缓存 Key，下次请求重新加载 |
| 用户登出 | 删除缓存 Key |
| 缓存未命中 | 从数据库加载，写入 Redis |
| Redis 不可用 | 返回 503 Service Unavailable |
| 安全策略变更 | Pub/Sub 事件后删除 `auth:security_policy:{tenant_id}` |
| 安全策略缓存未命中 | 从 `tenant_security_policies` 表加载，TTL = 1 小时 |

### 2.5 REST API

#### 2.5.1 API 总览

```
基础路径：/api/v1

通用约定：
  - 所有列表接口支持分页：?page=1&page_size=20
  - 所有列表接口支持过滤：?status=active
  - 所有列表接口支持排序：?sort_by=created_at&sort_order=desc
  - 响应格式统一：{ "data": [...], "pagination": {...} }
  - 错误格式统一：{ "error": { "code": "...", "message": "...", "details": [...] } }
```

#### 2.5.2 认证相关

```
GET    /api/v1/auth/captcha              # 获取图形验证码
POST   /api/v1/auth/login                # 登录
POST   /api/v1/auth/logout               # 登出
POST   /api/v1/auth/refresh              # 刷新 Token
GET    /api/v1/auth/me                   # 获取当前用户信息
PUT    /api/v1/auth/password             # 修改密码
POST   /api/v1/auth/change-password      # 强制修改密码（密码过期时）

# 2FA
GET    /api/v1/auth/mfa/status           # 查询 2FA 状态
POST   /api/v1/auth/mfa/setup            # 初始化 2FA
POST   /api/v1/auth/mfa/verify-setup     # 验证 2FA 设置
DELETE /api/v1/auth/mfa/disable          # 禁用 2FA
POST   /api/v1/auth/mfa/send-code        # 发送验证码
POST   /api/v1/auth/mfa/verify           # 验证 2FA 码

# 会话与账号管理
DELETE /api/v1/users/{id}/sessions       # 管理员撤销用户会话
POST   /api/v1/users/{id}/unlock         # 管理员解锁账号

# 审计
GET    /api/v1/audit/login-logs          # 查询登录审计日志
```

#### 2.5.3 用户管理

```
POST   /api/v1/tenants/{tenantId}/users              # 创建用户
GET    /api/v1/tenants/{tenantId}/users              # 列表用户
GET    /api/v1/tenants/{tenantId}/users/{id}         # 获取用户
PUT    /api/v1/tenants/{tenantId}/users/{id}         # 更新用户
DELETE /api/v1/tenants/{tenantId}/users/{id}         # 删除用户
POST   /api/v1/tenants/{tenantId}/users/{id}/roles   # 分配角色
POST   /api/v1/tenants/{tenantId}/users/{id}/departments  # 分配部门
```

#### 2.5.4 角色管理

```
POST   /api/v1/tenants/{tenantId}/roles              # 创建角色
GET    /api/v1/tenants/{tenantId}/roles              # 列表角色
GET    /api/v1/tenants/{tenantId}/roles/{id}         # 获取角色
PUT    /api/v1/tenants/{tenantId}/roles/{id}         # 更新角色
DELETE /api/v1/tenants/{tenantId}/roles/{id}         # 删除角色
PUT    /api/v1/tenants/{tenantId}/roles/{id}/permissions   # 设置角色权限
PUT    /api/v1/tenants/{tenantId}/roles/{id}/data-scopes   # 设置数据权限
```

#### 2.5.5 菜单管理

```
POST   /api/v1/tenants/{tenantId}/menus              # 创建菜单
GET    /api/v1/tenants/{tenantId}/menus              # 列表菜单（树形）
PUT    /api/v1/tenants/{tenantId}/menus/{id}         # 更新菜单
DELETE /api/v1/tenants/{tenantId}/menus/{id}         # 删除菜单
PUT    /api/v1/tenants/{tenantId}/menus/sort         # 批量排序
```

#### 2.5.6 部门管理

```
POST   /api/v1/tenants/{tenantId}/departments        # 创建部门
GET    /api/v1/tenants/{tenantId}/departments        # 列表部门（树形）
PUT    /api/v1/tenants/{tenantId}/departments/{id}   # 更新部门
DELETE /api/v1/tenants/{tenantId}/departments/{id}   # 删除部门
```

#### 2.5.7 权限查询

```
GET    /api/v1/permissions                                  # 列表所有权限
GET    /api/v1/tenants/{tenantId}/users/{id}/permissions    # 用户权限
GET    /api/v1/tenants/{tenantId}/users/{id}/menus          # 用户菜单树
GET    /api/v1/tenants/{tenantId}/users/{id}/data-scopes    # 用户数据权限
```

### 2.6 请求认证中间件

```
API 请求进入
  |
  +-- (1) 提取 JWT Token（Header: Authorization: Bearer xxx）
  |
  +-- (2) 验证 JWT 签名和有效期
  |     -> 无效 -> 返回 401 Unauthorized
  |
  +-- (3) 检查 Token 黑名单（jti）
  |     -> 在黑名单中 -> 返回 401 Unauthorized
  |
  +-- (4) 从 JWT 提取 user_id、tenant_id
  |
  +-- (5) 从 Redis 获取用户权限缓存
  |     |-- 缓存命中 -> 使用缓存的权限
  |     +-- 缓存未命中 -> 从数据库加载，写入 Redis
  |           +-- Redis 不可用 -> 返回 503 Service Unavailable
  |
  +-- (6) 检查功能权限
  |     -> 无权限 -> 返回 403 Forbidden
  |
  +-- (7) 检查数据权限
  |     -> 在 SQL 查询中注入数据过滤条件
  |
  +-- (8) 执行业务逻辑
```

**数据权限过滤示例**：

**scope_type = all**：
```sql
SELECT * FROM extensions WHERE tenant_id = 1
```

**scope_type = department**：
```sql
SELECT * FROM extensions 
WHERE tenant_id = 1 
  AND department_id IN (
    SELECT department_id FROM user_departments WHERE user_id = 100
    UNION
    SELECT id FROM departments WHERE parent_id IN (
      SELECT department_id FROM user_departments WHERE user_id = 100
    )
  )
```

**scope_type = self**：
```sql
SELECT * FROM agents WHERE tenant_id = 1 AND created_by = 100
```

**scope_type = custom**：
```sql
-- scope_config: {"department_ids": [1,2,3], "user_ids": [10,20]}
SELECT * FROM call_records 
WHERE tenant_id = 1 
  AND (department_id IN (1, 2, 3) OR created_by IN (10, 20))
```

### 2.7 系统内置角色与权限

#### 2.7.1 预定义角色

| 角色名称 | 显示名称 | 说明 |
|---------|---------|------|
| `super_admin` | 超级管理员 | 系统最高权限，跨租户管理 |
| `tenant_admin` | 租户管理员 | 租户内最高权限 |
| `manager` | 经理 | 管理部门内用户和配置 |
| `operator` | 操作员 | 日常操作，有限权限 |
| `viewer` | 只读用户 | 只能查看 |

#### 2.7.2 预定义权限

```
# 用户管理
users:read / users:write / users:delete / users:unlock

# 角色管理
roles:read / roles:write / roles:delete

# 分机管理
extensions:read / extensions:write / extensions:delete / extensions:import / extensions:export

# 坐席管理
agents:read / agents:write / agents:delete

# 坐席技能
agent_skills:read / agent_skills:write

# 技能组管理
skill_groups:read / skill_groups:write / skill_groups:delete

# 呼叫队列管理
call_queues:read / call_queues:write / call_queues:delete

# 中继管理
trunks:read / trunks:write / trunks:delete

# 号码管理
dids:read / dids:write / dids:delete

# IVR 管理
ivr_flows:read / ivr_flows:write / ivr_flows:delete / ivr_flows:activate

# 路由规则管理
routing_rules:read / routing_rules:write / routing_rules:delete

# 审计日志
audit_log:read / operation_logs:read / login_logs:read

# 安全管理
security_policy:read / security_policy:write
sessions:revoke

# 监控
monitoring:read
```

---

## 3. 服务间认证

### 3.1 服务身份模型

#### 3.1.1 背景

NextSWITCH 内部服务间通信在无 Service Mesh 环境下运行。部署环境为单 VPC 内网 + 跨可用区（A+B），服务可能跨网络段通信。

**设计目标**：

- 服务级认证：验证"调用方是哪个服务"
- 静态共享密钥：环境变量注入
- 应用层签名：Redis Pub/Sub 消息内嵌 HMAC，gRPC metadata 携带 HMAC
- 统一服务身份模型

**非目标**：不做服务发现集成、不做自动密钥轮换、不做方法级 ACL

#### 3.1.2 服务标识

每个服务实例拥有全局唯一的 `service_id`，格式为 `{service_type}-{instance_name}`：

```
sipserver-01, signalserver-01, medserver-01, medserver-02,
router-server-01, nextswitch-api, config-service, cti-server-01, im-server-01
```

#### 3.1.3 密钥模型

每对需要通信的服务共享一个 HMAC-SHA256 密钥：

```toml
# sipserver 配置示例
[service_identity]
service_id = "sipserver-01"
secret = "env:SIPSERVER_01_SECRET"

[service_identity.trusted_peers]
signalserver-01 = "env:SIGNALSERVER_01_SECRET"
medserver-01 = "env:MEDSERVER_01_SECRET"
```

**密钥规则**：

- 密钥长度 >= 32 字节（256 bit）
- 通过环境变量注入，禁止硬编码
- 双向通信使用同一共享密钥

### 3.2 gRPC 认证（HMAC-SHA256 metadata）

#### 3.2.1 Metadata 格式

```
x-service-id:   sipserver-01
x-service-sign: base64(HMAC-SHA256(secret, canonical_string))
x-service-ts:   1725868800
```

#### 3.2.2 签名构造

```
canonical_string = "{service_id}\n{full_method_name}\n{timestamp}"
signature = HMAC-SHA256(shared_secret, canonical_string)
```

#### 3.2.3 发送方 Interceptor

```rust
fn sign_request(identity: &ServiceIdentity, request: &Request) {
    let timestamp = now_unix();
    let method = request.method_name();
    let input = format!("{}\n{}\n{}", identity.service_id(), method, timestamp);
    let sig = identity.sign(&input);

    metadata.insert("x-service-id", identity.service_id());
    metadata.insert("x-service-sign", base64(sig));
    metadata.insert("x-service-ts", timestamp);
}
```

#### 3.2.4 接收方验证流程

```
gRPC Request 到达
  -> 提取 x-service-id, x-service-sign, x-service-ts
  -> 检查 timestamp：|now - timestamp| <= 30s？
     -> 否 -> UNAUTHENTICATED
  -> 查找 trusted_peers[service_id] 的 secret
     -> 未找到 -> UNAUTHENTICATED
  -> 常量时间比对签名
     -> 不匹配 -> UNAUTHENTICATED
  -> 将 service_id 注入 gRPC Context，继续处理
```

### 3.3 Redis Pub/Sub 消息签名

#### 3.3.1 消息格式

在现有消息 payload 外层包裹签名信封：

```json
{
  "service_id": "config-service",
  "timestamp": 1725868800,
  "signature": "base64(HMAC-SHA256(secret, canonical_string))",
  "payload": { "event_id": "uuid-v4", "tenant_id": 1, "..." }
}
```

#### 3.3.2 签名构造

```
canonical_string = "{service_id}\n{channel}\n{timestamp}\n{sha256(payload)}"
signature = HMAC-SHA256(shared_secret, canonical_string)
```

#### 3.3.3 发送方封装

```rust
fn publish_signed(redis, channel, payload, identity: &ServiceIdentity) {
    let timestamp = now_unix();
    let payload_hash = sha256(serde_json::to_vec(&payload));
    let input = format!("{}\n{}\n{}\n{}", identity.service_id(), channel, timestamp, payload_hash);
    let sig = identity.sign(&input);

    let envelope = SignedMessage {
        service_id: identity.service_id(),
        timestamp,
        signature: base64(sig),
        payload,
    };
    redis.publish(channel, serde_json::to_string(&envelope));
}
```

#### 3.3.4 接收方验证流程

```
收到 Pub/Sub 消息
  -> 解析外层信封
  -> 检查 timestamp：|now - timestamp| <= 30s？
     -> 否 -> 丢弃 + WARN 日志
  -> 查找 trusted_peers[service_id] 的 secret
     -> 未找到 -> 丢弃 + WARN 日志
  -> 常量时间比对签名
     -> 不匹配 -> 丢弃 + ERROR 日志
  -> 解包 payload，交给业务层处理
```

### 3.4 公共 crate 设计

```
crates/nextswitch-service-auth/
├── src/
│   ├── lib.rs              # 公共导出
│   ├── identity.rs         # ServiceIdentity 类型、配置解析
│   ├── signing.rs          # HMAC-SHA256 签名/验签
│   ├── envelope.rs         # SignedMessage 信封
│   ├── grpc.rs             # gRPC client/server interceptor
│   └── pubsub.rs           # Redis Pub/Sub 签名/验签
└── Cargo.toml
```

**核心类型**：

```rust
pub struct ServiceIdentity {
    pub service_id: String,
    secret: Vec<u8>,
    trusted_peers: HashMap<String, Vec<u8>>,
    clock_skew_tolerance: Duration,
}

impl ServiceIdentity {
    pub fn from_config(config: &ServiceIdentityConfig) -> Result<Self>;
    pub fn sign(&self, input: &str) -> Vec<u8>;
    pub fn verify(&self, service_id: &str, input: &str, signature: &[u8]) -> Result<()>;
    pub fn check_timestamp(&self, timestamp: i64) -> Result<()>;
}
```

**适配层**：

```rust
pub fn client_interceptor(identity: Arc<ServiceIdentity>) -> impl Interceptor;
pub fn server_interceptor(identity: Arc<ServiceIdentity>) -> ServiceAuthInterceptor;
pub fn sign_publish(redis, channel, payload, identity: &ServiceIdentity) -> Result<()>;
pub fn verify_message(identity: &ServiceIdentity, raw_message: &[u8]) -> Result<serde_json::Value>;
```

**依赖**：

```toml
[dependencies]
hmac = "0.12"
sha2 = "0.10"
base64 = "0.22"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tonic = "0.12"
subtle = "2"
thiserror = "1"
```

### 3.5 信任矩阵

| 服务 | 自己的 service_id | 需要信任的对端 |
|------|-------------------|---------------|
| nextswitch-api | `nextswitch-api` | sipserver-*, signalserver-* |
| sipserver | `sipserver-{N}` | signalserver-*, medserver-*, cti-server-*, router-server-* |
| signalserver | `signalserver-{N}` | sipserver-*, medserver-*, cti-server-*, router-server-* |
| medserver | `medserver-{N}` | sipserver-*, signalserver-* |
| cti-server | `cti-server-{N}` | sipserver-*, signalserver-*, im-server-* |
| im-server | `im-server-{N}` | cti-server-*, nextswitch-api |
| router-server | `router-server-{N}` | sipserver-*, signalserver-* |
| config-service | `config-service` | （仅发布，不需信任对端） |

> **router-server** 与 sipserver/signalserver 之间有信令路由通信，需加入信任矩阵。

### 3.6 配置格式与密钥管理

#### 3.6.1 配置格式

```toml
[service_identity]
service_id = "sipserver-01"
enforce_signing = false
clock_skew_seconds = 30

[service_identity.trusted_peers]
signalserver-01 = "env:PEER_SIGNALSERVER_01_SECRET"
medserver-01 = "env:PEER_MEDSERVER_01_SECRET"
```

#### 3.6.2 密钥生成

```bash
nextswitch-keygen generate
nextswitch-keygen matrix --services sipserver-01,signalserver-01,medserver-01
```

#### 3.6.3 密钥轮换

过渡期支持双密钥：

```toml
[service_identity.trusted_peers.signalserver-01]
secret = "env:NEW_SECRET"
old_secret = "env:OLD_SECRET"
```

验签时先试新密钥、再试旧密钥。

### 3.7 安全考虑与错误处理

**防重放**：所有签名包含 timestamp，接收方校验 `|now - timestamp| <= 30s`。

**时序安全**：使用常量时间比较（`subtle::ConstantTimeEq`）。

**错误处理**：

| 场景 | gRPC 响应 | Redis Pub/Sub |
|------|-----------|---------------|
| 缺少认证字段 | `UNAUTHENTICATED` | 丢弃 + WARN |
| service_id 不在 trusted_peers | `UNAUTHENTICATED` | 丢弃 + WARN |
| 签名不匹配 | `UNAUTHENTICATED` | 丢弃 + ERROR |
| 时间戳超窗 | `UNAUTHENTICATED` | 丢弃 + WARN |

**监控指标**：

```
service_auth_verified_total{service_id, protocol}
service_auth_rejected_total{service_id, protocol, reason}
service_auth_latency_seconds{protocol}
```

**降级与过渡**：`enforce_signing = false` 时未签名消息放行但记录 WARN；部署完成后切换为 `true`。

### 3.8 Pub/Sub 频道规范

| 频道模式 | 发布者 | 订阅者 | 签名 |
|---------|--------|--------|------|
| `config:{tenant_id}:{entity_type}` | nextswitch-api | sipserver, signalserver, medserver, im-server, cti-server | 有 |
| `config:broadcast` | nextswitch-api | 所有服务实例 | 有 |
| `cluster:events` | 所有服务 | 所有服务 | 有 |
| `call:relay:{instance_id}` | signalserver | sipserver | 有 |

---

## 4. 通信加密

> 等保要求：应采用密码技术保证通信过程中数据的保密性和完整性。

### 4.1 MySQL TLS

```toml
[api.database]
url = "mysql://app_user:${DB_PASSWORD}@db-primary:3306/nextswitch"
tls.enabled = true
tls.ca_cert = "/etc/nextswitch/certs/db-ca.pem"
tls.client_cert = "/etc/nextswitch/certs/db-client.pem"
tls.client_key = "/etc/nextswitch/certs/db-client-key.pem"
tls.verify_identity = true
```

```sql
SET GLOBAL require_secure_transport = ON;
CREATE USER 'app_user'@'%' IDENTIFIED BY '${DB_PASSWORD}' REQUIRE X509;
```

| 证书 | 颁发者 | 有效期 | 部署位置 |
|------|--------|--------|---------|
| DB CA 证书 | 内部 CA | 10 年 | 所有应用服务 |
| DB 服务端证书 | 内部 CA | 1 年 | MySQL 主从节点 |
| DB 客户端证书 | 内部 CA | 1 年 | 所有应用服务 |

### 4.2 Redis TLS

```toml
[api.redis]
url = "rediss://redis:6379"
tls.ca_cert = "/etc/nextswitch/certs/redis-ca.pem"
tls.client_cert = "/etc/nextswitch/certs/redis-client.pem"
tls.client_key = "/etc/nextswitch/certs/redis-client-key.pem"
tls.verify_peer = true
```

```conf
# redis.conf
tls-port 6379
port 0
tls-cert-file /etc/redis/certs/server.pem
tls-key-file /etc/redis/certs/server-key.pem
tls-ca-cert-file /etc/redis/certs/ca.pem
tls-auth-clients yes
tls-replication yes
tls-cluster yes
```

### 4.3 gRPC mTLS

在现有 HMAC-SHA256 应用层签名之上，增加 TLS 传输层加密：

```
请求 -> [TLS 加密传输] -> [HMAC 签名验证] -> [业务逻辑]
         传输层             应用层
         防窃听              防伪造（服务身份）
         防篡改              防重放（timestamp）
```

```toml
# gRPC 服务端
[grpc.tls]
enabled = true
cert = "/etc/nextswitch/certs/grpc-server.pem"
key = "/etc/nextswitch/certs/grpc-server-key.pem"
ca = "/etc/nextswitch/certs/grpc-ca.pem"
client_auth = "RequireAndVerify"

# gRPC 客户端
[grpc_client.medserver.tls]
enabled = true
cert = "/etc/nextswitch/certs/grpc-client.pem"
key = "/etc/nextswitch/certs/grpc-client-key.pem"
ca = "/etc/nextswitch/certs/grpc-ca.pem"
server_name = "medserver"
```

### 4.4 内部 HTTP TLS

```toml
[metrics]
addr = "10.0.1.10:9090"
tls.enabled = true
tls.cert = "/etc/nextswitch/certs/grpc-server.pem"
tls.key = "/etc/nextswitch/certs/grpc-server-key.pem"
tls.ca = "/etc/nextswitch/certs/grpc-ca.pem"
auth = "mtls"
```

### 4.5 证书生命周期

#### 4.5.1 内部 CA 架构

```
Root CA（离线保存）
    |
    +-- Intermediate CA（在线，签发证书）
         |-- DB 证书
         |-- Redis 证书
         |-- gRPC 证书
         +-- HTTPS 证书（LB 层）
```

#### 4.5.2 证书轮换策略

| 证书类型 | 有效期 | 轮换方式 | 提前量 |
|---------|--------|---------|--------|
| Root CA | 10 年 | 手动 | 6 个月 |
| Intermediate CA | 5 年 | 手动 | 3 个月 |
| 服务端/客户端证书 | 1 年 | 自动化 | 30 天 |

#### 4.5.3 TLS 密码套件

```toml
[tls]
min_version = "1.2"
max_version = "1.3"
cipher_suites = [
    "TLS_AES_256_GCM_SHA384",
    "TLS_AES_128_GCM_SHA256",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
]
disabled_cipher_suites = [
    "TLS_RSA_WITH_*",
    "TLS_*_WITH_RC4_*",
    "TLS_*_WITH_3DES_*",
    "TLS_*_WITH_CBC_*",
]
curves = ["x25519", "secp256r1", "secp384r1"]
signature_algorithms = ["ecdsa_nistp256_sha256", "ecdsa_nistp384_sha384", "rsa_pss_sha256"]
```

#### 4.5.4 证书监控与 CRL

Prometheus 指标：

```
nextswitch_cert_remaining_days{type="db",host="db-primary"} 245
nextswitch_cert_remaining_days{type="redis",host="redis:6379"} 89
nextswitch_cert_remaining_days{type="grpc",service="medserver"} 120
nextswitch_crl_revoked_count 3
nextswitch_crl_last_refresh_timestamp 1694217600
```

CRL 每 24 小时从内部 CA 同步，吊销时可通过 `POST /internal/admin/reload-crl` 立即刷新。

---

## 5. 敏感数据保护

> 等保要求：应采用密码技术保证数据的保密性；应对个人信息去标识化处理。

### 5.1 字段分级（L1-L3）

| 级别 | 字段 | 存储要求 | 展示要求 |
|------|------|---------|---------|
| **L1 机密** | `users.password_hash` | argon2id 单向哈希 | 永不展示 |
| **L1 机密** | `extensions.password_hash` | SIP DIGEST hash | 永不展示 |
| **L2 机密** | `trunks.auth_password` | AES-256-GCM 加密 | `****` |
| **L2 机密** | `users.mfa_secret` | AES-256-GCM 加密 | 永不展示 |
| **L3 内部** | `users.email` | AES-256-GCM 加密 | `z***@example.com` |
| **L3 内部** | `users.mfa_phone` | AES-256-GCM 加密 | `138****1234` |
| **L3 内部** | `users.phone` | AES-256-GCM 加密 | 脱敏展示 |
| **L3 内部** | `extensions.email` | 明文 | `z***@example.com` |

> `extensions.email` 明文存储是因为分机数量大且需按 email 直接查询，加密 + 盲索引成本过高。

### 5.2 加密方案（AES-256-GCM）

```toml
[encryption]
dek = "${DATA_ENCRYPTION_KEY}"            # 32 字节 hex（AES-256）

[encryption.key_derivation]
master_key = "${MASTER_ENCRYPTION_KEY}"   # 64 字节 hex
salt = "nextswitch-field-encryption"
info_dek = "field-encryption-dek"
info_mac = "field-mac-key"
```

```
AES-256-GCM（AEAD）
输入：plaintext + DEK + AAD（字段名作为 AAD，防止密文跨字段替换）
输出：nonce(12B) + ciphertext + tag(16B)
存储：Base64 编码后存入 VARCHAR 字段
```

```rust
pub struct FieldEncryptor {
    cipher: Aes256Gcm,
}

impl FieldEncryptor {
    pub fn new(dek: &[u8; 32]) -> Self { /* ... */ }

    pub fn encrypt(&self, plaintext: &str, aad: &str) -> Result<String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self.cipher
            .encrypt(&nonce, Payload { msg: plaintext.as_bytes(), aad: aad.as_bytes() })?;
        let mut combined = Vec::with_capacity(12 + ciphertext.len());
        combined.extend_from_slice(&nonce);
        combined.extend_from_slice(&ciphertext);
        Ok(base64_encode(&combined))
    }

    pub fn decrypt(&self, encoded: &str, aad: &str) -> Result<String> { /* ... */ }
}
```

**表结构变更**：

```sql
ALTER TABLE trunks MODIFY auth_password VARCHAR(512) NOT NULL;
ALTER TABLE users MODIFY email VARCHAR(512), MODIFY mfa_phone VARCHAR(512), ADD COLUMN phone VARCHAR(512);
```

### 5.3 盲索引

> 盲索引放在 `tenant_users` 表（而非 `users` 表），因为 `users` 表没有 `tenant_id` 列。

```rust
pub fn compute_email_blind_index(email: &str, hmac_key: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(hmac_key).unwrap();
    mac.update(email.to_lowercase().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

// 写入时同时写入加密值和盲索引
async fn update_user_email(&self, tenant_id: i64, user_id: i64, new_email: &str) -> Result<()> {
    let encrypted = self.encryptor.encrypt(new_email, "users:email")?;
    let blind_index = compute_email_blind_index(new_email, &self.hmac_key);
    self.db.execute(
        "UPDATE tenant_users SET email_blind_index = ? WHERE tenant_id = ? AND user_id = ?",
        blind_index, tenant_id, user_id
    ).await
}

// 查询时通过 JOIN 获取用户信息
async fn find_user_by_email(&self, tenant_id: i64, email: &str) -> Result<Option<User>> {
    let blind_index = compute_email_blind_index(email, &self.hmac_key);
    self.db.query_one(
        "SELECT tu.* FROM tenant_users tu JOIN users u ON tu.user_id = u.id \
         WHERE tu.tenant_id = ? AND tu.email_blind_index = ?",
        tenant_id, blind_index
    ).await
}
```

> **安全注意**：盲索引必须由应用层计算，不能使用 MySQL Generated Column，否则 HMAC 密钥会暴露在 `information_schema` 中。

### 5.4 日志脱敏

| 数据类型 | 脱敏规则 | 示例 |
|---------|---------|------|
| 邮箱 | 保留首字符和域名 | `z***@example.com` |
| 手机号 | 保留前 3 后 4 | `138****1234` |
| IP 地址 | 保留前两段 | `192.168.***.***` |
| 密码/密钥 | 完全隐藏 | `****` |
| Token | 保留前 8 字符 | `eyJhbGci...****` |

API 响应中，管理员角色看到完整数据，普通角色脱敏展示。

### 5.5 内存清零

```rust
use zeroize::Zeroize;

pub struct SensitiveString(String);

impl Drop for SensitiveString {
    fn drop(&mut self) { self.0.zeroize(); }
}
```

所有敏感数据（密码、密钥、Token 明文）使用 `SensitiveString` 包装，Drop 时自动清零内存。

---

## 6. 安全策略管理

### 6.1 密码策略

| 规则 | 要求 |
|------|------|
| 最小长度 | 8 字符 |
| 大写字母 | >= 1 |
| 小写字母 | >= 1 |
| 数字 | >= 1 |
| 特殊字符 | >= 1 |
| 用户名包含 | 禁止 |
| 弱密码黑名单 | 禁止 top-10,000 |
| 哈希算法 | argon2id（64MB 内存，3 迭代，4 并行度） |
| 历史深度 | 5 次 |
| 有效期 | 90 天（可配 30-365 天） |
| 过期警告 | 7 天内 |
| 宽限期 | 3 次 |

### 6.2 会话策略

| 规则 | 要求 |
|------|------|
| Access Token TTL | 30 分钟（可配 5-120 分钟） |
| Refresh Token TTL | 8 小时（可配 1-24 小时） |
| 空闲超时 | 15 分钟（可配 5-60 分钟） |
| 并发会话 | 每用户最多 5 个 |
| 会话绑定 | IP /24 子网 |

### 6.3 账户锁定策略

| 规则 | 要求 |
|------|------|
| 失败阈值 | 连续 5 次 |
| 初次锁定 | 15 分钟 |
| 渐进升级 | 第 2 次 30 分钟；第 3 次+ 24 小时 |
| 检测维度 | 用户名 AND IP（先触发者） |
| 计数器重置 | 成功登录后 |

实现：使用 Redis `auth:failures:user:{username}` 和 `auth:failures:ip:{ip_address}` 计数。

### 6.4 租户安全策略表（tenant_security_policies）

> 表定义在 config-and-gateway-design 中，Auth Service 读取、Config Service 写入。所有字段有系统默认值。新建租户时自动从 `system_security_defaults` 复制。

```sql
CREATE TABLE tenant_security_policies (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    password_min_length INT DEFAULT 8,
    password_max_length INT DEFAULT 128,
    password_require_uppercase BOOLEAN DEFAULT TRUE,
    password_require_lowercase BOOLEAN DEFAULT TRUE,
    password_require_digit BOOLEAN DEFAULT TRUE,
    password_require_special BOOLEAN DEFAULT TRUE,
    password_block_common BOOLEAN DEFAULT TRUE,
    password_history_count INT DEFAULT 5,
    password_max_age_days INT DEFAULT 90,
    password_expiry_warn_days INT DEFAULT 7,
    password_grace_logins INT DEFAULT 3,
    access_token_ttl_minutes INT DEFAULT 30,
    refresh_token_ttl_hours INT DEFAULT 8,
    idle_timeout_minutes INT DEFAULT 15,
    max_concurrent_sessions INT DEFAULT 5,
    lockout_threshold INT DEFAULT 5,
    lockout_initial_minutes INT DEFAULT 15,
    lockout_second_minutes INT DEFAULT 30,
    lockout_third_plus_minutes INT DEFAULT 1440,
    captcha_threshold INT DEFAULT 3,
    login_log_retention_days INT DEFAULT 180,
    mfa_mode VARCHAR(20) DEFAULT 'disabled',
    mfa_allowed_methods JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id)
);
```

---

## 7. 入侵检测

> 等保要求：应能发现网络攻击行为并记录。

### 7.1 登录异常检测

| 检测规则 | 触发条件 | 严重级别 | 响应动作 |
|---------|---------|---------|---------|
| 暴力破解 | 同一 IP 15 分钟内 >= 10 次失败 | 高 | 封禁 IP + 告警 |
| 撞库攻击 | 同一 IP 15 分钟内 >= 5 个不同用户名 | 高 | 封禁 IP + 告警 |
| 异地登录 | 同一用户 30 分钟内不同城市 | 中 | 强制 2FA + 告警 |
| 异常时段 | 23:00-06:00 登录 | 低 | 记录 |
| 并发异常 | 同一用户 >= 3 个不同 IP | 中 | 撤销会话 + 告警 |

### 7.2 操作异常检测

| 检测规则 | 触发条件 | 严重级别 | 响应动作 |
|---------|---------|---------|---------|
| 批量导出 | > 1000 条记录 | 中 | 告警管理员 |
| 权限提升 | 用户变为 admin | 高 | 即时告警 |
| 批量删除 | > 50 条记录 | 高 | 告警 + 二次确认 |
| 安全策略降级 | MFA required -> disabled | 高 | 即时告警 |

### 7.3 系统异常检测

| 检测规则 | 触发条件 | 严重级别 | 响应动作 |
|---------|---------|---------|---------|
| 服务异常重启 | 1 小时内 >= 3 次 | 高 | 告警 + 隔离 |
| 证书即将过期 | 剩余 < 7 天 | 高 | 紧急告警 |
| 异常流量 | 单 IP QPS > 阈值 5 倍 | 高 | 限流 + 告警 |

### 7.4 security_events 表

> **所有权**：由 Auth Service 拥有和管理。

```sql
CREATE TABLE security_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT,
    event_category VARCHAR(50) NOT NULL,        -- login_anomaly / operation_anomaly / system_anomaly / intrusion
    event_type VARCHAR(100) NOT NULL,           -- brute_force / credential_stuffing / geo_anomaly / ...
    severity VARCHAR(20) NOT NULL,              -- low / medium / high / critical
    title VARCHAR(255) NOT NULL,
    description TEXT,
    source_ip VARCHAR(45),
    user_id BIGINT,
    user_agent VARCHAR(512),
    status VARCHAR(20) NOT NULL DEFAULT 'open', -- open / investigating / resolved / false_positive
    status_changed_at DATETIME NOT NULL,
    response_action VARCHAR(100),
    resolved_by BIGINT,
    resolved_at DATETIME,
    resolution TEXT,
    metadata JSON,
    related_event_id BIGINT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_security_events_tenant ON security_events(tenant_id);
CREATE INDEX idx_security_events_category ON security_events(event_category);
CREATE INDEX idx_security_events_severity ON security_events(severity);
CREATE INDEX idx_security_events_status ON security_events(status);
CREATE INDEX idx_security_events_time ON security_events(created_at DESC);
CREATE INDEX idx_security_events_ip ON security_events(source_ip);
```

**自动响应**：

| 严重级别 | 自动动作 | 通知方式 |
|---------|---------|---------|
| Critical | IP 封禁 + 会话撤销 | 短信 + 邮件 + webhook |
| High | IP 封禁 | 邮件 + webhook |
| Medium | 记录 + 标记 | 汇总通知 |
| Low | 仅记录 | 日报 |

**安全事件查询 API**：

```http
GET /api/v1/security/events?severity=high&status=open&start_time=2026-09-01T00:00:00Z
```

---

## 8. 审计日志

> 等保要求：审计记录应受到保护，避免未授权的删除、修改。

### 8.1 链式哈希防篡改

每条审计日志记录包含前一条记录的哈希，形成链式结构：

```
Record 1: hash_1 = SHA256(data_1 + prev_hash_0)     <- prev_hash_0 = "0" * 64
Record 2: hash_2 = SHA256(data_2 + hash_1)
...
Record N: hash_N = SHA256(data_N + hash_{N-1})
```

适用表：`config_changelog`、`operation_logs`、`login_logs`、`auth_audit_log`。

链键 = `(site_id, tenant_id, entity_type)`，每个链键维护独立的哈希链。

```rust
fn canonical_hash_input(record: &AuditRecord, prev_hash: &str) -> String {
    let obj = json!({
        "a": record.action, "eid": record.entity_id, "et": record.entity_type,
        "ph": prev_hash, "t": record.created_at.to_rfc3339(), "tid": record.tenant_id,
    });
    serde_json::to_string(&obj).unwrap()
}
```

**完整性校验 API**：

```http
POST /api/v1/audit/verify-integrity
{ "entity_type": "config_changelog", "tenant_id": 1, "site_id": "us-east-1",
  "start_time": "2026-09-01T00:00:00Z", "end_time": "2026-09-09T23:59:59Z" }
```

### 8.2 集中归档（Parquet）

```
各服务审计表（在线查询，热数据）
    |  每日定时任务（凌晨 03:00），归档 30 天前的记录
    v
归档存储（Parquet + AES-256-GCM 加密 + S3/OSS）
```

归档白名单：`config_changelog`, `operation_logs`, `login_logs`, `auth_audit_log`, `security_events`。

**保留策略**：

| 日志类型 | 在线保留 | 归档保留 |
|---------|---------|---------|
| login_logs | 180 天 | 3 年 |
| auth_audit_log | 180 天 | 3 年 |
| config_changelog | 90/180/永久 | 3 年 |
| operation_logs | 90-365 天 | 3 年 |
| security_events | 365 天 | 5 年 |

### 8.3 auth_audit_log 表 DDL

> 已在 2.1.19 节完整定义，包含链式哈希字段 `prev_hash` 和 `chain_hash`。

---

## 9. 密钥生命周期管理

> 等保要求：应采用密码技术对密钥进行安全保护。

### 9.1 JWT 密钥轮换

#### 9.1.1 多密钥并行

```toml
[api.jwt]
signing_key = "${JWT_SIGNING_KEY_ACTIVE}"
signing_kid = "jwt-2026-q3"
accepted_keys = [
  { kid = "jwt-2026-q2", key = "${JWT_SIGNING_KEY_OLD}" },
]
rotation_interval_days = 90
transition_period_days = 14
```

#### 9.1.2 轮换流程

```
Day 0:   生成新密钥 -> signing_key 切换 -> 旧密钥移入 accepted_keys
Day 0-14: 过渡期（旧 Token 自然过期）
Day 14:  旧密钥从 accepted_keys 移除 -> 轮换完成
```

#### 9.1.3 JWT Header kid

```json
{ "alg": "HS256", "typ": "JWT", "kid": "jwt-2026-q3" }
```

迁移策略：升级时 `migration_mode = true` 允许无 kid 旧 Token；8 小时后关闭。

### 9.2 密钥层级

```
Master Key（主密钥，离线保存 / HSM）
    |
    +-- JWT Signing Key（90 天轮换）-- HKDF 派生
    +-- DEK（数据加密密钥）-- HKDF 派生
    +-- BEK（备份加密密钥，90 天轮换）-- HKDF 派生
    +-- Email HMAC Key（盲索引，180 天轮换）-- HKDF 派生

独立密钥（不从 Master Key 派生）：
    HMAC Service Keys（服务间签名，手动轮换，由 nextswitch-keygen 生成）
```

| 密钥类型 | 用途 | 轮换方式 | 存储位置 |
|---------|------|---------|---------|
| Master Key | 根信任 | 手动，离线 | HSM |
| JWT Signing Key | Token 签名 | 90 天 | KMS/Vault |
| DEK | 字段加密 | HKDF 派生 | KMS/Vault |
| BEK | 备份加密 | 90 天 | KMS/Vault |
| HMAC Service Keys | 服务间签名 | 手动 | 环境变量 |

**安全约束**：密钥禁止硬编码、禁止出现在日志/错误/API 响应中，仅通过 TLS 或离线介质传输。

---

## 10. 数据备份与灾难恢复

> 等保要求：应提供重要数据的本地备份和恢复机制；应提供异地实时备份。

### 10.1 全量备份

```
站点 A（主）                              站点 B（灾备）
  MySQL 主库 -- binlog 复制(延迟30min) -->  MySQL 从库
  每日 xtrabackup -- 加密上传 -->          异地 S3
  Redis 主 -- 不需备份（缓存性质）--       Redis 副本
  录音文件 -- 异步同步 -->                对象存储
```

| 备份类型 | 频率 | 保留 | 工具 | 位置 |
|---------|------|------|------|------|
| 全量物理备份 | 每日 02:00 | 30 天 | xtrabackup | 本地 + 异地 |
| binlog 增量 | 实时 | 7 天 | binlog 复制 | 异地从库 |
| 逻辑备份 | 每周日 03:00 | 90 天 | mysqldump | 异地对象存储 |

备份加密：xtrabackup `--encrypt=AES256`，密钥通过环境变量传入。

### 10.2 Binlog 复制

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = 'site-a-db-primary', SOURCE_PORT = 3306,
  SOURCE_USER = 'repl_user', SOURCE_PASSWORD = '${REPL_PASSWORD}',
  SOURCE_SSL = 1, SOURCE_SSL_CA = '/etc/mysql/certs/ca.pem',
  SOURCE_SSL_VERIFY_SERVER_CERT = ON;
CHANGE REPLICATION SOURCE TO SOURCE_DELAY = 1800;  -- 30 分钟延迟
```

**Redis 备份**：Redis 存储的数据均为缓存/会话性质，可从数据库重建，不需独立备份。

### 10.3 RPO/RTO 目标

| 指标 | 目标 | 说明 |
|------|------|------|
| RPO | <= 30 分钟 | binlog 延迟 30 分钟 |
| RTO | <= 4 小时 | 从异地备份恢复 |

**恢复流程**：

- 单节点故障 -> 自动切换（MySQL 主从/Redis Sentinel），RTO < 1 分钟
- 单站点故障 -> DNS 切换 + 从库提升，RTO < 4 小时
- 数据损坏 -> 全量恢复 + binlog PITR，RTO < 4 小时

**恢复演练**：桌面推演（季度）、模拟恢复（半年）、全量切换（年）。

---

## 11. 网络安全与应急响应

> 等保要求：应划分不同的网络区域；应制定安全事件应急预案。

### 11.1 网络分区（DMZ/App/Data/Management）

```
┌──────────────────────────────────────────────────────┐
│                        VPC                            │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  DMZ 区       │  │  应用区       │  │  数据区     │  │
│  │  10.0.0.0/24 │  │  10.0.1.0/24 │  │ 10.0.2.0/24│  │
│  │  LB/Nginx    │->│  API 服务     │->│  MySQL     │  │
│  │  WAF         │  │  sipserver   │  │  Redis     │  │
│  │              │  │  signal/med  │  │            │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                       │
│  ┌──────────────┐                                     │
│  │  管理区       │                                     │
│  │  10.0.3.0/24 │  <- 仅管理区可 SSH 到所有区域       │
│  │  堡垒机       │                                     │
│  │  Prometheus  │                                     │
│  │  Grafana     │                                     │
│  └──────────────┘                                     │
└──────────────────────────────────────────────────────┘
```

**安全组规则**：

| 源 | 目标 | 端口 | 说明 |
|----|------|------|------|
| 互联网 | DMZ | 443, 5060-5061, 8443, 10000-60000/UDP | SIP + HTTPS + RTP |
| DMZ | 应用区 | 8080 | API 请求 |
| 应用区 | 数据区 | 3306, 6379 | MySQL + Redis（TLS） |
| 应用区 | 应用区 | 50051 | gRPC（mTLS） |
| 管理区 | 所有区 | 22 | SSH（仅堡垒机） |
| 管理区 | 应用区 | 9090-9093 | Metrics |
| 其他 | 其他 | * | **DENY** |

### 11.2 SSH 加固

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
AllowUsers deploy monitoring
AllowGroups ssh-access
```

所有远程管理必须通过堡垒机，堡垒机启用 MFA，记录所有操作。

### 11.3 事件响应（P1-P4）

| 级别 | 定义 | 示例 | 响应时间 |
|------|------|------|---------|
| P1 特别重大 | 核心数据泄露 | 数据库被拖库、密钥泄露 | 15 分钟 |
| P2 重大 | 服务大面积不可用 | DDoS、管理员账号被盗 | 30 分钟 |
| P3 较大 | 单租户数据异常 | 暴力破解成功、配置被篡改 | 2 小时 |
| P4 一般 | 可疑行为 | 异常登录尝试、端口扫描 | 24 小时 |

**响应流程**：发现与报告 -> 初步评估 -> 遏制 -> 根除 -> 恢复 -> 复盘

**联系链**：
- P1：值班运维 -> 安全负责人 -> CTO -> CEO（电话+短信+群）
- P2：值班运维 -> 安全负责人 -> 技术总监（短信+群）
- P3：值班运维 -> 安全负责人（群+邮件）
- P4：安全系统 -> 安全负责人（日报）

---

## 12. 残留信息保护

> 等保要求：应保证鉴别信息所在的存储空间被释放或重新分配前得到完全清除。

### 12.1 会话数据清除

登出时完整清理：

1. 删除 Redis Refresh Token（`auth:refresh:{jti}`）
2. Access Token 加入黑名单（`auth:blacklist:{jti}`）
3. 删除 sessions 表记录
4. 清除用户权限缓存（`auth:permissions:{user_id}:{tenant_id}`）
5. 清除用户菜单缓存（`auth:menus:{user_id}:{tenant_id}`）
6. 清除用户数据权限缓存（`auth:data_scopes:{user_id}:{tenant_id}`）
7. 清除用户信息缓存（`auth:user_info:{user_id}`）

> **修正说明**：原文档引用了不存在的 `auth:perms:{user_id}` 和 `auth:config_cache:{user_id}`，已修正为正确的 Key。

### 12.2 内存敏感数据清除

```rust
pub async fn process_sip_auth(username: &str, password: &SipPassword, ext: &Extension) -> AuthResult {
    let result = verify_sip_digest(username, password.as_ref(), &ext.challenge)?;
    // password 在函数结束后自动 zeroize（Drop trait）
    result
}
```

### 12.3 临时文件清除

```rust
pub async fn cleanup_temp_files(file_path: &Path) -> Result<()> {
    let file_size = tokio::fs::metadata(file_path).await?.len();
    tokio::fs::write(file_path, &vec![0u8; file_size as usize]).await?;  // 覆写
    tokio::fs::remove_file(file_path).await?;                            // 删除
    Ok(())
}
```

### 12.4 数据删除策略

| 数据类型 | 删除方式 | 说明 |
|---------|---------|------|
| 会话 Token | Redis DEL + 内存清零 | 即时删除 |
| 用户账号 | 软删除 -> 30 天后硬删除 | 清除所有关联数据 |
| 租户数据 | 软删除 -> 90 天后硬删除 | 清除所有配置、日志 |
| 审计日志 | 到期物理删除 | 定时任务 |
| 临时文件 | 覆写 + 删除 | 防止磁盘残留 |
| 内存敏感数据 | Zeroize on Drop | Rust Drop trait |

---

## Appendix A: Redis Key 命名空间

### 认证相关

| Key 模式 | 说明 | TTL |
|---------|------|-----|
| `auth:permissions:{user_id}:{tenant_id}` | 用户权限列表 | 2h |
| `auth:menus:{user_id}:{tenant_id}` | 用户菜单树 | 2h |
| `auth:data_scopes:{user_id}:{tenant_id}` | 用户数据权限 | 2h |
| `auth:user_info:{user_id}` | 用户基本信息 | 2h |
| `auth:refresh:{jti}` | Refresh Token | = refresh TTL |
| `auth:blacklist:{jti}` | Access Token 黑名单 | = 剩余有效期 |
| `auth:session:{session_id}` | 会话信息 | = idle_timeout |
| `auth:security_policy:{tenant_id}` | 租户安全策略 | 1h |
| `auth:failures:user:{username}` | 用户名登录失败计数 | = 锁定时间 |
| `auth:failures:ip:{ip_address}` | IP 登录失败计数 | = 锁定时间 |
| `auth:captcha:{captcha_id}` | 图形验证码 | 5min |

### 安全相关

| Key 模式 | 说明 | TTL |
|---------|------|-----|
| `security:blocked_ip:{ip}` | IP 封禁 | 封禁时长 |

### 服务心跳

| Key 模式 | 说明 | TTL |
|---------|------|-----|
| `heartbeat:{service}:{instance_id}` | 服务心跳 | 服务配置 |

示例：`heartbeat:sipserver:sipserver-03`、`heartbeat:medserver:medserver-01`

> **已移除的不存在 Key**：
> - ~~`auth:perms:{user_id}`~~ -- 不存在，已替换为 `auth:permissions:{user_id}:{tenant_id}`
> - ~~`auth:config_cache:{user_id}`~~ -- 不存在，已移除

---

## Appendix B: 安全相关 REST API（汇总）

### 认证 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth/captcha` | 获取验证码 |
| POST | `/api/v1/auth/login` | 登录 |
| POST | `/api/v1/auth/logout` | 登出 |
| POST | `/api/v1/auth/refresh` | 刷新 Token |
| GET | `/api/v1/auth/me` | 当前用户信息 |
| PUT | `/api/v1/auth/password` | 修改密码 |
| POST | `/api/v1/auth/change-password` | 强制修改密码 |

### 2FA API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth/mfa/status` | 2FA 状态 |
| POST | `/api/v1/auth/mfa/setup` | 初始化 2FA |
| POST | `/api/v1/auth/mfa/verify-setup` | 验证设置 |
| DELETE | `/api/v1/auth/mfa/disable` | 禁用 2FA |
| POST | `/api/v1/auth/mfa/send-code` | 发送验证码 |
| POST | `/api/v1/auth/mfa/verify` | 验证 2FA 码 |

### 安全管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| DELETE | `/api/v1/users/{id}/sessions` | 撤销会话 |
| POST | `/api/v1/users/{id}/unlock` | 解锁账号 |
| GET | `/api/v1/audit/login-logs` | 登录审计日志 |
| GET | `/api/v1/security/events` | 安全事件查询 |
| POST | `/api/v1/audit/verify-integrity` | 审计日志完整性校验 |

---

## Appendix C: 错误码定义

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `VALIDATION_ERROR` | 400 | 参数校验失败 |
| `UNAUTHORIZED` | 401 | 未认证或 Token 过期 |
| `SESSION_EXPIRED` | 401 | 会话已过期 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 唯一约束冲突 |
| `MFA_REQUIRED` | 401 | 需要 2FA 验证 |
| `MFA_SETUP_REQUIRED` | 403 | 租户强制 2FA，用户未设置 |
| `MFA_INVALID` | 401 | 2FA 验证码错误 |
| `CAPTCHA_REQUIRED` | 400 | 需要验证码 |
| `CAPTCHA_INVALID` | 400 | 验证码错误 |
| `CAPTCHA_EXPIRED` | 400 | 验证码已过期 |
| `ACCOUNT_LOCKED` | 423 | 账号已锁定（含 `locked_until`） |
| `PASSWORD_EXPIRED` | 403 | 密码已过期 |
| `PASSWORD_REUSE` | 400 | 密码与历史密码重复 |
| `PASSWORD_COMPLEXITY` | 400 | 密码不满足复杂度 |
| `USER_LOCKED` | 423 | 用户已锁定 |
| `INTERNAL_ERROR` | 500 | 内部错误 |

---

## 变更历史

### v2.0.0 (2026-09-09)

**合并来源**：

- `auth-service-design.md` v1.1.0 -- 用户认证与授权
- `service-to-service-auth-design.md` Draft -- 服务间 HMAC 认证
- `security-mlps3-supplement.md` v1.0.0 -- 等保三级安全补充

**合并变更**：

1. **结构重组**：将三份独立文档合并为统一的安全设计规格书，消除重复内容（登录流程在 auth-service 和 security-mlps3 中各描述一次），使用顺序章节编号替代原来的重复编号。

2. **新增 `auth_audit_log` 表 DDL**（2.1.19 节）：原文档中 `auth_audit_log` 被引用 4 次但从未定义，现已补充完整 DDL，包含链式哈希字段。

3. **新增 `user_extensions` 表 DDL**（2.1.4 节）：原文档中提及但未定义，现已补充完整 DDL。

4. **修正 email 盲索引位置**（2.1.5 节）：原 security-mlps3-supplement 中 `CREATE UNIQUE INDEX idx_users_email_blind ON users(tenant_id, email_blind_index)` 有误（`users` 表无 `tenant_id` 列），已移至 `tenant_users` 表：`CREATE UNIQUE INDEX idx_tenant_users_email_blind ON tenant_users(tenant_id, email_blind_index)`。

5. **修正不存在的 Redis Key**：原 security-mlps3-supplement 登出流程引用了 `auth:perms:{user_id}` 和 `auth:config_cache:{user_id}`，这两个 Key 不存在。已替换为正确的 `auth:permissions:{user_id}:{tenant_id}` 等 Key，并在 Appendix A 中标注已移除项。

6. **新增 router-server 到信任矩阵**（3.5 节）：原 service-to-service-auth 信任矩阵缺少 router-server，已补充。

7. **明确 security_events 表所有权**（7.4 节）：显式标注由 Auth Service 拥有。

8. **统一心跳 Key 格式**：统一为 `heartbeat:{service}:{instance_id}` 结构化格式（如 `heartbeat:sipserver:sipserver-03`）。

9. **修正章节编号**：原 auth-service-design 存在重复的 Section 8 和 Section 9，合并后使用顺序编号。

---

**文档结束**
