# Nextswitch 配置中心与 API 网关设计规格书

## 文档信息

| 字段 | 值 |
|------|-----|
| Version | 2.0.0 |
| Date | 2026-09-09 |
| Status | Active |
| Supersedes | config-service-design v1.2.0, nextswitch-api-design v1.0.0 |

---

## 1. 概述

### 1.1 设计目标

本文档定义 Nextswitch 平台两个核心基础设施服务的设计规格：

- **Config Service（配置中心）**：负责所有配置数据的存储、版本控制、变更通知和审计。
- **Nextswitch API（API 网关）**：统一 API 入口，负责请求路由、认证鉴权、速率限制、监控聚合和 WebSocket 代理。

两者的关系：

- **Config Service 是配置数据的所有者（Owner）**，直接读写数据库。
- **API 网关是瘦代理（Thin Proxy）**，对配置 API 仅做请求转发，不存储业务状态。
- **Config Service 是配置变更的发布者（Publisher）**，通过 Redis Pub/Sub 推送变更事件。
- **API 网关是配置变更的订阅者（Subscriber）**，接收变更事件后通过 WebSocket 转发给前端客户端。

### 1.2 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web UI / 客户端                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTPS (443)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Load Balancer / Ingress                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     nextswitch-api（API 网关）                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              中间件流水线（Middleware Pipeline）             │   │
│  │  CORS → Rate Limit → Request ID & Trace → JWT Auth →     │   │
│  │  Permission → Handler                                     │   │
│  └─────────────────────────┬────────────────────────────────┘   │
│                             │                                    │
│    ┌────────┬────────┬──────┴───┬──────────┬──────────┐         │
│    ▼        ▼        ▼          ▼          ▼          ▼         │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐    │
│ │Auth  │ │Config│ │ CTI  │ │  IM  │ │Monitor│ │Security │    │
│ │Proxy │ │Proxy │ │Proxy │ │Proxy │ │Aggreg.│ │ Proxy   │    │
│ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └────┬────┘    │
│    │        │        │        │        │          │             │
└────┼────────┼────────┼────────┼────────┼──────────┼─────────────┘
     │        │        │        │        │          │
     ▼        ▼        ▼        ▼        ▼          ▼
┌────────┐ ┌────────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│Auth    │ │Config      │ │CTI     │ │IM      │ │各实例   │ │Auth      │
│Service │ │Service     │ │Server  │ │Server  │ │/health │ │Service   │
│        │ │(配置所有者) │ │        │ │        │ │        │ │(安全模块) │
└────────┘ └────────────┘ └────────┘ └────────┘ └────────┘ └──────────┘
     │        │
     ▼        ▼
┌────────┐ ┌────────────┐
│ Redis  │ │ MySQL 8    │
│(Cache) │ │(Config DB) │
└────────┘ └────────────┘
```

### 1.3 设计原则

**Config Service**：

- **站点无关**：配置数据是逻辑概念，与物理站点无关。
- **多租户隔离**：通过 `tenant_id` 字段隔离，共享数据库。
- **无外键约束**：应用层保证引用完整性（宪法 Principle IX）。
- **BIGINT 主键**：所有表使用 BIGINT AUTO_INCREMENT 主键。
- **应用管理时间戳**：`created_at` 和 `updated_at` 由应用写入，不使用数据库默认值。

**API 网关**：

- **独立 crate**：`nextswitch-api` crate，作为独立 binary 部署。
- **模块化路由**：各 API 模块逻辑独立，共享中间件。
- **无状态**：API 层不存储业务状态，权限从 Redis 缓存获取。
- **端口规范**：遵循宪法 V.2，HTTP API 端口 8080，metrics 端口 9093。

---

# Part I: 配置中心

## 2. 数据模型

### 2.1 核心概念

#### 2.1.1 站点（Site）vs 租户（Tenant）

**站点（Site）**：
- **物理概念**：代表服务器/数据中心的物理部署位置。
- 独立实体，不属于任何租户。
- 包含物理地址、容量、地域/可用区信息。
- 示例：`us-east-1`、`eu-west-1`、`ap-southeast-1`。

**租户（Tenant）**：
- **逻辑概念**：代表使用系统的客户/组织。
- 独立实体，可以跨多个站点部署。
- 包含租户名称、标识、状态等信息。
- 示例：`company-a`、`company-b`。

**关系**：
- 站点和租户是多对多关系（系统自动分配，无需显式映射表）。
- 配置资源（分机、坐席、队列等）只属于租户，与站点无关。
- 运行时数据（登录、注册、呼叫）由 sipserver/medserver 管理，包含站点信息。

#### 2.1.2 技能组（Skill Group）vs 呼叫队列（Call Queue）

**技能组（Skill Group）**：
- **定义**：坐席的能力标签/分类。
- **作用**：
  - 标记坐席具备哪些技能（如"英语"、"技术支持"、"VIP 服务"）。
  - 用于路由决策：哪些坐席有资格处理某类呼叫。
  - 一个坐席可以属于多个技能组。
- **特点**：
  - 不直接处理呼叫。
  - 是分类/标签机制。
  - 可以跨站点（逻辑概念）。
- **示例**：
  ```
  技能组：
    - "English Speakers"（会说英语的坐席）
    - "Technical Support"（技术支持专家）
    - "VIP Service"（VIP 服务团队）
    - "Sales Team"（销售团队）

  坐席分配（通过 agent_skills 关联表）：
    - 张三 → English Speakers (熟练度=5, 等级=3), Technical Support (熟练度=4, 等级=2)
    - 李四 → English Speakers (熟练度=3, 等级=1), Sales Team (熟练度=5, 等级=3, 主技能)
    - 王五 → Technical Support (熟练度=4, 等级=2, 主技能), VIP Service (熟练度=2, 等级=1)
  ```

**呼叫队列（Call Queue）**：
- **定义**：呼叫的实际等待队列。
- **作用**：
  - 呼叫进入队列后排队等待，直到有坐席可用。
  - 配置排队策略（FIFO、优先级、轮询等）。
  - 配置等待体验（等待音乐、提示音、最大等待时间）。
  - 可以关联技能组，决定哪些坐席应该处理队列中的呼叫。
- **特点**：
  - 实际处理呼叫排队。
  - 有具体的排队配置。
  - 通常关联到一个技能组。
- **示例**：
  ```
  呼叫队列：
    - "Sales Queue"（销售队列）
      - 关联技能组："Sales Team"
      - 策略：FIFO
      - 等待音乐：sales_hold_music.mp3
      - 最大等待：300 秒

    - "Tech Support Queue"（技术支持队列）
      - 关联技能组："Technical Support"
      - 策略：优先级（VIP 优先）
      - 等待音乐：tech_hold_music.mp3
      - 最大等待：600 秒
  ```

**关系与协作**：
```
来电 → 路由规则 → 呼叫队列（排队等待）
                      ↓
                 关联技能组
                      ↓
                 查找可用坐席（属于该技能组且状态为 ready）
                      ↓
                 分配给坐席
```

**设计决策：保留两个表**

保留 `skill_groups` 和 `call_queues` 两个独立表的理由：

1. **职责清晰**：
   - 技能组 = 能力标签（坐席具备什么技能）。
   - 队列 = 排队逻辑（呼叫如何等待和分配）。

2. **灵活性**：
   - 一个技能组可以被多个队列复用。
   - 例如："Technical Support"技能组可以用于"Tech Queue"和"VIP Tech Queue"。

3. **扩展性**：
   - 队列可以不关联技能组（直接指定坐席列表）。
   - 未来可以基于技能组做更智能的路由（如"查找技能匹配度最高的坐席"）。

4. **实际场景**：
   ```
   场景 1：简单队列（无技能组）
     呼叫队列："General Queue"
       - 不关联技能组
       - 直接分配给固定的坐席列表
       - 适用：小型呼叫中心，所有坐席能力相同

   场景 2：技能路由（队列 + 技能组）
     呼叫队列："Tech Support Queue"
       - 关联技能组："Technical Support"
       - 当呼叫进入队列时，系统查找属于该技能组且状态为 ready 的坐席
       - 适用：需要根据技能分配呼叫

   场景 3：多技能路由（基于 agent_skills 关联表）
     坐席张三：English (熟练度=5, 等级=3), Technical Support (熟练度=4, 等级=2)
     坐席李四：Chinese (熟练度=5, 等级=3), Technical Support (熟练度=3, 等级=1)

     呼叫队列："Tech Support Queue" → 关联技能组 "Technical Support"
       - 英语来电 → 路由到 "English Queue" → 分配给张三（熟练度=5）
       - 中文来电 → 路由到 "Chinese Queue" → 分配给李四（熟练度=5）
       - 技术来电 → 路由到 "Tech Support Queue"
         → 优先分配给张三（熟练度=4 > 李四熟练度=3）
   ```

---

### 2.2 数据库表结构

> **注意**：所有表遵循宪法 Principle IX：
> - 主键：`BIGINT AUTO_INCREMENT`
> - 时间戳：`DATETIME NOT NULL`，应用管理，无数据库默认值
> - 无外键约束：引用字段使用 `BIGINT`，应用层保证完整性
> - 每张表必须包含 `id`、`created_at`、`updated_at`

#### 2.2.1 站点表（sites）

```sql
CREATE TABLE sites (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    site_id VARCHAR(100) NOT NULL UNIQUE,     -- 如 us-east-1
    region VARCHAR(100) NOT NULL,             -- 地域
    az_id VARCHAR(100),                       -- 可用区
    address TEXT,                             -- 物理地址
    capacity INT DEFAULT 10000,               -- 站点容量
    status VARCHAR(20) DEFAULT 'active',
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

#### 2.2.2 租户表（tenants）

```sql
CREATE TABLE tenants (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,        -- URL 友好标识
    status VARCHAR(20) DEFAULT 'active',
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

#### 2.2.3 分机表（extensions）

```sql
CREATE TABLE extensions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    extension VARCHAR(20) NOT NULL,
    display_name VARCHAR(255),
    password_hash VARCHAR(255),
    email VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active',
    codec_preference JSON NOT NULL,                -- 默认值应用层设置：["pcmu","pcma"]
    call_timeout INT DEFAULT 30,
    forwarding JSON NOT NULL,
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, extension)
);
CREATE INDEX idx_extensions_tenant_id ON extensions(tenant_id);
```

#### 2.2.4 坐席表（agents）

```sql
CREATE TABLE agents (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    extension_id BIGINT,                      -- 关联分机
    agent_id VARCHAR(100) NOT NULL,           -- 坐席工号
    name VARCHAR(255) NOT NULL,
    max_concurrent_calls INT DEFAULT 1,
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, agent_id)
);
CREATE INDEX idx_agents_tenant_id ON agents(tenant_id);
CREATE INDEX idx_agents_extension_id ON agents(extension_id);
```

#### 2.2.5 技能组表（skill_groups）

```sql
CREATE TABLE skill_groups (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    strategy VARCHAR(50) DEFAULT 'round_robin',  -- 分配策略
    timeout INT DEFAULT 30,                      -- 振铃超时
    wrap_up_time INT DEFAULT 10,                 -- 话后处理时间
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_skill_groups_tenant_id ON skill_groups(tenant_id);
```

#### 2.2.6 坐席技能关联表（agent_skills）

> 坐席与技能组的多对多关联关系，支持通过技能组查询所有关联坐席，并记录坐席在该技能组中的熟练度等级和坐席等级。

```sql
CREATE TABLE agent_skills (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    agent_id BIGINT NOT NULL,                   -- 关联 agents.id
    skill_group_id BIGINT NOT NULL,             -- 关联 skill_groups.id

    -- 技能等级：坐席在该技能组中的熟练度（1-5，值越高越熟练）
    -- 用于 ACD 路由分配：相同技能组内，优先分配给熟练度高的坐席
    proficiency_level INT NOT NULL DEFAULT 3,

    -- 坐席等级：坐席在该技能组中的级别（1-10，值越高权限越大）
    -- 用于影响排队分配权重、溢出优先级、班长席判定等
    agent_level INT NOT NULL DEFAULT 1,

    -- 是否为主技能（坐席最擅长的技能组，每个坐席最多一个）
    is_primary BOOLEAN DEFAULT FALSE,

    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, agent_id, skill_group_id)
);
CREATE INDEX idx_agent_skills_tenant_id ON agent_skills(tenant_id);
CREATE INDEX idx_agent_skills_agent_id ON agent_skills(agent_id);
CREATE INDEX idx_agent_skills_skill_group_id ON agent_skills(skill_group_id);
CREATE INDEX idx_agent_skills_lookup ON agent_skills(tenant_id, skill_group_id, proficiency_level DESC);
```

**设计说明**：

| 字段 | 用途 | 路由影响 |
|------|------|---------|
| `proficiency_level` | 坐席在该技能的熟练度（1-5） | 技能匹配后按熟练度降序分配 |
| `agent_level` | 坐席在该技能组中的级别（1-10） | 影响分配权重、班长席判定、溢出优先级 |
| `is_primary` | 是否为坐席的主技能 | 主技能坐席优先被分配 |

**典型查询**：

```sql
-- 通过技能组查询所有关联坐席（按熟练度降序）
SELECT a.*, as_.proficiency_level, as_.agent_level, as_.is_primary
FROM agent_skills as_
JOIN agents a ON a.id = as_.agent_id
WHERE as_.tenant_id = ? AND as_.skill_group_id = ?
ORDER BY as_.proficiency_level DESC, as_.agent_level DESC;

-- 查询坐席的所有技能
SELECT sg.name, as_.proficiency_level, as_.agent_level, as_.is_primary
FROM agent_skills as_
JOIN skill_groups sg ON sg.id = as_.skill_group_id
WHERE as_.tenant_id = ? AND as_.agent_id = ?;
```

#### 2.2.7 呼叫队列表（call_queues）

```sql
CREATE TABLE call_queues (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    extension VARCHAR(20),                       -- 队列接入号
    strategy VARCHAR(50) DEFAULT 'fifo',         -- 排队策略
    max_wait_time INT DEFAULT 300,               -- 最大等待时间（秒）
    max_queue_size INT DEFAULT 100,              -- 最大排队数
    music_on_hold VARCHAR(255),                  -- 等待音乐
    announcement VARCHAR(255),                   -- 进入队列提示音
    skill_group_id BIGINT,                       -- 关联的技能组
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_call_queues_tenant_id ON call_queues(tenant_id);
CREATE INDEX idx_call_queues_skill_group_id ON call_queues(skill_group_id);
```

#### 2.2.8 中继表（trunks）

```sql
CREATE TABLE trunks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    trunk_type VARCHAR(50) NOT NULL,             -- sip/iax2/pstn
    host VARCHAR(255) NOT NULL,
    port INT DEFAULT 5060,
    transport VARCHAR(20) DEFAULT 'udp',
    auth_username VARCHAR(255),
    auth_password VARCHAR(255),
    codec_preference JSON NOT NULL,                -- 默认值应用层设置：["pcmu","pcma"]
    max_channels INT DEFAULT 100,
    status VARCHAR(20) DEFAULT 'active',
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_trunks_tenant_id ON trunks(tenant_id);
```

#### 2.2.9 号码表（dids）

```sql
CREATE TABLE dids (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    trunk_id BIGINT,                             -- 关联中继
    call_flow_id BIGINT,                         -- 关联呼叫流程
    status VARCHAR(20) DEFAULT 'active',
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, phone_number)
);
CREATE INDEX idx_dids_tenant_id ON dids(tenant_id);
CREATE INDEX idx_dids_trunk_id ON dids(trunk_id);
CREATE INDEX idx_dids_call_flow_id ON dids(call_flow_id);
```

#### 2.2.10 路由点表（route_points）

```sql
CREATE TABLE route_points (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    extension VARCHAR(20),                       -- 路由点接入号
    description TEXT,
    route_type VARCHAR(50) NOT NULL,             -- extension/queue/trunk/ivr/call_flow/conference/external
    route_target VARCHAR(255) NOT NULL,          -- 路由目标 ID 或号码
    priority INT DEFAULT 0,
    fallback_target VARCHAR(255),                -- 失败时的备用目标
    timeout INT DEFAULT 30,
    status VARCHAR(20) DEFAULT 'active',
    settings JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_route_points_tenant_id ON route_points(tenant_id);
CREATE INDEX idx_route_points_extension ON route_points(tenant_id, extension);
```

#### 2.2.11 IVR 流程表（ivr_flows）

```sql
CREATE TABLE ivr_flows (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    version INT DEFAULT 1,
    status VARCHAR(20) DEFAULT 'draft',          -- draft/active/archived
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_ivr_flows_tenant_id ON ivr_flows(tenant_id);
```

#### 2.2.12 IVR 节点表（ivr_nodes）

```sql
CREATE TABLE ivr_nodes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ivr_flow_id BIGINT NOT NULL,
    node_type VARCHAR(50) NOT NULL,              -- answer/play_prompt/collect_digits/match_digits/transfer/hangup 等
    position_x INT DEFAULT 0,                    -- 画布位置 X
    position_y INT DEFAULT 0,                    -- 画布位置 Y
    config JSON NOT NULL,                       -- 节点配置
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_ivr_nodes_flow_id ON ivr_nodes(ivr_flow_id);
```

#### 2.2.13 IVR 连线表（ivr_edges）

```sql
CREATE TABLE ivr_edges (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ivr_flow_id BIGINT NOT NULL,
    from_node_id BIGINT NOT NULL,
    to_node_id BIGINT NOT NULL,
    condition_expr VARCHAR(255),                 -- 条件表达式（如 digit=1）
    label VARCHAR(255),                          -- 连线标签
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_ivr_edges_flow_id ON ivr_edges(ivr_flow_id);
CREATE INDEX idx_ivr_edges_from_node ON ivr_edges(from_node_id);
CREATE INDEX idx_ivr_edges_to_node ON ivr_edges(to_node_id);
```

#### 2.2.14 IVR 提示音资源表（ivr_prompts）

```sql
CREATE TABLE ivr_prompts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    file_path VARCHAR(500) NOT NULL,
    file_format VARCHAR(20) DEFAULT 'wav',
    duration_ms INT,
    file_size BIGINT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_ivr_prompts_tenant_id ON ivr_prompts(tenant_id);
```

#### 2.2.15 拨号计划表（dial_plans）

```sql
CREATE TABLE dial_plans (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    pattern VARCHAR(100) NOT NULL,               -- 号码匹配模式
    priority INT DEFAULT 0,
    action VARCHAR(50) NOT NULL,                 -- allow/deny/transform
    replacement VARCHAR(100),
    description TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_dial_plans_tenant_id ON dial_plans(tenant_id);
```

#### 2.2.16 路由规则表（routing_rules）

```sql
CREATE TABLE routing_rules (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    condition_expr JSON NOT NULL,               -- 匹配条件
    action JSON NOT NULL,                       -- 路由动作
    priority INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_routing_rules_tenant_id ON routing_rules(tenant_id);
CREATE INDEX idx_routing_rules_priority ON routing_rules(tenant_id, priority);
```

#### 2.2.17 呼叫流程表（call_flows）

```sql
CREATE TABLE call_flows (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    flow_definition JSON NOT NULL,              -- 流程定义（节点 + 连线）
    status VARCHAR(20) DEFAULT 'draft',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_call_flows_tenant_id ON call_flows(tenant_id);
```

#### 2.2.18 时间段表（time_conditions）

```sql
CREATE TABLE time_conditions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    time_range JSON NOT NULL,                   -- 时间范围定义
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_time_conditions_tenant_id ON time_conditions(tenant_id);
```

#### 2.2.19 配置快照表（config_snapshots）

```sql
CREATE TABLE config_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    snapshot_type VARCHAR(50) NOT NULL,          -- full/daily/manual
    entity_type VARCHAR(100) NOT NULL,
    entity_id BIGINT,
    snapshot_data JSON NOT NULL,
    created_by BIGINT,
    description TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_config_snapshots_tenant_id ON config_snapshots(tenant_id);
CREATE INDEX idx_config_snapshots_entity ON config_snapshots(tenant_id, entity_type, entity_id);
```

#### 2.2.20 配置变更日志表（config_changelog）

```sql
CREATE TABLE config_changelog (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id BIGINT NOT NULL,
    action VARCHAR(20) NOT NULL,                 -- create/update/delete
    before_value JSON,
    after_value JSON,
    changed_by BIGINT NOT NULL,
    ip_address VARCHAR(45),
    description TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_config_changelog_tenant_id ON config_changelog(tenant_id);
CREATE INDEX idx_config_changelog_entity ON config_changelog(tenant_id, entity_type, entity_id);
CREATE INDEX idx_config_changelog_time ON config_changelog(created_at DESC);
```

#### 2.2.21 操作日志表（operation_logs）

> 统一记录所有业务操作日志，补充 config_changelog 仅覆盖配置变更的不足。由多个服务写入，Config Service 统一管理。

```sql
CREATE TABLE operation_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,

    -- 操作主体
    user_id BIGINT,                              -- 操作人 ID（系统操作为 NULL）
    service_name VARCHAR(100) NOT NULL,           -- 来源服务（sipserver / signalserver / nextswitch-api / config-service / auth-service / media-server）
    module VARCHAR(100) NOT NULL,                 -- 业务模块（call / agent / queue / trunk / system / import_export / security）

    -- 操作详情
    action VARCHAR(50) NOT NULL,                  -- 操作类型（transfer / intercept / barge_in / force_break / sign_in / sign_out / break / resume / export / import / service_start / service_stop 等）
    resource_type VARCHAR(100),                   -- 操作对象类型（call / agent / queue / extension / trunk / system 等）
    resource_id VARCHAR(255),                     -- 操作对象 ID（字符串，兼容跨服务 ID 格式）
    description TEXT NOT NULL,                    -- 操作描述（人类可读）

    -- 上下文
    request_method VARCHAR(10),                   -- HTTP 方法（GET/POST/PUT/DELETE）
    request_path VARCHAR(500),                    -- 请求路径
    ip_address VARCHAR(45),                       -- 操作人 IP
    user_agent VARCHAR(500),                      -- 客户端标识

    -- 结果
    status VARCHAR(20) NOT NULL DEFAULT 'success', -- success / failure / partial
    status_code INT,                              -- HTTP 状态码或业务状态码
    error_message TEXT,                           -- 失败时的错误信息

    -- 扩展
    metadata JSON,                               -- 操作相关的附加数据（如通话 ID、转接目标等）

    created_at DATETIME NOT NULL
);
CREATE INDEX idx_operation_logs_tenant_id ON operation_logs(tenant_id);
CREATE INDEX idx_operation_logs_user_id ON operation_logs(user_id);
CREATE INDEX idx_operation_logs_module ON operation_logs(tenant_id, module);
CREATE INDEX idx_operation_logs_action ON operation_logs(tenant_id, action);
CREATE INDEX idx_operation_logs_resource ON operation_logs(tenant_id, resource_type, resource_id);
CREATE INDEX idx_operation_logs_time ON operation_logs(created_at DESC);
CREATE INDEX idx_operation_logs_service ON operation_logs(service_name, created_at DESC);
```

**与 config_changelog 的区别**：

| 维度 | config_changelog | operation_logs |
|------|-----------------|----------------|
| 记录内容 | 配置数据变更（before/after） | 业务操作行为 |
| 写入方 | Config Service | 所有服务 |
| 典型场景 | 分机创建/修改/删除 | 通话转接、坐席签入、批量导出 |
| 数据格式 | JSON diff（before_value / after_value） | 操作描述 + metadata |
| 关联实体 | 必须有 entity_type + entity_id | 可选的 resource_type + resource_id |

**operation_logs 覆盖的操作类型**：

| module | 典型 action | 说明 |
|--------|------------|------|
| `call` | transfer / intercept / barge_in / force_break / hangup / hold / unhold | 通话控制操作 |
| `agent` | sign_in / sign_out / break / resume / state_change | 坐席状态变更 |
| `queue` | monitor / whisper / barge / force_transfer | 队列监控与干预 |
| `import_export` | export / import / backup / restore | 数据导入导出 |
| `system` | service_start / service_stop / config_reload / cache_clear | 系统管理操作 |
| `security` | unlock_user / reset_password / mfa_reset / policy_change | 安全管理操作 |

#### 2.2.22 租户安全策略表（tenant_security_policies）

> 遵循宪法 X：存储每个租户的安全策略配置，所有字段均有系统默认值。

```sql
CREATE TABLE tenant_security_policies (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,

    -- 密码复杂度（宪法 X.2）
    password_min_length INT DEFAULT 8,
    password_max_length INT DEFAULT 128,
    password_require_uppercase BOOLEAN DEFAULT TRUE,
    password_require_lowercase BOOLEAN DEFAULT TRUE,
    password_require_digit BOOLEAN DEFAULT TRUE,
    password_require_special BOOLEAN DEFAULT TRUE,
    password_block_common BOOLEAN DEFAULT TRUE,

    -- 密码历史（宪法 X.3）
    password_history_count INT DEFAULT 5,

    -- 密码有效期（宪法 X.4）
    password_max_age_days INT DEFAULT 90,
    password_expiry_warn_days INT DEFAULT 7,
    password_grace_logins INT DEFAULT 3,

    -- 会话管理（宪法 X.5）
    access_token_ttl_minutes INT DEFAULT 30,
    refresh_token_ttl_hours INT DEFAULT 8,
    idle_timeout_minutes INT DEFAULT 15,
    max_concurrent_sessions INT DEFAULT 5,

    -- 账号锁定（宪法 X.6）
    lockout_threshold INT DEFAULT 5,
    lockout_initial_minutes INT DEFAULT 15,
    lockout_second_minutes INT DEFAULT 30,
    lockout_third_plus_minutes INT DEFAULT 1440,
    captcha_threshold INT DEFAULT 3,

    -- 登录审计（宪法 X.1）
    login_log_retention_days INT DEFAULT 180,

    -- 双因子认证（2FA）
    mfa_mode VARCHAR(20) DEFAULT 'disabled',         -- disabled/optional/required
    mfa_allowed_methods JSON NOT NULL,              -- 默认值应用层设置：["totp","sms","email"]

    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(tenant_id)
);
CREATE INDEX idx_tenant_security_policies_tenant ON tenant_security_policies(tenant_id);
```

#### 2.2.23 系统安全默认值表（system_security_defaults）

> 存储全局安全默认值。新建租户时自动继承此默认值；也可批量推送到所有现有租户。
> 该表只有一行记录（singleton）。

```sql
CREATE TABLE system_security_defaults (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- 密码复杂度
    password_min_length INT DEFAULT 8,
    password_max_length INT DEFAULT 128,
    password_require_uppercase BOOLEAN DEFAULT TRUE,
    password_require_lowercase BOOLEAN DEFAULT TRUE,
    password_require_digit BOOLEAN DEFAULT TRUE,
    password_require_special BOOLEAN DEFAULT TRUE,
    password_block_common BOOLEAN DEFAULT TRUE,

    -- 密码历史
    password_history_count INT DEFAULT 5,

    -- 密码有效期
    password_max_age_days INT DEFAULT 90,
    password_expiry_warn_days INT DEFAULT 7,
    password_grace_logins INT DEFAULT 3,

    -- 会话管理
    access_token_ttl_minutes INT DEFAULT 30,
    refresh_token_ttl_hours INT DEFAULT 8,
    idle_timeout_minutes INT DEFAULT 15,
    max_concurrent_sessions INT DEFAULT 5,

    -- 账号锁定
    lockout_threshold INT DEFAULT 5,
    lockout_initial_minutes INT DEFAULT 15,
    lockout_second_minutes INT DEFAULT 30,
    lockout_third_plus_minutes INT DEFAULT 1440,
    captcha_threshold INT DEFAULT 3,

    -- 登录审计
    login_log_retention_days INT DEFAULT 180,

    -- 双因子认证
    mfa_mode VARCHAR(20) DEFAULT 'disabled',
    mfa_allowed_methods JSON NOT NULL,

    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

> 系统初始化时自动插入唯一一行记录（id=1），所有字段使用宪法基线默认值。

**租户策略继承关系**：

```
system_security_defaults（全局默认，仅一行）
        │
        ├─ 新建租户 → 自动复制为 tenant_security_policies
        │
        ├─ 批量推送 → 覆盖所有现有 tenant_security_policies
        │
        └─ 单租户自定义 → 管理员通过 API 单独调整
```

**默认值说明**：

所有字段均有默认值，与宪法 X 节的基线要求一致。租户创建时自动插入一条记录（使用默认值），管理员可通过 API 调整。

| 配置分类 | 字段 | 默认值 | 宪法依据 |
|---------|------|--------|---------|
| 密码复杂度 | `password_min_length` | 8 | X.2 |
| 密码历史 | `password_history_count` | 5 | X.3 |
| 密码有效期 | `password_max_age_days` | 90 | X.4 |
| 会话管理 | `access_token_ttl_minutes` | 30 | X.5 |
| 会话管理 | `idle_timeout_minutes` | 15 | X.5 |
| 账号锁定 | `lockout_threshold` | 5 | X.6 |
| 登录审计 | `login_log_retention_days` | 180 | X.1 |
| 双因子认证 | `mfa_mode` | `disabled` | Auth 7 |
| 双因子认证 | `mfa_allowed_methods` | `["totp","sms","email"]` | Auth 7 |

**`mfa_mode` 说明**：

| 模式 | 含义 | 登录行为 |
|------|------|---------|
| `disabled` | 2FA 关闭 | 用户无法启用 2FA，登录无需第二步 |
| `optional` | 2FA 可选 | 用户可自行在个人设置中启用 2FA |
| `required` | 2FA 强制 | 所有用户首次登录后必须设置 2FA，否则无法使用系统 |

**`mfa_allowed_methods` 说明**：

JSON 数组，定义租户内允许的 2FA 验证方式。用户只能从允许列表中选择：

| 方式 | 说明 |
|------|------|
| `totp` | 基于时间的一次性密码（Google Authenticator 等） |
| `sms` | 短信验证码 |
| `email` | 邮件验证码 |

示例：`["totp"]` 表示仅允许 TOTP；`["totp","sms"]` 表示允许 TOTP 或短信。

---

## 3. 配置管理 API

### 3.1 API 总览

> **所有权说明**：以下 API 由 **Config Service** 实现并拥有数据。API 网关（nextswitch-api）作为瘦代理转发请求。

```
基础路径：/api/v1

通用约定：
  - 所有列表接口支持分页：?page=1&page_size=20
  - 所有列表接口支持过滤：?status=active&tenant_id=1
  - 所有列表接口支持排序：?sort_by=created_at&sort_order=desc
  - 响应格式统一：{ "data": [...], "pagination": {...} }
  - 错误格式统一：{ "error": { "code": "...", "message": "...", "details": [...], "request_id": "..." } }

租户管理（全局，无需 tenant 前缀）：
  POST   /tenants                         # 创建租户
  GET    /tenants                         # 列表租户
  GET    /tenants/{id}                    # 获取租户
  PUT    /tenants/{id}                    # 更新租户
  DELETE /tenants/{id}                    # 删除租户

站点管理（全局，无需 tenant 前缀）：
  POST   /sites                           # 创建站点
  GET    /sites                           # 列表站点
  GET    /sites/{id}                      # 获取站点
  PUT    /sites/{id}                      # 更新站点
  DELETE /sites/{id}                      # 删除站点

分机管理：
  POST   /tenants/{tenantId}/extensions          # 创建分机
  GET    /tenants/{tenantId}/extensions          # 列表分机
  GET    /tenants/{tenantId}/extensions/{id}     # 获取分机
  PUT    /tenants/{tenantId}/extensions/{id}     # 更新分机
  DELETE /tenants/{tenantId}/extensions/{id}     # 删除分机
  POST   /tenants/{tenantId}/extensions/import   # 批量导入（CSV）
  GET    /tenants/{tenantId}/extensions/export   # 批量导出（CSV）

坐席管理：
  POST   /tenants/{tenantId}/agents              # 创建坐席
  GET    /tenants/{tenantId}/agents              # 列表坐席
  PUT    /tenants/{tenantId}/agents/{id}         # 更新坐席
  DELETE /tenants/{tenantId}/agents/{id}         # 删除坐席

技能组管理：
  POST   /tenants/{tenantId}/skill-groups        # 创建技能组
  GET    /tenants/{tenantId}/skill-groups        # 列表技能组
  PUT    /tenants/{tenantId}/skill-groups/{id}   # 更新技能组
  DELETE /tenants/{tenantId}/skill-groups/{id}   # 删除技能组

坐席技能关联：
  GET    /tenants/{tenantId}/agents/{agentId}/skills              # 查询坐席的所有技能
  PUT    /tenants/{tenantId}/agents/{agentId}/skills              # 批量设置坐席技能（全量替换）
  POST   /tenants/{tenantId}/agents/{agentId}/skills              # 为坐席添加单个技能
  DELETE /tenants/{tenantId}/agents/{agentId}/skills/{skillId}    # 移除坐席的某个技能
  GET    /tenants/{tenantId}/skill-groups/{skillId}/agents        # 通过技能组查询关联坐席

呼叫队列：
  POST   /tenants/{tenantId}/call-queues         # 创建队列
  GET    /tenants/{tenantId}/call-queues         # 列表队列
  PUT    /tenants/{tenantId}/call-queues/{id}    # 更新队列
  DELETE /tenants/{tenantId}/call-queues/{id}    # 删除队列

中继管理：
  POST   /tenants/{tenantId}/trunks              # 创建中继
  GET    /tenants/{tenantId}/trunks              # 列表中继
  PUT    /tenants/{tenantId}/trunks/{id}         # 更新中继
  DELETE /tenants/{tenantId}/trunks/{id}         # 删除中继

号码管理：
  POST   /tenants/{tenantId}/dids                # 创建号码
  GET    /tenants/{tenantId}/dids                # 列表号码
  PUT    /tenants/{tenantId}/dids/{id}           # 更新号码
  DELETE /tenants/{tenantId}/dids/{id}           # 删除号码

路由点：
  POST   /tenants/{tenantId}/route-points        # 创建路由点
  GET    /tenants/{tenantId}/route-points        # 列表路由点
  PUT    /tenants/{tenantId}/route-points/{id}   # 更新路由点
  DELETE /tenants/{tenantId}/route-points/{id}   # 删除路由点

IVR 流程：
  POST   /tenants/{tenantId}/ivr-flows           # 创建 IVR 流程
  GET    /tenants/{tenantId}/ivr-flows           # 列表 IVR 流程
  GET    /tenants/{tenantId}/ivr-flows/{id}      # 获取 IVR 流程（含节点和连线）
  PUT    /tenants/{tenantId}/ivr-flows/{id}      # 更新 IVR 流程
  DELETE /tenants/{tenantId}/ivr-flows/{id}      # 删除 IVR 流程
  POST   /tenants/{tenantId}/ivr-flows/{id}/activate   # 激活
  POST   /tenants/{tenantId}/ivr-flows/{id}/archive    # 归档

IVR 提示音：
  POST   /tenants/{tenantId}/ivr-prompts         # 上传提示音
  GET    /tenants/{tenantId}/ivr-prompts         # 列表提示音
  DELETE /tenants/{tenantId}/ivr-prompts/{id}    # 删除提示音

路由规则：
  POST   /tenants/{tenantId}/routing-rules       # 创建规则
  GET    /tenants/{tenantId}/routing-rules       # 列表规则
  PUT    /tenants/{tenantId}/routing-rules/{id}  # 更新规则
  DELETE /tenants/{tenantId}/routing-rules/{id}  # 删除规则

呼叫流程：
  POST   /tenants/{tenantId}/call-flows          # 创建流程
  GET    /tenants/{tenantId}/call-flows          # 列表流程
  PUT    /tenants/{tenantId}/call-flows/{id}     # 更新流程
  DELETE /tenants/{tenantId}/call-flows/{id}     # 删除流程

时间段：
  POST   /tenants/{tenantId}/time-conditions     # 创建时间段
  GET    /tenants/{tenantId}/time-conditions     # 列表时间段
  PUT    /tenants/{tenantId}/time-conditions/{id}  # 更新时间段
  DELETE /tenants/{tenantId}/time-conditions/{id}  # 删除时间段

版本与审计：
  GET    /tenants/{tenantId}/audit-log           # 查询配置审计日志
  GET    /tenants/{tenantId}/operation-logs      # 查询操作日志
  GET    /tenants/{tenantId}/snapshots           # 列表快照
  POST   /tenants/{tenantId}/snapshots           # 创建快照
  POST   /tenants/{tenantId}/rollback            # 回滚到快照

安全策略管理（宪法 X）：
  GET    /tenants/{tenantId}/security-policy     # 获取租户安全策略
  PUT    /tenants/{tenantId}/security-policy     # 更新租户安全策略
  POST   /tenants/{tenantId}/security-policy/reset  # 重置为系统默认值

系统安全默认值（全局）：
  GET    /system/security-defaults               # 获取系统安全默认值
  PUT    /system/security-defaults               # 更新系统安全默认值
  POST   /system/security-defaults/apply-all     # 批量推送到所有现有租户
```

### 3.2 请求/响应示例

**创建分机**：
```http
POST /api/v1/tenants/1/extensions
Content-Type: application/json

{
  "extension": "1001",
  "display_name": "张三",
  "password": "secure123",
  "email": "zhangsan@example.com",
  "codec_preference": ["pcmu", "pcma", "opus"],
  "call_timeout": 30,
  "forwarding": {
    "no_answer": "1002",
    "busy": "voicemail"
  }
}
```

**响应**：
```json
{
  "data": {
    "id": 1,
    "tenant_id": 1,
    "extension": "1001",
    "display_name": "张三",
    "email": "zhangsan@example.com",
    "status": "active",
    "codec_preference": ["pcmu", "pcma", "opus"],
    "call_timeout": 30,
    "forwarding": {
      "no_answer": "1002",
      "busy": "voicemail"
    },
    "created_at": "2026-09-09T10:00:00Z",
    "updated_at": "2026-09-09T10:00:00Z"
  }
}
```

**列表分机（分页 + 过滤）**：
```http
GET /api/v1/tenants/1/extensions?page=1&page_size=20&status=active&sort_by=extension&sort_order=asc
```

**响应**：
```json
{
  "data": [
    {
      "id": 1,
      "extension": "1001",
      "display_name": "张三",
      "status": "active"
    },
    {
      "id": 2,
      "extension": "1002",
      "display_name": "李四",
      "status": "active"
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 20,
    "total": 150,
    "total_pages": 8
  }
}
```

### 3.3 批量导入/导出

**CSV 导入分机**：
```http
POST /api/v1/tenants/1/extensions/import
Content-Type: multipart/form-data

------boundary
Content-Disposition: form-data; name="file"; filename="extensions.csv"
Content-Type: text/csv

extension,display_name,password,email,codec_preference
1001,张三,password123,zhangsan@example.com,"pcmu,pcma"
1002,李四,password456,lisi@example.com,"pcmu,opus"
------boundary--
```

**响应**：
```json
{
  "data": {
    "imported": 2,
    "failed": 0,
    "errors": []
  }
}
```

**CSV 导出分机**：
```http
GET /api/v1/tenants/1/extensions/export?format=csv&status=active
```

**响应**：
```csv
extension,display_name,email,status,codec_preference
1001,张三,zhangsan@example.com,active,"pcmu,pcma"
1002,李四,lisi@example.com,active,"pcmu,opus"
```

### 3.4 IVR 流程 API

**创建 IVR 流程（含节点和连线）**：
```http
POST /api/v1/tenants/1/ivr-flows
Content-Type: application/json

{
  "name": "销售来电 IVR",
  "description": "IVR → 销售队列",
  "nodes": [
    {
      "id": "node-1",
      "node_type": "answer",
      "position_x": 100,
      "position_y": 100,
      "config": {}
    },
    {
      "id": "node-2",
      "node_type": "play_prompt",
      "position_x": 300,
      "position_y": 100,
      "config": {
        "prompt": "welcome.wav",
        "interruptible": true
      }
    },
    {
      "id": "node-3",
      "node_type": "collect_digits",
      "position_x": 500,
      "position_y": 100,
      "config": {
        "prompt": "main_menu.wav",
        "max_digits": 1,
        "timeout": 5000,
        "terminator": "#"
      }
    },
    {
      "id": "node-4",
      "node_type": "transfer",
      "position_x": 700,
      "position_y": 50,
      "config": {
        "target_type": "queue",
        "target_id": "queue-sales",
        "timeout": 30
      }
    },
    {
      "id": "node-5",
      "node_type": "transfer",
      "position_x": 700,
      "position_y": 150,
      "config": {
        "target_type": "queue",
        "target_id": "queue-support",
        "timeout": 30
      }
    }
  ],
  "edges": [
    { "from": "node-1", "to": "node-2" },
    { "from": "node-2", "to": "node-3" },
    { "from": "node-3", "to": "node-4", "condition_expr": "digit=1", "label": "销售" },
    { "from": "node-3", "to": "node-5", "condition_expr": "digit=2", "label": "技术支持" }
  ]
}
```

**响应**：
```json
{
  "data": {
    "id": 1,
    "tenant_id": 1,
    "name": "销售来电 IVR",
    "version": 1,
    "status": "draft",
    "nodes": [ "..." ],
    "edges": [ "..." ],
    "created_at": "2026-09-09T10:00:00Z",
    "updated_at": "2026-09-09T10:00:00Z"
  }
}
```

### 3.5 审计日志 API

**查询审计日志**：
```http
GET /api/v1/tenants/1/audit-log?entity_type=extensions&entity_id=1&start_time=2026-09-01T00:00:00Z&end_time=2026-09-09T23:59:59Z&page=1&page_size=50
```

**响应**：
```json
{
  "data": [
    {
      "id": 1,
      "entity_type": "extensions",
      "entity_id": 1,
      "action": "update",
      "before_value": {
        "display_name": "张三",
        "call_timeout": 30
      },
      "after_value": {
        "display_name": "张三",
        "call_timeout": 60
      },
      "changed_by": 100,
      "ip_address": "192.168.1.100",
      "description": "修改呼叫超时时间",
      "created_at": "2026-09-09T14:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 25
  }
}
```

### 3.6 操作日志 API

**查询操作日志**：
```http
GET /api/v1/tenants/1/operation-logs?module=call&action=transfer&start_time=2026-09-01T00:00:00Z&end_time=2026-09-09T23:59:59Z&page=1&page_size=50
```

**响应**：
```json
{
  "data": {
    "total": 128,
    "page": 1,
    "page_size": 50,
    "items": [
      {
        "id": 1001,
        "tenant_id": 1,
        "user_id": 5,
        "service_name": "sipserver",
        "module": "call",
        "action": "transfer",
        "resource_type": "call",
        "resource_id": "call-20260909-001",
        "description": "坐席张三将通话转接到分机 1002",
        "request_method": "POST",
        "request_path": "/api/v1/tenants/1/calls/call-20260909-001/transfer",
        "ip_address": "192.168.1.100",
        "status": "success",
        "metadata": { "from_extension": "1001", "to_extension": "1002", "call_id": "abc123" },
        "created_at": "2026-09-09T14:30:00Z"
      }
    ]
  }
}
```

### 3.7 版本回滚 API

**创建快照**：
```http
POST /api/v1/tenants/1/snapshots
Content-Type: application/json

{
  "snapshot_type": "manual",
  "entity_type": "extensions",
  "description": "批量导入前备份"
}
```

**回滚到快照**：
```http
POST /api/v1/tenants/1/rollback
Content-Type: application/json

{
  "snapshot_id": 1,
  "dry_run": false
}
```

**响应**：
```json
{
  "data": {
    "rolled_back": 15,
    "created": 2,
    "deleted": 0,
    "message": "回滚成功"
  }
}
```

### 3.8 安全策略管理 API（宪法 X）

**获取租户安全策略**：
```http
GET /api/v1/tenants/1/security-policy
```

**响应**：
```json
{
  "data": {
    "tenant_id": 1,
    "password": {
      "min_length": 8,
      "max_length": 128,
      "require_uppercase": true,
      "require_lowercase": true,
      "require_digit": true,
      "require_special": true,
      "block_common": true,
      "history_count": 5,
      "max_age_days": 90,
      "expiry_warn_days": 7,
      "grace_logins": 3
    },
    "session": {
      "access_token_ttl_minutes": 30,
      "refresh_token_ttl_hours": 8,
      "idle_timeout_minutes": 15,
      "max_concurrent_sessions": 5
    },
    "lockout": {
      "threshold": 5,
      "initial_minutes": 15,
      "second_minutes": 30,
      "third_plus_minutes": 1440,
      "captcha_threshold": 3
    },
    "audit": {
      "login_log_retention_days": 180
    },
    "mfa": {
      "mode": "disabled",
      "allowed_methods": ["totp", "sms", "email"]
    }
  }
}
```

**更新安全策略**（部分更新）：
```http
PUT /api/v1/tenants/1/security-policy
Content-Type: application/json

{
  "password": {
    "min_length": 12,
    "max_age_days": 60
  },
  "session": {
    "idle_timeout_minutes": 10
  }
}
```

**响应**：
```json
{
  "data": {
    "tenant_id": 1,
    "updated_fields": [
      "password.min_length",
      "password.max_age_days",
      "session.idle_timeout_minutes"
    ],
    "policy": { "..." : "..." }
  }
}
```

**重置为系统默认值**：
```http
POST /api/v1/tenants/1/security-policy/reset
Content-Type: application/json

{
  "sections": ["password", "session"]
}
```

> 不传 `sections` 则重置所有分类。

**配置约束校验**：

| 字段 | 允许范围 |
|------|---------|
| `password.min_length` | 8-64 |
| `password.max_age_days` | 30-365 |
| `password.history_count` | 1-20 |
| `password.grace_logins` | 0-10 |
| `session.access_token_ttl_minutes` | 5-120 |
| `session.refresh_token_ttl_hours` | 1-24 |
| `session.idle_timeout_minutes` | 5-60 |
| `session.max_concurrent_sessions` | 1-20 |
| `lockout.threshold` | 3-20 |
| `lockout.captcha_threshold` | 1-10 |
| `audit.login_log_retention_days` | 30-3650 |
| `mfa.mode` | `disabled` / `optional` / `required` |
| `mfa.allowed_methods` | 非空数组，元素 ∈ {`totp`, `sms`, `email`} |

#### 3.8.1 系统安全默认值 API

**获取系统默认值**：
```http
GET /api/v1/system/security-defaults
```

**更新系统默认值**（部分更新）：
```http
PUT /api/v1/system/security-defaults
Content-Type: application/json

{
  "mfa": {
    "mode": "required",
    "allowed_methods": ["totp"]
  }
}
```

> 更新系统默认值**不会**自动影响现有租户，仅影响后续新建租户。
> 若需同步到现有租户，需显式调用 `apply-all`。

#### 3.8.2 批量推送 API

**推送到所有现有租户**：
```http
POST /api/v1/system/security-defaults/apply-all
Content-Type: application/json

{
  "sections": ["mfa"],
  "dry_run": true
}
```

> - `sections` 指定要推送的分类，不传则推送所有分类。
> - `dry_run: true` 返回预览，不执行。

**推送流程**：

```
POST /system/security-defaults/apply-all
  │
  ├─ ① 读取 system_security_defaults 中指定 sections 的值
  │
  ├─ ② 查询所有 tenant_security_policies
  │
  ├─ ③ 逐租户对比差异（当前值 vs 系统默认值）
  │
  ├─ ④ dry_run=true → 返回差异预览
  │
  └─ ⑤ dry_run=false → 执行更新
        → 逐租户更新 tenant_security_policies（事务内）
        → 写入 config_changelog（action=security_policy_update）
        → 发布 Redis 变更事件 config:{tenant_id}:security_policy
        → Auth Service 收到事件后刷新缓存
```

---

## 4. 变更通知机制

> 所有 Pub/Sub 操作通过 `nextswitch-cache` crate 的 `PubSub` trait 执行（宪法 XI），
> 不直接依赖 Redis。以下架构图中 "Pub/Sub" 指 trait 抽象层。
>
> **关键修正**：Config Service（而非 API 网关）是配置变更的发布者。API 网关仅订阅变更事件并转发给 WebSocket 客户端。

### 4.1 整体架构

```
                    ┌─────────────────┐
                    │  Config Service  │
                    │  (写入配置)       │
                    └────────┬────────┘
                             │
                   ① 写入 DB + ② PubSub::publish()
                             │
                    ┌────────▼────────┐
                    │  PubSub trait    │
                    │  (抽象层)        │
                    │                  │
                    │ Channel:         │
                    │  config:        │
                    │  {tenant_id}:   │
                    │  {entity_type}  │
                    └──┬────┬────┬───┘
                       │    │    │
              ┌────────┘    │    └────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ sipserver │  │ medserver │  │signalserver│
        │ PubSub::  │  │ PubSub::  │  │ PubSub::  │
        │ subscribe │  │ subscribe │  │ subscribe │
        │ (本地缓存) │  │ (本地缓存) │  │ (本地缓存) │
        └──────────┘  └──────────┘  └──────────┘
              │             │             │
              ▼             ▼             ▼
        ┌──────────────────────────────────────┐
        │         nextswitch-api（API 网关）       │
        │  PubSub::subscribe                    │
        │  → 转发到 WebSocket 客户端              │
        └──────────────────────────────────────┘
```

### 4.2 Channel 设计

```
Channel 命名规则：config:{tenant_id}:{entity_type}

示例：
  config:1:extensions      # 租户 1 的分机变更
  config:1:routing_rules   # 租户 1 的路由规则变更
  config:1:ivr_flows       # 租户 1 的 IVR 流程变更
  config:1:security_policy # 租户 1 的安全策略变更（Auth Service 需刷新缓存）
  config:*:sites           # 所有租户的站点变更（通配，通过 Redis keyspace notification 或订阅多个 channel 实现）

特殊 Channel：
  config:broadcast         # 全局广播（如系统维护、强制刷新）
  config:{tenant_id}:all   # 租户级全量刷新
```

### 4.3 变更消息格式

```json
{
  "event_id": "uuid-v4",
  "timestamp": "2026-09-09T10:00:00.000Z",
  "tenant_id": 1,
  "entity_type": "extensions",
  "entity_id": 42,
  "action": "update",
  "version": 15,
  "changed_by": 100,
  "payload": {
    "extension": "1001",
    "display_name": "张三（新）",
    "call_timeout": 60
  },
  "checksum": "sha256:a1b2c3..."
}
```

### 4.4 本地缓存架构

```rust
// 各服务内置的缓存层
struct ConfigCache {
    // 两级缓存：内存（热数据） + 本地磁盘（冷数据）
    memory: DashMap<CacheKey, CacheEntry>,
    // CacheKey = (tenant_id, entity_type, entity_id)
    // CacheEntry = { data: Value, version: u64, updated_at: DateTime }

    // 订阅管理器（通过 nextswitch-cache 抽象层，宪法 XI）
    subscriber: Box<dyn PubSub>,

    // 版本追踪：记录每个 entity_type 的最新 version
    version_tracker: DashMap<(u64, String), u64>,
}
```

**缓存读取流程**：

```
请求配置 → 查内存缓存
            ├─ 命中 → 返回（检查 version 是否过期）
            └─ 未命中 → 调用 Config Service REST API
                         → 写入缓存 → 返回
```

**缓存失效流程**：

```
Redis 收到变更事件
  → 解析 event
  → 更新内存缓存（upsert / delete）
  → 更新 version_tracker
  → 通知业务模块（通过 tokio::watch / broadcast channel）
```

### 4.5 断线重连与全量同步

```
Redis 连接断开
  → 指数退避重连（1s, 2s, 4s, 8s, max 30s）
  → 重连成功
    → 向 Config Service 发起全量同步
       GET /api/v1/tenants/{id}/sync?since={last_known_version}
    → 增量同步（如果 version 差距 < 阈值）
       或全量同步（如果差距过大）
    → 恢复 Redis 订阅
```

### 4.6 服务间 gRPC 通知（可选）

除 Redis Pub/Sub 外，Config Service 还提供 gRPC Server Streaming 作为补充：

```protobuf
service ConfigNotify {
  rpc WatchChanges(WatchRequest) returns (stream ChangeEvent);
}

message WatchRequest {
  uint64 tenant_id = 1;
  repeated string entity_types = 2;  // 空 = 全部
  uint64 since_version = 3;
}
```

适用场景：

- 无法连接 Redis 的轻量服务。
- 需要可靠投递（gRPC 有 back-pressure）的场景。

---

## 5. 版本控制与回滚

### 5.1 版本模型

每次配置变更都会产生一个递增的 `version` 号（per tenant, per entity_type），存储在 `config_changelog` 表中。

```
version 序列（per tenant + entity_type）：

  extensions:   v1 → v2 → v3 → ... → v15
  routing_rules: v1 → v2 → v3 → ... → v8
  ivr_flows:    v1 → v2 → ...
```

### 5.2 快照策略

| 快照类型 | 触发条件 | 保留策略 |
|---------|---------|---------|
| `auto_daily` | 每日凌晨自动 | 保留 30 天 |
| `manual` | 用户手动创建 | 永久保留，直到用户删除 |
| `pre_import` | 批量导入前自动创建 | 保留 90 天 |
| `pre_rollback` | 回滚前自动创建当前状态 | 永久保留 |

**快照内容**：

```json
{
  "id": 1,
  "tenant_id": 1,
  "snapshot_type": "auto_daily",
  "entity_type": "extensions",
  "entity_id": null,
  "snapshot_data": {
    "version": 15,
    "records": [
      { "id": 1, "extension": "1001", "display_name": "张三", "..." : "..." },
      { "id": 2, "extension": "1002", "display_name": "李四", "..." : "..." }
    ]
  },
  "created_at": "2026-09-09T00:00:00Z"
}
```

### 5.3 回滚流程

```
用户发起回滚（POST /rollback）
  │
  ├─ ① 创建 pre_rollback 快照（保存当前状态）
  │
  ├─ ② 读取目标快照数据
  │
  ├─ ③ 对比差异（当前 vs 目标快照）
  │     → 生成 diff：需要 create / update / delete 的记录
  │
  ├─ ④ dry_run=true 时，返回 diff 预览（不执行）
  │
  └─ ⑤ dry_run=false 时，执行回滚
        → 逐条写入 DB（事务内）
        → 写入 config_changelog（action=rollback）
        → 发布 Redis 变更事件
        → 返回回滚结果
```

### 5.4 增量同步 API

供各服务在 Redis 断线重连后恢复缓存：

```http
GET /api/v1/tenants/{tenantId}/sync?entity_type=extensions&since_version=10
```

**响应**：

```json
{
  "data": {
    "entity_type": "extensions",
    "since_version": 10,
    "current_version": 15,
    "events": [
      { "version": 11, "action": "update", "entity_id": 1, "payload": { "..." : "..." } },
      { "version": 12, "action": "create", "entity_id": 5, "payload": { "..." : "..." } },
      { "version": 13, "action": "delete", "entity_id": 3, "payload": null },
      { "version": 14, "action": "update", "entity_id": 2, "payload": { "..." : "..." } },
      { "version": 15, "action": "update", "entity_id": 1, "payload": { "..." : "..." } }
    ],
    "truncated": false
  }
}
```

当 `truncated: true` 时，表示增量数据过多（超过阈值，如 1000 条），客户端应改用全量同步：

```http
GET /api/v1/tenants/{tenantId}/sync?entity_type=extensions&full=true
```

---

## 6. 审计日志

### 6.1 审计范围

审计日志分为两类：

| 类型 | 表 | 覆盖范围 | 写入方式 |
|------|---|---------|---------|
| 配置变更审计 | `config_changelog` | 所有配置数据的 create/update/delete/import/rollback | 同步（同事务） |
| 操作日志 | `operation_logs` | 所有业务操作行为（通话控制、坐席状态、系统管理等） | 异步批量 |

### 6.2 审计记录内容

| 字段 | 说明 |
|------|------|
| `tenant_id` | 租户 ID |
| `entity_type` | 变更实体类型（extensions, routing_rules 等） |
| `entity_id` | 变更实体 ID |
| `action` | 操作类型：create / update / delete / import / rollback |
| `before_value` | 变更前值（JSON，delete 时为完整记录，update 时为变更字段） |
| `after_value` | 变更后值（JSON，create 时为完整记录，update 时为变更字段） |
| `changed_by` | 操作人 ID |
| `ip_address` | 操作人 IP 地址 |
| `description` | 操作描述（可选，用户填写） |
| `created_at` | 操作时间 |

### 6.3 写入时机

```
API 请求进入
  → 认证 + 鉴权（提取 user_id, ip_address）
  → 执行业务逻辑（DB 事务内）
    → ① 读取 before_value（update/delete 时）
    → ② 执行 DB 操作
    → ③ 读取 after_value（create/update 时）
    → ④ 写入 config_changelog（同一事务）
  → 发布 Redis 变更事件（事务提交后）
```

**事务保证**：审计日志与业务操作在同一 DB 事务中，保证原子性。要么一起成功，要么一起回滚。

### 6.4 批量操作的审计

批量导入时，为每条记录生成独立的审计日志，同时生成一条汇总审计：

```
import 操作 → 产生 N+1 条审计记录：
  1. 汇总记录：action=import, entity_type=extensions, description="批量导入 50 条分机"
  2. 每条记录：action=create, entity_id=X, after_value={...}
```

### 6.5 日志清理策略

| 日志类型 | 保留策略 |
|---------|---------|
| 普通变更（create/update） | 保留 90 天 |
| 删除操作 | 保留 180 天 |
| 回滚操作 | 永久保留 |
| 批量导入 | 保留 180 天 |

清理由定时任务执行，物理删除过期记录。

### 6.6 操作日志（operation_logs）

#### 6.6.1 写入时机

操作日志采用**异步写入**，不阻塞业务主流程：

```
业务操作完成（事务提交后）
  → 构造 OperationLog 记录
  → 写入内存缓冲区（batch_size=100 或 flush_interval=2s）
  → 批量 INSERT 到 operation_logs 表
  → 写入失败时降级到结构化日志（不丢失可审计性）
```

**与 config_changelog 的区别**：config_changelog 在同一事务内写入（强一致性），operation_logs 异步写入（最终一致性）。原因是操作日志面向行为审计，不影响业务数据正确性。

#### 6.6.2 写入接口

各服务通过 Config Service 提供的内部接口写入操作日志：

```rust
// 共享 trait，各服务实现
pub trait OperationLogRecorder: Send + Sync {
    async fn record(&self, log: OperationLog) -> Result<()>;
    async fn record_batch(&self, logs: Vec<OperationLog>) -> Result<()>;
}

pub struct OperationLog {
    pub tenant_id: i64,
    pub user_id: Option<i64>,
    pub service_name: String,
    pub module: String,
    pub action: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub description: String,
    pub request_method: Option<String>,
    pub request_path: Option<String>,
    pub ip_address: Option<IpAddr>,
    pub user_agent: Option<String>,
    pub status: OperationStatus,      // Success / Failure / Partial
    pub status_code: Option<i32>,
    pub error_message: Option<String>,
    pub metadata: Option<serde_json::Value>,
}
```

#### 6.6.3 操作日志清理策略

| 日志类型 | 保留策略 |
|---------|---------|
| 通话控制操作（call） | 保留 90 天 |
| 坐席状态变更（agent） | 保留 90 天 |
| 队列操作（queue） | 保留 90 天 |
| 导入导出操作（import_export） | 保留 180 天 |
| 系统管理操作（system） | 保留 180 天 |
| 安全管理操作（security） | 保留 365 天 |
| 失败操作（status=failure） | 保留 180 天 |

清理由定时任务执行，按 module + status 分批物理删除过期记录。

---

## 7. 导入导出

### 7.1 格式策略

| 数据类型 | 格式 | 理由 |
|---------|------|------|
| 分机、坐席、中继、号码等列表数据 | CSV | 扁平结构，适合 Excel 编辑 |
| IVR 流程、呼叫流程 | JSON | 嵌套结构（节点 + 连线） |
| 路由规则 | JSON | 条件表达式为嵌套 JSON |
| 全量备份/恢复 | JSON（压缩包） | 包含所有实体类型 |

### 7.2 CSV 导入流程

```
上传 CSV 文件
  │
  ├─ ① 解析 CSV（校验表头、编码 UTF-8）
  │
  ├─ ② 逐行校验
  │     → 必填字段检查
  │     → 格式校验（如 extension 唯一性、号码格式）
  │     → 枚举值校验（如 status=active/inactive）
  │
  ├─ ③ 冲突检测
  │     → 唯一约束冲突（如分机号已存在）
  │     → 模式：skip（跳过）/ overwrite（覆盖）/ abort（中止）
  │
  ├─ ④ 执行导入（事务内）
  │     → 批量 INSERT / UPDATE
  │     → 每条记录写入审计日志
  │
  └─ ⑤ 返回结果
        → { imported: N, updated: M, failed: K, errors: [...] }
```

**冲突处理模式**（通过请求参数指定）：

```http
POST /api/v1/tenants/1/extensions/import?conflict=overwrite
```

| 模式 | 行为 |
|------|------|
| `skip` | 跳过已存在的记录，只导入新记录 |
| `overwrite` | 覆盖已存在的记录 |
| `abort` | 遇到冲突时中止整个导入（回滚所有） |

### 7.3 CSV 导出流程

```
GET /api/v1/tenants/1/extensions/export?format=csv&status=active
  │
  ├─ ① 查询数据（支持过滤条件）
  │
  ├─ ② 流式写入 CSV（避免大文件内存溢出）
  │     → 使用 tokio 异步流
  │     → Content-Type: text/csv
  │     → Content-Disposition: attachment; filename="extensions.csv"
  │
  └─ ③ 响应头包含统计
        → X-Export-Count: 150
```

### 7.4 JSON 导入导出（复杂配置）

**IVR 流程导出**：

```http
GET /api/v1/tenants/1/ivr-flows/1/export?format=json
```

**IVR 流程导入**：

```http
POST /api/v1/tenants/1/ivr-flows/import
Content-Type: application/json

{
  "flow": { "name": "销售来电 IVR (导入)", "..." : "..." },
  "nodes": [ "..." ],
  "edges": [ "..." ]
}
```

### 7.5 全量备份与恢复

**全量备份**（导出租户所有配置）：

```http
POST /api/v1/tenants/1/backup
Content-Type: application/json

{
  "description": "迁移前全量备份",
  "entity_types": ["extensions", "agents", "skill_groups", "call_queues", "trunks", "dids", "route_points", "ivr_flows", "routing_rules", "call_flows", "time_conditions"]
}
```

**全量恢复**：

```http
POST /api/v1/tenants/1/restore
Content-Type: multipart/form-data
```

恢复流程与回滚类似：先创建 pre_rollback 快照 → diff → 执行。

### 7.6 安全约束

- 导入文件大小限制：10MB
- CSV 行数限制：10,000 行
- 导入操作需要 `admin` 或 `manager` 角色
- 导出操作需要租户级权限
- 所有导入/导出操作记录审计日志

---

## 8. 多站点设计

配置数据是逻辑概念，与物理站点无关。多站点部署时：

- **Config Service** 单实例部署（或主从复制），所有站点共享同一配置数据库。
- **各站点实例**（sipserver、signalserver、medserver）通过 `tenant_id` 订阅自身所需配置。
- 站点信息（`sites` 表）由 Config Service 管理，但运行时路由决策由信令层基于注册表中的 `site_id` 字段完成。

---

# Part II: API 网关

## 9. 网关架构

### 9.1 模块结构

```
nextswitch-api (binary)
├── middleware    — 中间件：CORS、速率限制、JWT 验证、权限检查、请求日志
├── router        — 路由注册：将 URL 路径分发到对应 handler
├── auth          — 认证模块：登录、登出、Token 刷新、2FA（路由到 auth-service）
├── config_api    — 配置管理 API：透传到 config-service
├── security_api  — 安全管理 API：用户/角色/菜单/部门/安全事件（路由到 auth-service）
├── cti_api       — CTI API：坐席状态、呼叫控制、队列管理（路由到 cti-server）
├── im_api        — IM 消息 API：会话管理、消息收发（路由到 im-server）
├── monitoring    — 监控聚合：从各实例 /health 端点采集数据，聚合为全局视图
├── ws            — WebSocket 处理：监控实时推送、CTI 事件推送、IM 消息中继、配置变更推送
├── cache         — Redis 缓存客户端封装：权限缓存、Token 黑名单
├── error         — 统一错误处理：错误码映射、响应格式化
├── metrics       — Prometheus 指标端点（/metrics，端口 9093）
├── health        — HTTP 健康检查端点（/health，端口 9093）
└── tracing       — OpenTelemetry 追踪上下文传播
```

### 9.2 中间件流水线

```
HTTP Request
  │
  ▼
┌──────────────┐
│  CORS        │  跨域处理（Web UI 域名白名单）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Rate Limit  │  速率限制（基于 IP + 用户 + 租户）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Request     │  请求 ID 生成、结构化日志 span 开始
│  ID & Trace  │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  JWT Auth    │  Token 验证（签名、有效期、黑名单）
│  (可选)      │  公开端点（/auth/login）跳过此步
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Permission  │  权限检查（从 Redis 获取用户权限，匹配所需权限）
│  (可选)      │  公开端点跳过此步
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Handler     │  业务逻辑处理（代理或直接处理）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Response    │  统一响应格式化、日志记录
└──────────────┘
```

### 9.3 公开端点（无需 JWT）

```
GET  /api/v1/auth/captcha         # 获取图形验证码
POST /api/v1/auth/login            # 登录
POST /api/v1/auth/mfa/verify       # 2FA 验证
POST /api/v1/auth/mfa/send-code    # 发送验证码
POST /api/v1/auth/refresh          # 刷新 Token（使用 Refresh Token）
GET  /health                       # 健康检查
GET  /health/live                  # K8s 存活探针
GET  /health/ready                 # K8s 就绪探针
GET  /health/startup               # K8s 启动探针
```

---

## 10. 路由代理表

> API 网关作为统一入口，将请求代理到对应的后端服务。下表列出所有路由及其所有权。

### 10.1 Auth API（代理到 auth-service）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/v1/auth/captcha` | 获取图形验证码 | 否 |
| POST | `/api/v1/auth/login` | 登录 | 否 |
| POST | `/api/v1/auth/logout` | 登出 | 是 |
| POST | `/api/v1/auth/refresh` | 刷新 Token | Refresh Token |
| GET | `/api/v1/auth/me` | 当前用户信息 | 是 |
| PUT | `/api/v1/auth/password` | 修改密码 | 是 |
| POST | `/api/v1/auth/change-password` | 强制修改密码（密码过期时） | 是 |
| GET | `/api/v1/auth/mfa/status` | 2FA 状态 | 是 |
| POST | `/api/v1/auth/mfa/setup` | 初始化 2FA | 是 |
| POST | `/api/v1/auth/mfa/verify-setup` | 验证 2FA 设置 | 是 |
| DELETE | `/api/v1/auth/mfa/disable` | 禁用 2FA | 是 |
| POST | `/api/v1/auth/mfa/send-code` | 发送验证码 | 否 |
| POST | `/api/v1/auth/mfa/verify` | 验证 2FA 码 | 否 |

### 10.2 Security API（代理到 auth-service）

| 方法 | 路径 | 说明 |
|------|------|------|
| DELETE | `/api/v1/users/{id}/sessions` | 管理员撤销用户会话 |
| POST | `/api/v1/users/{id}/unlock` | 管理员解锁账号 |
| GET | `/api/v1/audit/login-logs` | 查询登录审计日志 |
| GET | `/api/v1/security/events` | 安全事件查询 |
| POST | `/api/v1/audit/verify-integrity` | 审计日志完整性校验 |

**租户级用户管理**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tenants/{tenantId}/users` | 创建用户 |
| GET | `/api/v1/tenants/{tenantId}/users` | 列表用户 |
| GET | `/api/v1/tenants/{tenantId}/users/{id}` | 获取用户 |
| PUT | `/api/v1/tenants/{tenantId}/users/{id}` | 更新用户 |
| DELETE | `/api/v1/tenants/{tenantId}/users/{id}` | 删除用户 |
| POST | `/api/v1/tenants/{tenantId}/users/{id}/roles` | 分配角色 |
| POST | `/api/v1/tenants/{tenantId}/users/{id}/departments` | 分配部门 |

**角色管理**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tenants/{tenantId}/roles` | 创建角色 |
| GET | `/api/v1/tenants/{tenantId}/roles` | 列表角色 |
| GET | `/api/v1/tenants/{tenantId}/roles/{id}` | 获取角色 |
| PUT | `/api/v1/tenants/{tenantId}/roles/{id}` | 更新角色 |
| DELETE | `/api/v1/tenants/{tenantId}/roles/{id}` | 删除角色 |
| PUT | `/api/v1/tenants/{tenantId}/roles/{id}/permissions` | 设置角色权限 |
| PUT | `/api/v1/tenants/{tenantId}/roles/{id}/data-scopes` | 设置数据权限 |

**菜单管理**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tenants/{tenantId}/menus` | 创建菜单 |
| GET | `/api/v1/tenants/{tenantId}/menus` | 列表菜单（树形） |
| PUT | `/api/v1/tenants/{tenantId}/menus/{id}` | 更新菜单 |
| DELETE | `/api/v1/tenants/{tenantId}/menus/{id}` | 删除菜单 |
| PUT | `/api/v1/tenants/{tenantId}/menus/sort` | 批量排序 |

**部门管理**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tenants/{tenantId}/departments` | 创建部门 |
| GET | `/api/v1/tenants/{tenantId}/departments` | 列表部门（树形） |
| PUT | `/api/v1/tenants/{tenantId}/departments/{id}` | 更新部门 |
| DELETE | `/api/v1/tenants/{tenantId}/departments/{id}` | 删除部门 |

**权限查询**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/permissions` | 列表所有权限 |
| GET | `/api/v1/tenants/{tenantId}/users/{id}/permissions` | 用户权限 |
| GET | `/api/v1/tenants/{tenantId}/users/{id}/menus` | 用户菜单树 |
| GET | `/api/v1/tenants/{tenantId}/users/{id}/data-scopes` | 用户数据权限 |

### 10.3 Config API（代理到 config-service）

> 完整路由表见 Part I 第 3 节。API 网关对这些路径做透明代理，请求转发到 config-service，响应原样返回。

### 10.4 CTI API（代理到 cti-server）

**HTTP API**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/cti/agents/signin` | 坐席签入 |
| POST | `/api/v1/cti/agents/signout` | 坐席签出 |
| PUT | `/api/v1/cti/agents/state` | 变更坐席状态 |
| POST | `/api/v1/cti/calls/make` | 发起呼叫 |
| POST | `/api/v1/cti/calls/{callId}/answer` | 应答呼叫 |
| POST | `/api/v1/cti/calls/{callId}/transfer` | 转接呼叫 |
| GET | `/api/v1/cti/queues` | 获取队列列表 |
| GET | `/api/v1/cti/queues/{queueId}` | 队列详情（含统计） |
| GET | `/api/v1/cti/queues/{queueId}/agents` | 队列中的坐席列表 |
| GET | `/api/v1/cti/queues/{queueId}/calls` | 队列中等待的呼叫列表 |

**WebSocket**：

| 端点 | 说明 |
|------|------|
| `WS /api/v1/cti/events` | CTI 实时事件推送（坐席状态、呼叫事件、队列统计） |

**CTI WebSocket 事件类型**：

| 事件 | 描述 |
|------|------|
| `agent.signed_in` | 坐席签入 |
| `agent.signed_out` | 坐席签出 |
| `agent.state_changed` | 坐席状态变更 |
| `call.ringing` | 呼叫振铃 |
| `call.answered` | 呼叫应答 |
| `call.held` | 呼叫保持 |
| `call.unheld` | 呼叫恢复 |
| `call.transferred` | 呼叫转接 |
| `call.conferenced` | 呼叫进入会议 |
| `call.terminated` | 呼叫结束 |
| `queue.stats_updated` | 队列统计更新（每 5 秒推送一次） |

### 10.5 IM API（代理到 im-server）

**HTTP API**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/im/sessions` | 创建新会话 |
| GET | `/api/v1/im/sessions/{sessionId}` | 查询会话状态 |
| POST | `/api/v1/im/sessions/{sessionId}/close` | 客户主动关闭 |
| GET | `/api/v1/im/sessions/{sessionId}/messages` | 获取消息历史 |
| GET | `/api/v1/im/agents/me/sessions` | 获取当前 IM 会话 |
| POST | `/api/v1/im/sessions/{sessionId}/accept` | 应答会话 |
| POST | `/api/v1/im/sessions/{sessionId}/transfer` | 转接会话 |
| GET | `/api/v1/im/sessions` | 查询所有会话（管理员） |
| POST | `/api/v1/im/sessions/{sessionId}/messages` | 发送消息 |
| POST | `/api/v1/im/media/upload` | 上传媒体文件 |
| POST | `/api/v1/im/widget/init` | 初始化 Web Widget |
| POST | `/api/v1/im/widget/messages` | Widget 发送消息 |
| GET | `/api/v1/im/widget/messages` | Widget 获取消息 |
| POST | `/api/v1/im/agent-assist/suggest` | 智能助手建议 |
| POST | `/api/v1/im/agent-assist/search` | 智能助手搜索 |
| POST | `/api/v1/im/sessions/{sessionId}/summary` | 会话摘要生成 |

**WebSocket**：

| 端点 | 说明 |
|------|------|
| `WS /api/v1/im/widget/events` | Web Widget 实时消息推送 |

### 10.6 Monitoring API（网关聚合）

> 监控 API 由 API 网关直接聚合，从各服务实例 `/health` 端点采集数据。

| 方法 | 路径 | 数据来源 | 说明 |
|------|------|---------|------|
| GET | `/api/v1/monitoring/overview` | 各实例 `/health` 聚合 | 集群概览 |
| GET | `/api/v1/monitoring/calls` | sipserver + signalserver | 呼叫统计 |
| GET | `/api/v1/monitoring/instances` | Redis heartbeat keys | 实例列表 |
| GET | `/api/v1/monitoring/instances/{id}/detail` | 目标实例 `/health` | 实例详情 |
| GET | `/api/v1/monitoring/infrastructure` | 各实例聚合 | 基础设施状态 |
| GET | `/api/v1/monitoring/cdr` | sipserver + signalserver | CDR 统计 |
| GET | `/api/v1/monitoring/alerts` | Alertmanager API 代理 | 活跃告警 |
| GET | `/api/v1/monitoring/metrics/query` | Prometheus API 代理 | Prometheus 查询 |
| GET | `/api/v1/monitoring/dashboard` | medserver | 媒体服务 Dashboard |
| GET | `/api/v1/monitoring/sessions` | medserver | 媒体会话列表 |
| GET | `/api/v1/monitoring/conferences` | medserver | 会议列表 |
| GET | `/api/v1/monitoring/recordings` | medserver | 录音列表 |
| POST | `/api/v1/monitoring/alerts/{id}/acknowledge` | medserver | 确认告警 |

**WebSocket**：

| 端点 | 说明 |
|------|------|
| `WS /ws/monitoring` | 实时指标推送（每 5 秒） |

### 10.7 数据来源策略

| 数据类型 | 来源 | 延迟 |
|---------|------|------|
| 实时概览 | 各实例 `/health` 端点聚合 | <5s |
| 历史趋势 | 代理 Prometheus `query_range` API | 15s（scrape 间隔） |
| 告警状态 | 代理 Alertmanager API | 实时 |
| 实时推送 | WebSocket 长连接 | 5s 推送间隔 |
| 媒体监控 | medserver `/api/v1/monitoring/*` | <5s |

### 10.8 Prometheus 代理

`nextswitch-api` 可选代理 Prometheus 查询，避免 Web UI 直接访问 Prometheus：

```
GET /api/v1/monitoring/metrics/query
  ?query=rate(sip_calls_total[5m])
  &start=2026-09-09T00:00:00Z
  &end=2026-09-09T12:00:00Z
  &step=60

→ 代理到 Prometheus: GET /api/v1/query_range
```

认证复用 JWT，需要 `monitoring:read` 权限。

---

## 11. 限流策略

### 11.1 限制策略

| 维度 | 限制 | 窗口 | 说明 |
|------|------|------|------|
| IP 全局 | 1000 req | 1 分钟 | 防止单 IP 洪水攻击 |
| 用户 | 300 req | 1 分钟 | 防止单用户滥用 |
| 登录 | 10 req | 15 分钟 | 防止暴力破解 |
| 租户 | 5000 req | 1 分钟 | 防止单租户过载 |
| 2FA 发送 | 3 req | 1 小时 | 防止验证码轰炸 |

### 11.2 实现方式

```
Redis Key 设计：
  ratelimit:ip:{ip}:{window}           # IP 维度计数器
  ratelimit:user:{user_id}:{window}    # 用户维度计数器
  ratelimit:login:{ip}:{window}        # 登录维度计数器
  ratelimit:tenant:{tenant_id}:{window} # 租户维度计数器
  ratelimit:mfa:{user_id}:{window}     # 2FA 发送维度计数器

使用 Redis INCR + EXPIRE 实现滑动窗口计数。
```

### 11.3 响应头

```http
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 295
X-RateLimit-Reset: 1725868860
```

超限时返回：
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "请求过于频繁，请稍后重试",
    "details": [],
    "request_id": "req-uuid-v4",
    "retry_after": 30
  }
}
```
HTTP 状态码：`429 Too Many Requests`

---

## 12. CORS 配置

```toml
[api.cors]
allowed_origins = ["https://ui.nextswitch.io"]
allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
allowed_headers = ["Authorization", "Content-Type", "X-Request-Id"]
expose_headers = ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]
max_age = 86400
allow_credentials = true
```

---

## 13. 监控聚合

### 13.1 数据采集

`nextswitch-api` 通过轮询各服务实例的 `/health` 端点采集实时数据：

```
┌──────────────┐     GET /health     ┌──────────────┐
│ nextswitch-  │ ──────────────────→ │ sipserver-01 │
│ api          │                     ├──────────────┤
│              │     GET /health     │ sipserver-02 │
│  Monitor     │ ──────────────────→ ├──────────────┤
│  Aggregator  │                     │ signalserver │
│              │     GET /health     ├──────────────┤
│              │ ──────────────────→ │ medserver-01 │
│              │                     ├──────────────┤
│              │     GET /health     │ cti-server   │
│              │ ──────────────────→ ├──────────────┤
│              │                     │ im-server    │
│              │     GET /health     ├──────────────┤
│              │ ──────────────────→ │ config-svc   │
│              │                     ├──────────────┤
│              │     GET /health     │ auth-service │
│              │ ──────────────────→ ├──────────────┤
│              │                     │ router-srv   │
│              │     GET /health     │              │
│              │ ──────────────────→ └──────────────┘
└──────────────┘
```

**采集间隔**：每 5 秒轮询一次

**实例发现**：从 Redis 读取已注册实例列表（heartbeat key）

### 13.2 WebSocket 实时推送

**端点**：`wss://<api-host>/ws/monitoring?token=<jwt_token>`

**推送内容**（每 5 秒）：
```json
{
  "type": "monitoring_update",
  "data": {
    "timestamp": "2026-09-09T10:30:00Z",
    "overview": {
      "active_instances": 4,
      "total_registrations": 48200,
      "active_calls": 3420,
      "cps": 185
    },
    "media": {
      "active_sessions": 12450,
      "port_utilization": 0.68,
      "avg_latency_ms": 23
    },
    "alerts": [
      {
        "severity": "P1",
        "rule": "high_latency",
        "message": "P99 信令延迟超过 500ms",
        "since": "2026-09-09T10:25:00Z"
      }
    ]
  }
}
```

### 13.3 连接管理

- 认证：URL 参数传递 JWT Token（与 signalserver 一致）。
- 心跳：客户端每 30 秒发送 `ping`，服务端回复 `pong`。
- 超时：60 秒无心跳断开连接。
- 权限：需要 `monitoring:read` 权限。

---

## 14. 错误处理

### 14.1 统一错误响应格式

API 网关在所有错误响应中附加 `request_id` 字段，便于追踪：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "人类可读的错误描述",
    "details": [
      {
        "field": "username",
        "message": "具体字段错误"
      }
    ],
    "request_id": "req-uuid-v4"
  }
}
```

> **注意**：Config Service 自身返回的错误格式不包含 `request_id`（由 API 网关在代理时注入）。

### 14.2 错误码映射

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `VALIDATION_ERROR` | 400 | 请求参数校验失败 |
| `UNAUTHORIZED` | 401 | 未认证或 Token 过期 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 唯一约束冲突 |
| `RATE_LIMITED` | 429 | 请求频率超限 |
| `INTERNAL_ERROR` | 500 | 内部错误 |
| `SERVICE_UNAVAILABLE` | 503 | 依赖服务不可用 |
| `GATEWAY_TIMEOUT` | 504 | 上游服务超时 |

### 14.3 网关配置

```toml
[api]
host = "0.0.0.0"
port = 8080
workers = 4                        # Tokio worker 线程数
request_timeout_ms = 30000         # 请求超时
max_request_size_mb = 50           # 最大请求体大小（文件上传）

[api.monitoring]
aggregate_interval_secs = 5        # 实例健康数据聚合间隔
health_check_timeout_ms = 2000     # 单实例健康检查超时
prometheus_url = "http://prometheus:9090"   # Prometheus 地址（可选代理）
alertmanager_url = "http://alertmanager:9093" # Alertmanager 地址

[api.redis]
url = "redis://redis:6379"
pool_size = 20
command_timeout_ms = 100

[api.database]
url = "mysql://user:pass@db:3306/nextswitch"
pool_size = 20
connect_timeout_ms = 5000

[api.jwt]
secret_key = "${JWT_SECRET}"       # 环境变量注入
access_token_ttl_secs = 1800       # 30 分钟
refresh_token_ttl_secs = 28800     # 8 小时
issuer = "nextswitch-api"

[api.ratelimit]
enabled = true
redis_url = "redis://redis:6379/1" # 使用独立 DB 避免冲突

[api.cors]
allowed_origins = ["https://ui.nextswitch.io"]
allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
allowed_headers = ["Authorization", "Content-Type", "X-Request-Id"]
max_age = 86400

[api.tracing]
enabled = true
exporter = "otlp"
endpoint = "http://jaeger:4317"
service_name = "nextswitch-api"
```

---

# Appendices

## Appendix A: Redis Key 命名空间（完整）

> 所有服务共享同一 Redis 集群。为避免 Key 冲突，各服务使用独立的前缀命名空间。
> 本附录汇总来自所有服务的 Redis Key，修正并补全了原文档中缺失的条目。

### A.1 命名空间总览

| 前缀 | 所属服务 | 用途 |
|------|---------|------|
| `reg:sip:` | sipserver / signalserver | SIP 分机注册表 |
| `heartbeat:` | 所有服务 | 实例心跳 |
| `auth:` | auth-service / nextswitch-api | 认证、权限缓存 |
| `ratelimit:` | nextswitch-api | 速率限制计数器 |
| `config:` | config-service | 配置缓存、Pub/Sub |
| `cdr:` | sipserver / signalserver | CDR WAL 同步状态 |
| `session:` | signalserver | WebSocket 会话状态 |
| `cti:` | cti-server | 坐席状态、呼叫状态、队列数据 |
| `im:` | im-server | IM 会话缓存、未读计数、在线状态 |
| `router:` | router-server | 路由引擎流程实例 |
| `security:` | auth-service | 安全相关（IP 封禁等） |
| `park:` | sipserver / signalserver | 呼叫驻留槽位 |
| `outbound:` | sipserver / signalserver | 外呼并发计数 |
| `cac:` | sipserver / signalserver | 呼叫准入控制计数 |
| `conf:` | sipserver / signalserver | 会议桥状态 |

### A.2 信令层（sipserver / signalserver）

```
# 注册表（Hash）
reg:sip:{aor}                          # 如 reg:sip:1001@company-a
  → { contact, expires, instance_id, transport, site_id, az_id, call_id, cseq }

# 实例心跳（String + TTL）
heartbeat:{service}:{instance_id}      # 如 heartbeat:sipserver:sipserver-03
  → "alive"  TTL=30s，每 10s 刷新

# CDR 同步位点（String）
cdr:sync:{instance_id}:wal_position    # WAL 已同步位置
  → 整数偏移量

# WebSocket 会话（Hash）
session:ws:{session_id}                # WebRTC 客户端会话
  → { user_id, tenant_id, instance_id, connected_at, call_ids }

# 呼叫驻留（Hash）
park:slot:{tenant_id}:{slot}           # 呼叫驻留槽位
  → { call_id, parker, parked_at, ... }  TTL=300s（可配置）

# 外呼并发计数（String）
outbound:channels:{tenant_id}:{ext_id}            # 分机外呼并发
outbound:channels:{tenant_id}                     # 租户外呼并发
outbound:channels:trunk:{trunk_id}                # 中继通道并发

# 呼叫准入控制（String / Hash）
cac:system:active                      # 系统全局并发呼叫计数
cac:tenant:{id}:active                 # 租户并发呼叫计数
cac:ext:{id}:active                    # 分机并发呼叫计数
cac:trunk:{id}:active                  # 中继并发通道计数
cac:calls:{instance_id}                # 实例活跃呼叫追踪（Hash，崩溃恢复用）

# 会议桥（Hash）
conf:bridge:{conf_id}                  # 会议桥状态（会议结束后删除）
```

### A.3 认证模块（auth-service / nextswitch-api）

```
# 权限缓存（String/JSON，TTL=2h）
auth:permissions:{user_id}:{tenant_id}
  → { roles, permissions, data_scopes, expires_at }

# 菜单缓存（String/JSON，TTL=2h）
auth:menus:{user_id}:{tenant_id}
  → { menus: [...], expires_at }

# 数据权限缓存（String/JSON，TTL=2h）
auth:data_scopes:{user_id}:{tenant_id}
  → { scopes: {...}, expires_at }

# 用户信息缓存（String/JSON，TTL=2h）
auth:user_info:{user_id}
  → { id, username, display_name, email, departments }

# Refresh Token（String，TTL=refresh TTL）
auth:refresh:{jti}
  → { user_id, tenant_id, issued_at }

# Token 黑名单（String，TTL=Token 剩余有效期）
auth:blacklist:{jti}
  → "revoked"

# 会话信息（String，TTL=idle_timeout）
auth:session:{session_id}
  → 会话状态

# 安全策略缓存（String/JSON，TTL=1h）
auth:security_policy:{tenant_id}
  → 租户安全策略

# 登录失败计数（String，TTL=锁定时间）
auth:failures:user:{username}          # 用户名维度
auth:failures:ip:{ip_address}          # IP 维度

# 图形验证码（String，TTL=5min）
auth:captcha:{captcha_id}
  → 验证码答案哈希
```

### A.4 安全模块（auth-service）

```
# 动态 IP 封禁（String，TTL=封禁时长）
security:blocked_ip:{ip}
  → "blocked"
```

### A.5 配置模块（config-service）

```
# 配置缓存（String/JSON，TTL=5min）
config:{entity_type}:{tenant_id}:{entity_id}
  → 实体配置 JSON

# 配置版本号（String）
config:version:{tenant_id}
  → 整数版本号
```

### A.6 CTI 模块（cti-server）

```
# 坐席状态（Hash）
cti:agent:{agent_id}:state
  → { status, skill_groups, current_calls, ... }

# 呼叫状态（Hash）
cti:call:{call_id}
  → { caller, callee, agent_id, state, start_time, ... }

# 队列配置（Hash）
cti:queue:{queue_id}
  → { name, strategy, skill_groups, ... }

# 队列呼叫（Sorted Set）
cti:queue:{queue_id}:calls
  → member=call_id, score=入队时间戳

# 队列统计（Hash）
cti:queue:{queue_id}:stats
  → { waiting, longest_wait, served, abandoned, ... }
```

### A.7 IM 模块（im-server）

```
# 会话状态（Hash）
im:session:{session_id}
  → { customer_id, agent_id, status, created_at, ... }

# 活跃消息缓存（List）
im:session:{session_id}:messages
  → 消息列表

# 未读计数（String）
im:session:{session_id}:unread
  → 整数计数

# 客户活跃会话索引（String）
im:customer:{customer_id}:active_session
  → session_id

# 坐席会话列表（Set）
im:agent:{agent_id}:sessions
  → members = session_ids

# 客户历史（Hash）
im:customer_history:{customer_id}
  → { name, email, total_sessions, last_session_at, ... }

# 客户历史会话列表（Sorted Set）
im:customer_history:{customer_id}:sessions
  → member=session_id, score=创建时间
```

### A.8 路由引擎（router-server）

```
# 流程实例（Hash，TTL=24h）
router:flow:instance:{instance_id}
  → { flow_id, tenant_id, call_id, current_node_id, state, variables, trace, ... }

# 呼叫索引（String，TTL=24h）
router:flow:call_index:{call_id}
  → instance_id
```

### A.9 速率限制（nextswitch-api）

```
# 速率限制计数器（String + TTL）
ratelimit:ip:{ip}:{window}             # IP 维度
ratelimit:user:{user_id}:{window}      # 用户维度
ratelimit:login:{ip}:{window}          # 登录维度
ratelimit:tenant:{tenant_id}:{window}  # 租户维度
ratelimit:mfa:{user_id}:{window}       # 2FA 发送维度
```

### A.10 Pub/Sub 频道规范（完整）

| 频道模式 | 发布者 | 订阅者 | 用途 |
|---------|--------|--------|------|
| `config:{tenant_id}:{entity_type}` | config-service | sipserver, signalserver, medserver, im-server, cti-server, nextswitch-api | 租户配置增量下发 |
| `config:{tenant_id}:all` | config-service | 同上 | 租户级全量刷新 |
| `config:broadcast` | config-service | 所有服务实例 | 全局配置变更 |
| `cti:events:{tenant_id}` | cti-server | nextswitch-api（WebSocket 转发） | CTI 实时事件推送 |
| `im:events:{tenant_id}` | im-server | cti-server（转发到 WebSocket） | IM 会话事件同步 |
| `call:command:{instance_id}` | cti-server | sipserver / signalserver | 呼叫控制命令 |
| `call:event:{instance_id}` | sipserver / signalserver | cti-server | 呼叫状态事件回报 |
| `call:relay:{instance_id}` | signalserver | sipserver | 跨协议呼叫通知 |
| `cluster:events` | 所有服务 | 所有服务 | 实例上下线通知 |
| `security:ip_blocked` | auth-service | nextswitch-api, sipserver, signalserver | 动态 IP 封禁通知 |

### A.11 Redis 数据库分配（如使用单实例 Redis）

| DB 编号 | 用途 | 说明 |
|---------|------|------|
| 0 | 注册表 + 心跳 | 信令层核心数据 |
| 1 | 认证缓存 | Auth 模块权限、Token |
| 2 | 配置缓存 + Pub/Sub | Config 模块 |
| 3 | 速率限制 | 临时数据，可定期清理 |
| 4 | CTI 状态 | 坐席状态、呼叫状态、队列数据 |
| 5 | IM 缓存 | 活跃会话、未读计数、在线状态 |
| 6 | 路由引擎 | 流程实例、呼叫索引 |
| 7 | 安全 | IP 封禁、登录失败计数 |
| 8 | 呼叫辅助 | park、outbound、cac、conf |

> **生产建议**：使用 Redis Cluster 时，通过 Key 前缀自动分片到不同 slot。
> 单实例模式下使用 DB 编号隔离；Cluster 模式下所有数据在 DB 0，依靠前缀分片。

---

## Appendix B: 服务端口分配表

| 服务 | HTTP | Metrics/Health | gRPC | SIP | WebSocket | RTP |
|------|------|---------------|------|-----|-----------|-----|
| sipserver | - | 9090 | 50051 | 5060-5061 | - | - |
| signalserver | - | 9091 | 50051 | - | 8443 | - |
| medserver | - | 9092 | 50051 | - | - | 10000-60000 |
| nextswitch-api | 8080 | 9093 | - | - | 8080 | - |
| auth-service | 8081 | 9094 | 50051 | - | - | - |
| config-service | 8082 | 9095 | 50051 | - | - | - |
| cti-server | 8083 | 9096 | 50051 | - | 8083 | - |
| im-server | 8084 | 9097 | 50051 | - | 8084 | - |
| router-server | - | 9098 | 50051 | - | - | - |

> **说明**：
> - Metrics/Health 端口遵循宪法 V.4：health 与 metrics 同端口。
> - WebSocket 端口与 HTTP 端口相同的服务，表示 WebSocket 复用 HTTP 端口。
> - gRPC 端口统一使用 50051（各服务通过不同 IP 或 TLS SNI 区分）。
> - SIP 端口 5060（UDP/TCP）和 5061（TLS）。
> - 生产环境中 Metrics/Health 端口仅限内部网络。

---

## Appendix C: 错误码汇总

### C.1 通用错误码

| 错误码 | HTTP 状态码 | 来源 | 说明 |
|--------|-----------|------|------|
| `VALIDATION_ERROR` | 400 | 所有服务 | 请求参数校验失败 |
| `UNAUTHORIZED` | 401 | nextswitch-api, auth-service | 未认证或 Token 过期 |
| `FORBIDDEN` | 403 | nextswitch-api, config-service | 无权限（租户隔离） |
| `NOT_FOUND` | 404 | 所有服务 | 资源不存在 |
| `CONFLICT` | 409 | config-service, auth-service | 唯一约束冲突 |
| `RATE_LIMITED` | 429 | nextswitch-api | 请求频率超限 |
| `INTERNAL_ERROR` | 500 | 所有服务 | 内部错误 |
| `SERVICE_UNAVAILABLE` | 503 | nextswitch-api | 依赖服务不可用 |
| `GATEWAY_TIMEOUT` | 504 | nextswitch-api | 上游服务超时 |

### C.2 认证安全错误码

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `ACCOUNT_LOCKED` | 423 | 账号已锁定 |
| `PASSWORD_EXPIRED` | 403 | 密码已过期，需强制修改 |
| `MFA_REQUIRED` | 403 | 需要 2FA 验证 |
| `MFA_INVALID_CODE` | 400 | 2FA 验证码错误 |
| `CAPTCHA_INVALID` | 400 | 图形验证码错误 |
| `TOKEN_EXPIRED` | 401 | Token 已过期 |
| `TOKEN_REVOKED` | 401 | Token 已撤销 |
| `SESSION_EXPIRED` | 401 | 会话已过期 |

### C.3 配置服务错误码

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `TENANT_INACTIVE` | 403 | 租户已停用 |
| `EXTENSION_DUPLICATE` | 409 | 分机号已存在 |
| `IMPORT_TOO_LARGE` | 413 | 导入文件超过大小限制（10MB） |
| `IMPORT_TOO_MANY_ROWS` | 413 | CSV 行数超过限制（10,000 行） |
| `SNAPSHOT_NOT_FOUND` | 404 | 快照不存在 |
| `ROLLBACK_CONFLICT` | 409 | 回滚目标版本与当前版本冲突 |

### C.4 CTI 错误码

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `AGENT_NOT_SIGNED_IN` | 400 | 坐席未签入 |
| `CALL_NOT_FOUND` | 404 | 呼叫不存在 |
| `INVALID_CALL_STATE` | 409 | 呼叫状态不允许该操作 |
| `QUEUE_FULL` | 429 | 队列已满 |
| `AGENT_BUSY` | 409 | 坐席繁忙（超过最大并发） |

---

## Appendix D: 健康检查端点

### D.1 各服务健康检查端点

所有服务的 Metrics/Health 端口提供以下端点：

| 端点 | 用途 | 判断逻辑 |
|------|------|---------|
| `/health` | 综合健康检查 | Redis 可达 + 配置已加载 |
| `/health/live` | K8s 存活探针 | 进程是否在响应 HTTP |
| `/health/ready` | K8s 就绪探针 | Redis 可达 + 配置已加载 + SIP 监听已绑定 |
| `/health/startup` | K8s 启动探针 | 初始化完成（配置拉取 + 监听绑定） |

### D.2 各服务健康检查端口

| 服务 | 端口 | 端点路径 |
|------|------|---------|
| sipserver | 9090 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| signalserver | 9091 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| medserver | 9092 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| nextswitch-api | 9093 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| auth-service | 9094 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| config-service | 9095 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| cti-server | 9096 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| im-server | 9097 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |
| router-server | 9098 | `/health`, `/health/live`, `/health/ready`, `/health/startup` |

### D.3 健康检查响应格式

**健康时**（HTTP 200）：
```json
{
  "status": "healthy",
  "service": "sipserver",
  "instance_id": "sipserver-01",
  "site_id": "us-east-1",
  "uptime_seconds": 864000,
  "checks": {
    "redis": "ok",
    "config_loaded": true,
    "sip_transport": "listening"
  },
  "version": "1.0.0",
  "timestamp": "2026-09-09T10:00:00Z"
}
```

**不健康时**（HTTP 503）：
```json
{
  "status": "unhealthy",
  "service": "sipserver",
  "instance_id": "sipserver-01",
  "checks": {
    "redis": "failed",
    "config_loaded": true,
    "sip_transport": "listening"
  },
  "error": "Redis connection timeout",
  "timestamp": "2026-09-09T10:00:00Z"
}
```

---

## 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-09-09 | nextswitch-api-design 初始版本（API 网关设计） |
| 1.2.0 | 2026-09-09 | config-service-design 最终版本（配置中心设计，含 23 张表、安全策略） |
| 2.0.0 | 2026-09-09 | 合并为统一规格书。修正：Config Service（而非 API 网关）为配置变更发布者；补全路由代理表（CTI/IM/Security）；补全 Redis Key 命名空间（增加 router/security/park/outbound/cac/conf 等 18+ 条目）；新增服务端口分配表；新增健康检查端点汇总；标准化错误响应格式（网关层添加 request_id）；修复原 config-service-design 中的重复章节编号（3.7 → 3.7/3.8） |

---

**文档结束**