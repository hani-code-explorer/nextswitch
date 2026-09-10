# 路由配置与呼叫处理设计规格

> **版本**: 1.0.0
> **日期**: 2026-09-10
> **状态**: Draft
> **替代**: 2026-09-09-routing-engine-design.md 中的路由规则部分

## 1. 概述

本文档定义 NextSWITCH 的路由配置模型和呼叫处理架构。核心思路是将路由决策拆分为四个显式的段——**来源 → 匹配 → 重写 → 目的地**——取代原有设计中隐式的条件树匹配。

### 1.1 设计目标

- 路由规则结构清晰，贴近传统 PBX/SBC 配置范式
- 来源类型显式建模（中继 / 注册分机 / 应用接口）
- SIP 字段匹配支持正则表达式
- B2BUA 重写规则与路由规则统一配置
- 目的地类型覆盖 PBX 和呼叫中心核心场景

### 1.2 架构概览

系统采用两层服务架构：

```
信令服务器（sipserver / sigserver）
  │  职责：协议处理 + 路由决策
  │  流程：来源识别 → 匹配 → 重写 → 路由决策
  │
  ▼  gRPC: ProcessCall
媒体服务器（medserver）
  │  职责：呼叫处理 + 媒体操作
  │  处理：通话建立、Call Flow 执行、IVR、巡线振铃、会议桥接
```

**信令服务器**只做路由决策，不做呼叫处理。**媒体服务器**接管后续一切操作。

### 1.3 与现有设计的关系

| 组件 | 变更 |
|------|------|
| Dial Plan（号码规范化） | 保留，作为路由流水线的前置阶段 |
| Time Conditions（时间条件） | 移除 |
| router-server（独立路由服务） | 移除，功能合并到媒体服务器 |
| Route Point | 简化为 Call Flow 入口（类似 Avaya Vector） |
| ACD Queue | 不在本设计范围内 |
| Hunt Group | 新增目的地类型 |
| Conference | 新增目的地类型 |

## 2. 路由规则数据模型

### 2.1 路由规则（RoutingRule）

每条路由规则由四个段组成：

```rust
struct RoutingRule {
    id: i64,
    tenant_id: i64,
    priority: i32,
    enabled: bool,
    name: String,

    /// 来源：定义规则适用的呼叫来源
    source: RouteSource,

    /// 匹配条件：SIP 字段正则匹配，字段间 AND 关系
    match_conditions: MatchConditions,

    /// 重写规则：B2BUA SIP 字段改写，可选
    rewrite_rules: Option<RewriteRules>,

    /// 目的地：匹配后的路由目标
    destination: RouteDestination,
}
```

规则按 `priority` DESC 排序，首条命中生效。

### 2.2 来源（RouteSource）

三种来源类型，互斥：

```rust
enum RouteSource {
    /// 来自 SIP 中继，通过源 IP 匹配 trunks 表识别
    Trunk { trunk_id: i64 },

    /// 来自已注册的终端设备（IP 话机、软电话），通过注册表查找
    Extension { extension_id: i64 },

    /// 来自应用接口（REST API / CTI SDK / WebSocket），通过认证凭据识别
    Api { api_key_id: i64 },
}
```

来源识别优先级：
1. 源 IP 匹配 `trunks` 表 → Trunk
2. 注册表查找分机 → Extension
3. API 认证身份 → Api
4. 以上均不匹配 → 拒绝呼叫

### 2.3 匹配条件（MatchConditions）

```rust
struct MatchConditions {
    /// 源 IP 地址
    source_address: Option<Regex>,
    /// 源端口
    source_port: Option<PortRange>,
    /// 传输协议：UDP / TCP / TLS / WSS
    transport: Option<Transport>,
    /// SIP From URI 的 user 部分
    from_user: Option<Regex>,
    /// SIP From URI 的 host 部分
    from_host: Option<Regex>,
    /// SIP To URI 的 user 部分
    to_user: Option<Regex>,
    /// SIP To URI 的 host 部分
    to_host: Option<Regex>,
    /// SIP Request-URI 的 user 部分
    request_user: Option<Regex>,
    /// SIP Request-URI 的 host 部分
    request_host: Option<Regex>,
}
```

- 所有字段均为 `Option`，`None` 表示不约束该字段
- 有值的字段之间是 **AND** 关系
- 正则表达式在规则加载时预编译并缓存

### 2.4 重写规则（RewriteRules）

```rust
struct RewriteRules {
    /// 重写 SIP From URI 的 user 部分
    from_user: Option<String>,
    /// 重写 SIP From URI 的 host 部分
    from_host: Option<String>,
    /// 重写 SIP To URI 的 user 部分
    to_user: Option<String>,
    /// 重写 SIP To URI 的 host 部分
    to_host: Option<String>,
    /// 重写 SIP Request-URI 的 user 部分
    request_user: Option<String>,
    /// 重写 SIP Request-URI 的 host 部分
    request_host: Option<String>,
}
```

- 值为正则替换模式，支持捕获组引用（如 `"$1"`）
- 信令服务器在匹配后、转发前执行重写
- 用于 B2BUA 场景：转分机时隐藏中继信息，转外线时设置主叫号码

### 2.5 目的地（RouteDestination）

六种目的地类型：

```rust
enum RouteDestination {
    /// 转分机：查找注册联系方式，建立通话
    Extension { extension_id: i64 },
    /// 转中继：选择中继线路，发起出站呼叫
    Trunk { trunk_group_id: i64 },
    /// 路由点：关联 Call Flow（Vector），由媒体服务器执行
    RoutePoint { route_point_id: i64 },
    /// IVR 流程：由媒体服务器执行交互式语音流程
    IvrFlow { ivr_flow_id: i64 },
    /// 巡线组：按策略振铃组成员
    HuntGroup { hunt_group_id: i64 },
    /// 会议室：接入音频混合桥接
    Conference { conference_id: i64 },
}
```

## 3. 处理流水线

### 3.1 信令服务器处理流程

```
入站 SIP/RTC 消息
  │
  ▼
① 前置处理
  │  SIP 解析 → 防火墙 → 限流 → 呼叫准入控制
  │
  ▼
② Dial Plan 号码规范化
  │  按 priority DESC 遍历 dial_plans
  │  正则变换被叫号码，产出 normalized_callee
  │  动作类型：Allow（放行）/ Deny（拒绝）/ Transform（变换）
  │
  ▼
③ 来源识别
  │  ├─ 源 IP 匹配 trunks 表 → RouteSource::Trunk
  │  ├─ 注册表查找分机 → RouteSource::Extension
  │  └─ API 认证身份 → RouteSource::Api
  │
  ▼
④ 匹配规则
  │  按 priority DESC 遍历 routing_rules
  │  每条规则：source 匹配 AND match_conditions 全部 AND
  │  首条命中 → 进入重写
  │
  ▼
⑤ 重写规则
  │  按 rewrite_rules 修改 SIP 字段
  │  无 rewrite_rules → 跳过，保持原始字段
  │
  ▼
⑥ 路由决策
  │  构造 ProcessCallRequest → gRPC 调用媒体服务器
```

### 3.2 媒体服务器处理流程

```
收到 ProcessCallRequest
  │
  ├─ Extension
  │     查注册表 → 找到联系方式 → 建立通话
  │
  ├─ Trunk
  │     选择中继线路 → 发起出站 SIP 呼叫
  │
  ├─ RoutePoint
  │     加载关联 Call Flow → 逐步执行 Vector
  │     ├─ Conditional → 评估条件，跳转到对应步骤
  │     ├─ CollectDigits → 播放提示 + 收号 → 结果存入变量
  │     ├─ DataLookup → 外部查询 → 结果存入变量
  │     ├─ PlayPrompt → 播放提示音
  │     └─ RouteTo → 解析到终端目的地 → 执行对应操作
  │
  ├─ IvrFlow
  │     加载 IVR 流程定义 → 执行交互式流程
  │
  ├─ HuntGroup
  │     ├─ Sequential → 按 priority 依次振铃成员
  │     ├─ Simultaneous → 同时振铃所有成员
  │     └─ RoundRobin → 轮询振铃
  │     无人应答 → fallback_destination
  │
  └─ Conference
        接入会议室 → 音频混合桥接
        检查 max_participants → 满员则拒绝或播放等待音
```

### 3.3 无匹配处理

当所有路由规则都不匹配时：

- 默认行为：拒绝呼叫（返回 SIP 404 Not Found）
- 可配置租户级默认目的地（`tenant.default_destination`），作为兜底

## 4. 服务间接口

### 4.1 gRPC: ProcessCall

信令服务器 → 媒体服务器的唯一接口：

```protobuf
service CallProcessor {
    rpc ProcessCall(ProcessCallRequest) returns (ProcessCallResponse);
}

message ProcessCallRequest {
    int64 tenant_id = 1;
    string call_id = 2;
    CallContext context = 3;
    CallDestination destination = 4;
}

message CallContext {
    string from_user = 1;
    string from_host = 2;
    string to_user = 3;
    string to_host = 4;
    string source_address = 5;
    uint32 source_port = 6;
    string transport = 7;
    map<string, string> headers = 8;
}

message CallDestination {
    oneof destination {
        ExtensionTarget extension = 1;
        TrunkTarget trunk = 2;
        RoutePointTarget route_point = 3;
        IvrFlowTarget ivr_flow = 4;
        HuntGroupTarget hunt_group = 5;
        ConferenceTarget conference = 6;
    }
}

message ExtensionTarget { int64 extension_id = 1; }
message TrunkTarget { int64 trunk_group_id = 1; }
message RoutePointTarget { int64 route_point_id = 1; }
message IvrFlowTarget { int64 ivr_flow_id = 1; }
message HuntGroupTarget { int64 hunt_group_id = 1; }
message ConferenceTarget { int64 conference_id = 1; }

message ProcessCallResponse {
    CallStatus status = 1;
    string message = 2;
}

enum CallStatus {
    ACCEPTED = 0;
    REJECTED = 1;
    NO_CONTACT = 2;       // 分机未注册
    TRUNK_UNAVAILABLE = 3;
    CONFERENCE_FULL = 4;
    ERROR = 5;
}
```

## 5. 目的地配置

### 5.1 巡线组（HuntGroup）

```rust
struct HuntGroup {
    id: i64,
    tenant_id: i64,
    name: String,
    members: Vec<HuntGroupMember>,
    strategy: HuntStrategy,
    /// 振铃超时（毫秒），超时后触发 fallback
    timeout_ms: u32,
    /// 无人应答时的兜底目的地
    fallback_destination: Option<RouteDestination>,
}

struct HuntGroupMember {
    id: i64,
    extension_id: i64,
    /// 顺序振铃时的优先级（数值越小越先振铃）
    priority: i32,
    /// 单成员振铃超时（仅 Sequential 模式有效）
    timeout_ms: Option<u32>,
}

enum HuntStrategy {
    /// 按 priority 依次振铃，前一个超时后振铃下一个
    Sequential,
    /// 同时振铃所有成员，谁先接算谁的
    Simultaneous,
    /// 轮询：记住上次振铃起始位置，每次从下一个成员开始
    RoundRobin,
}
```

### 5.2 会议室（ConferenceRoom）

```rust
struct ConferenceRoom {
    id: i64,
    tenant_id: i64,
    name: String,
    /// 会议室编号（可作为分机拨入）
    extension: String,
    /// 最大参会人数
    max_participants: u32,
    /// 入会密码（可选）
    pin: Option<String>,
    /// 主持人分机（可选，主持人可管理会议）
    moderator_extension: Option<String>,
    /// 等待音配置（可选，满员或等待主持人时播放）
    music_on_hold_id: Option<i64>,
}
```

### 5.3 路由点（RoutePoint）

```rust
struct RoutePoint {
    id: i64,
    tenant_id: i64,
    name: String,
    /// 入口编号（可被路由规则匹配到）
    extension: String,
    /// 关联的 Call Flow（唯一）
    call_flow_id: i64,
}
```

路由点只能关联一个 Call Flow，类似 Avaya CM 中的 Vector 概念。

### 5.4 Call Flow（Vector）

```rust
struct CallFlow {
    id: i64,
    tenant_id: i64,
    name: String,
    /// 有序步骤列表，按索引执行
    steps: Vec<FlowStep>,
}

enum FlowStep {
    /// 条件分支：评估条件，跳转到对应步骤索引
    Conditional {
        condition: MatchConditions,
        true_step_index: usize,
        false_step_index: usize,
    },

    /// 收集按键输入：播放提示音，等待用户按键
    CollectDigits {
        /// 提示音 ID
        prompt_id: i64,
        /// 最大输入位数
        max_digits: u8,
        /// 输入超时（毫秒）
        timeout_ms: u32,
        /// 结果存储的变量名，供后续步骤引用
        result_variable: String,
    },

    /// 外部数据查询：查询数据库或外部服务
    DataLookup {
        /// 查询源标识
        source: String,
        /// 查询语句
        query: String,
        /// 结果存储的变量名
        result_variable: String,
    },

    /// 播放提示音
    PlayPrompt {
        prompt_id: i64,
    },

    /// 路由到终端目的地：Call Flow 的终止步骤
    RouteTo {
        destination: RouteDestination,
    },
}
```

Call Flow 执行规则：
- 从 `steps[0]` 开始顺序执行
- `Conditional` 步骤通过 `true_step_index` / `false_step_index` 实现跳转
- `RouteTo` 是终止步骤，执行后 Call Flow 结束
- 执行到 `steps` 末尾无 `RouteTo` → 返回无匹配

## 6. 数据库表变更

### 6.1 新增表

```sql
-- 路由规则（统一模型）
CREATE TABLE routing_rules (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    priority INT NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    name VARCHAR(128) NOT NULL,
    -- 来源
    source_type VARCHAR(16) NOT NULL,    -- 'trunk' | 'extension' | 'api'
    source_ref_id BIGINT NOT NULL,       -- trunk_id / extension_id / api_key_id
    -- 匹配条件
    match_source_address TEXT,           -- 正则
    match_source_port VARCHAR(32),       -- 端口范围 "1024-65535"
    match_transport VARCHAR(8),          -- 'UDP' | 'TCP' | 'TLS' | 'WSS'
    match_from_user TEXT,
    match_from_host TEXT,
    match_to_user TEXT,
    match_to_host TEXT,
    match_request_user TEXT,
    match_request_host TEXT,
    -- 重写规则
    rewrite_from_user TEXT,
    rewrite_from_host TEXT,
    rewrite_to_user TEXT,
    rewrite_to_host TEXT,
    rewrite_request_user TEXT,
    rewrite_request_host TEXT,
    -- 目的地
    dest_type VARCHAR(16) NOT NULL,      -- 'extension' | 'trunk' | 'route_point' | 'ivr_flow' | 'hunt_group' | 'conference'
    dest_ref_id BIGINT NOT NULL,
    -- 元数据
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- 巡线组
CREATE TABLE hunt_groups (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    strategy VARCHAR(16) NOT NULL DEFAULT 'sequential',  -- 'sequential' | 'simultaneous' | 'round_robin'
    timeout_ms INT NOT NULL DEFAULT 30000,
    fallback_dest_type VARCHAR(16),
    fallback_dest_ref_id BIGINT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- 巡线组成员
CREATE TABLE hunt_group_members (
    id BIGINT PRIMARY KEY,
    hunt_group_id BIGINT NOT NULL,
    extension_id BIGINT NOT NULL,
    priority INT NOT NULL DEFAULT 0,
    timeout_ms INT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- 会议室
CREATE TABLE conference_rooms (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    extension VARCHAR(32) NOT NULL,
    max_participants INT NOT NULL DEFAULT 10,
    pin VARCHAR(16),
    moderator_extension VARCHAR(32),
    music_on_hold_id BIGINT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- Call Flow（Vector）
CREATE TABLE call_flows (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    steps JSON NOT NULL,                 -- FlowStep 数组的 JSON 序列化
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- 路由点
CREATE TABLE route_points (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    extension VARCHAR(32) NOT NULL,
    call_flow_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
```

### 6.2 移除表

- `time_conditions` — 时间条件不再使用

### 6.3 保留表

- `dial_plans` — 号码规范化，作为前置阶段保留
- `trunks` — 中继配置
- `extensions` — 分机配置
- `ivr_flows` — IVR 流程配置

## 7. 配置热加载

路由规则通过 Config Service 管理，变更通过 Redis Pub/Sub 通知：

```
config-service 写入 DB
  → 发布 Redis Pub/Sub: config:{tenant_id}:routing_rules
  → 信令服务器 ConfigWatcher 收到事件
  → 重新编译该租户的规则表（正则预编译）
  → Arc 原子替换，旧版本读者不受影响
```

媒体服务器同理，加载 Call Flow、Hunt Group、Conference 等配置。

## 8. 实现阶段

### Phase 1: 核心路由

- RoutingRule 数据模型 + DB 表
- 信令服务器：来源识别 → 匹配 → 重写 → ProcessCall
- Dial Plan 前置阶段
- gRPC ProcessCall 接口
- 媒体服务器：Extension / Trunk 目的地处理

### Phase 2: 高级目的地

- HuntGroup 配置 + 媒体服务器巡线振铃
- ConferenceRoom 配置 + 媒体服务器会议桥接
- RoutePoint + Call Flow 配置 + 媒体服务器 Vector 执行引擎

### Phase 3: 增强

- DataLookup 步骤（外部数据查询）
- Call Flow 变量系统
- 路由规则审计日志
- 多站点路由同步
