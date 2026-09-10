# Routing Engine 设计文档

**版本**: 2.0.0  
**日期**: 2026-09-09  
**状态**: 设计完成（待 review）

---

## 1. 概述

### 1.1 定位

Routing Engine（路由引擎）是 NextSWITCH 的统一路由决策服务，独立于信令层和业务层部署。其职责是：**给定一个交互（Interaction），返回一个路由目标（Route Target）**。

它不处理 SIP 信令，不管理坐席状态，不操控媒体流。它只做一件事——路由决策，并做到极致。

### 1.2 设计灵感

参考 Genesys Universal Routing (UR) 架构：

- **路由与信令分离**：Genesys 的 URS 不碰 SIP，SIP Server 通过 T-Library 的 `TRouteCall` 请求路由决策。NextSWITCH 采用相同理念，路由引擎通过 gRPC 接收路由请求。
- **统一交互抽象**：Genesys 将语音、邮件、聊天统一为 "Interaction"。NextSWITCH 同样将 SIP 呼叫、IM 消息、回调请求统一为 `InteractionInfo`。
- **策略驱动**：Genesys 用可视化流程图（IRD/Composer）定义路由策略。NextSWITCH 用分层路由（规则 + 图引擎）实现同等灵活性。

### 1.3 核心职责

- **分层路由决策**：第一层快速规则匹配处理 80% 场景，第二层图引擎处理复杂编排
- **号码标准化**：通过拨号计划（Dial Plan）统一号码格式
- **配置热加载**：订阅配置变更通知，无停机更新路由表
- **多租户隔离**：每个租户独立的路由表快照，互不干扰
- **降级容错**：路由引擎不可用时，消费方可降级到本地缓存规则

### 1.4 Non-Goals

- 不实现 SIP 信令处理（由 sipserver/sigserver 负责）
- 不实现坐席选择/ACD 分配（由 CTI Service 负责）
- 不实现媒体处理（由 medserver 负责）
- 不实现配置 CRUD（由 config-service 负责）
- 不实现用户认证（由 auth-service 负责）

---

## 2. 架构

### 2.1 服务拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clients                                  │
│  (SIP INVITE / IM Message / Callback Request)                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  sipserver / │  │  IM Service  │  │  CTI Service │
│ sigserver │  │              │  │  (Callback)  │
│              │  │              │  │              │
│ gRPC Client  │  │ gRPC Client  │  │ gRPC Client  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │    gRPC: RouteInteraction()       │
       ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    router-server (Routing Engine)                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Routing Engine                          │    │
│  │                                                          │    │
│  │  ┌───────────────┐    ┌──────────────────────────────┐  │    │
│  │  │  Layer 1      │    │  Layer 2                     │  │    │
│  │  │  Fast Path    │───►│  Flow Engine                 │  │    │
│  │  │  (规则匹配)    │    │  (图引擎 / 复杂编排)          │  │    │
│  │  └───────────────┘    └──────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │  Config Sync     │  │  Flow Instance   │                    │
│  │  Manager         │  │  Store (Redis)   │                    │
│  └────────┬─────────┘  └──────────────────┘                    │
└───────────┼─────────────────────────────────────────────────────┘
            │
     ┌──────┴──────┐
     ▼             ▼
┌─────────┐  ┌──────────┐
│ Config  │  │  Redis   │
│ Service │  │  Pub/Sub │
│ (gRPC)  │  │  (变更通知)│
└─────────┘  └──────────┘
```

### 2.2 与现有服务的职责边界

| 服务 | 职责 | 与路由引擎的交互 |
|------|------|----------------|
| **sipserver / sigserver** | SIP 信令处理、注册管理 | 收到 INVITE 后调用 `RouteInteraction()` 获取路由目标 |
| **config-service** | 配置 CRUD、版本控制 | 路由引擎启动时通过 gRPC 加载配置，运行时通过 Redis Pub/Sub 接收变更通知 |
| **cti-server** | 坐席管理、ACD 分配、呼叫控制 | 接收路由引擎的入队请求，执行坐席选择策略 |
| **medserver** | 媒体处理（播放、收号、录音） | 接收路由引擎图引擎的播放/收号指令 |
| **im-server** | 多渠道消息（WebChat、微信等） | 收到消息后调用 `RouteInteraction()` 获取路由目标 |

### 2.3 Crate 结构

```
crates/
  nextswitch-router/
    src/
      lib.rs                    # 库入口
      main.rs                   # 二进制入口（router-server）
      config.rs                 # 服务配置
      engine/
        mod.rs
        routing_engine.rs       # 路由引擎核心（DashMap + Arc 快照）
        layer1/
          mod.rs
          dial_plan.rs          # 拨号计划：号码标准化
          route_point.rs        # 路由点查找
          rule_matcher.rs       # 规则匹配引擎
          condition.rs          # 条件表达式求值器
        layer2/
          mod.rs
          flow_scheduler.rs     # 图引擎调度器
          flow_graph.rs         # 流程图数据结构
          nodes/
            mod.rs
            condition.rs        # 条件判断节点
            play_prompt.rs      # 播放提示音节点
            collect_digits.rs   # 收集用户输入节点
            data_lookup.rs      # 外部数据查询节点
            enqueue.rs          # 排队节点
            select_agent.rs     # 坐席选择节点
            transfer.rs         # 转接节点
            hangup.rs           # 挂断节点
          instance.rs           # 流程实例状态
          instance_store.rs     # 流程实例 Redis 持久化
      sync/
        mod.rs
        config_loader.rs        # 启动时全量加载
        config_watcher.rs       # Redis Pub/Sub 变更监听
        compiler.rs             # DB 数据 → 运行时结构编译
      types/
        mod.rs
        request.rs              # RouteRequest / RouteResult
        interaction.rs          # InteractionInfo
        condition.rs            # RouteCondition 枚举
        action.rs               # RouteAction 枚举
        flow.rs                 # FlowNode / FlowEdge / FlowVar
      grpc/
        mod.rs
        server.rs               # gRPC 服务端
        route_service.rs        # RouteInteraction 实现
      error.rs                  # 错误定义
      metrics.rs                # Prometheus 指标
```

---

## 3. 通信协议

### 3.1 gRPC 接口（主路径）

路由引擎对外暴露 gRPC 服务，消费方通过同步请求/响应获取路由决策。

```protobuf
service RoutingService {
    // 路由一个交互
    rpc RouteInteraction(RouteRequest) returns (RouteResponse);
    
    // 查询路由引擎状态
    rpc GetStatus(StatusRequest) returns (StatusResponse);
}

message RouteRequest {
    int64 tenant_id = 1;
    string interaction_id = 2;          // 唯一标识本次交互
    InteractionType interaction_type = 3;
    string caller = 4;                  // 主叫号码/标识
    string callee = 5;                  // 被叫号码/接入号
    map<string, string> headers = 6;    // SIP Headers / 自定义变量
    map<string, string> variables = 7;  // 附加上下文（如 CRM 预取数据）
    int64 route_point_id = 8;           // 可选：指定路由点（跳过查找）
}

enum InteractionType {
    INTERACTION_TYPE_UNSPECIFIED = 0;
    INTERACTION_TYPE_VOICE = 1;         // SIP 语音呼叫
    INTERACTION_TYPE_CHAT = 2;          // IM 聊天
    INTERACTION_TYPE_EMAIL = 3;         // 邮件
    INTERACTION_TYPE_CALLBACK = 4;      // 回调请求
    INTERACTION_TYPE_SOCIAL = 5;        // 社交媒体消息
}

message RouteResponse {
    RouteDecision decision = 1;
    string flow_instance_id = 2;        // 如果进入图引擎，返回实例 ID
    int64 matched_rule_id = 3;          // 命中的规则 ID（审计用）
    int64 route_table_version = 4;      // 使用的路由表版本号
    int64 decision_time_us = 5;         // 决策耗时（微秒）
    RouteTarget target = 6;             // 具体路由目标信息（根据 decision 填充）
}

enum RouteDecision {
    ROUTE_DECISION_UNSPECIFIED = 0;
    ROUTE_DECISION_DIRECT = 1;          // 直连分机
    ROUTE_DECISION_QUEUE = 2;           // 转队列
    ROUTE_DECISION_IVR = 3;             // 转 IVR
    ROUTE_DECISION_TRUNK = 4;           // 转中继
    ROUTE_DECISION_CALL_FLOW = 5;       // 进入呼叫流程（图引擎）
    ROUTE_DECISION_CONFERENCE = 6;      // 转会议
    ROUTE_DECISION_EXTERNAL = 7;        // 外部路由
    ROUTE_DECISION_DENY = 8;            // 拒绝
    ROUTE_DECISION_NO_MATCH = 9;        // 无匹配
}

// 具体路由目标信息（根据 decision 类型填充对应字段）
message RouteTarget {
    oneof target {
        DirectTarget direct = 1;
        QueueTarget queue = 2;
        IvrTarget ivr = 3;
        TrunkTarget trunk = 4;
        CallFlowTarget call_flow = 5;
        ConferenceTarget conference = 6;
        ExternalTarget external = 7;
        DenyTarget deny = 8;
    }
}

message DirectTarget {
    string extension = 1;
    string contact_uri = 2;             // 从注册表解析的 Contact
}

message QueueTarget {
    int64 queue_id = 1;
    int32 priority = 2;
}

message IvrTarget {
    int64 flow_id = 1;
}

message TrunkTarget {
    string trunk_group = 1;
    string normalized_number = 2;       // 标准化后的号码
    optional string strip_prefix = 3;
}

message CallFlowTarget {
    int64 flow_id = 1;
    string flow_instance_id = 2;
}

message ConferenceTarget {
    string conference_id = 1;
}

message ExternalTarget {
    string target = 1;
    map<string, string> params = 2;
}

message DenyTarget {
    string reason = 1;
}
```

### 3.2 Redis 降级（备用路径）

当路由引擎不可达时，SIP 信令服务器可降级到本地缓存的路由规则做快速决策。

**降级范围**：仅支持第一层的简单路由（分机直连、中继路由），不支持图引擎。

**降级数据来源**：SIP 信令服务器启动时从路由引擎获取一份精简的路由规则快照，缓存在本地内存。

```rust
// sipserver 侧的降级缓存
pub struct FallbackRouteCache {
    // 仅缓存 route_points 和 dial_plans，不含 routing_rules
    route_points: HashMap<String, FallbackRoutePoint>,
    dial_plans: Vec<FallbackDialPlan>,
    last_synced_at: Instant,
}

pub struct FallbackRoutePoint {
    extension: String,
    route_type: RouteType,
    route_target: String,
}
```

**降级行为**：

| 场景 | 行为 |
|------|------|
| 分机直连（route_type=extension） | 查本地缓存，命中则直接路由 |
| 中继路由（dial_plan 匹配） | 查本地缓存，命中则直接路由 |
| 需要图引擎（route_type=call_flow） | 降级失败，返回 503 Service Unavailable |
| 需要 ACD（route_type=queue） | 降级失败，返回 503 Service Unavailable |
| 缓存过期（>5 分钟未同步） | 所有降级结果附带 `stale=true` 标记 |

---

## 4. 数据模型

### 4.1 运行时数据结构

路由引擎从 config-service 读取数据库表数据，在内存中构建**编译后的运行时结构**。运行时结构与 DB 表不是一一对应——DB 表面向存储，运行时结构面向性能。

#### 4.1.1 租户路由表

```rust
/// 租户路由表 —— 为每个租户维护一份不可变快照
/// 通过 Arc 实现无锁读 + 原子替换
pub struct TenantRouteTable {
    pub tenant_id: i64,
    pub version: u64,                           // 单调递增，每次重建时 +1
    
    /// 拨号计划：按 priority DESC 排序，用于号码标准化
    pub dial_plans: Vec<DialPlanEntry>,
    
    /// 路由点：extension → RoutePointEntry 快速查找
    pub route_points: HashMap<String, RoutePointEntry>,
    
    /// 路由规则：按 priority DESC 排序，顺序匹配
    pub routing_rules: Vec<RoutingRuleEntry>,
    
    /// 时间条件：name → TimeConditionEntry
    pub time_conditions: HashMap<String, TimeConditionEntry>,
}
```

#### 4.1.2 第一层数据结构

```rust
/// 拨号计划条目（编译后）
pub struct DialPlanEntry {
    pub id: i64,
    pub name: String,
    pub pattern: Regex,                         // 编译后的正则
    pub priority: i32,
    pub action: DialPlanAction,
    pub replacement: Option<String>,            // Transform 时的替换模板
}

pub enum DialPlanAction {
    Allow,                                      // 允许通过，不修改号码
    Deny,                                       // 拒绝
    Transform,                                  // 号码转换
}

/// 路由点条目（编译后）
pub struct RoutePointEntry {
    pub id: i64,
    pub name: String,
    pub extension: String,
    pub route_type: RouteType,
    pub route_target: String,
    pub priority: i32,
    pub fallback_target: Option<String>,
    pub timeout_secs: u32,
    pub settings: serde_json::Value,
}

pub enum RouteType {
    Extension,                                  // 直连分机
    Queue,                                      // 转队列
    Trunk,                                      // 转中继
    Ivr,                                        // 转 IVR
    CallFlow,                                   // 转呼叫流程（图引擎）
    Conference,                                 // 转会议
    External,                                   // 外部路由
}

/// 路由规则条目（编译后）
pub struct RoutingRuleEntry {
    pub id: i64,
    pub name: String,
    pub priority: i32,
    pub condition: RouteCondition,              // 编译后的条件树
    pub action: RouteAction,
    pub status: String,
}
```

#### 4.1.3 条件表达式

条件表达式从 config-service 的 `routing_rules.condition_expr` JSON 编译而来，支持嵌套组合：

```rust
pub enum RouteCondition {
    /// 主叫号码匹配
    CallerMatches(Regex),
    /// 被叫号码匹配
    CalleeMatches(Regex),
    /// 时间条件（引用 time_conditions 表）
    TimeMatches(String),
    /// SIP Header / 自定义变量匹配
    HeaderMatches { key: String, pattern: Regex },
    /// 交互类型匹配
    InteractionTypeMatches(Vec<InteractionType>),
    /// 逻辑组合
    All(Vec<RouteCondition>),                   // AND
    Any(Vec<RouteCondition>),                   // OR
    Not(Box<RouteCondition>),                   // NOT
    /// 始终匹配（兜底规则）
    Always,
}
```

**condition_expr JSON 示例**：

```json
{
    "op": "all",
    "conditions": [
        { "op": "caller_matches", "pattern": "^1[3-9]\\d{9}$" },
        { "op": "time_matches", "name": "business_hours" },
        { "op": "any", "conditions": [
            { "op": "header_matches", "key": "X-Priority", "pattern": "high" },
            { "op": "header_matches", "key": "X-VIP", "pattern": "true" }
        ]}
    ]
}
```

#### 4.1.4 路由动作

```rust
pub enum RouteAction {
    /// 直接转分机
    Direct { extension: String },
    /// 转队列
    Queue { queue_id: i64, priority: i32 },
    /// 转 IVR
    Ivr { flow_id: i64 },
    /// 转中继
    Trunk { trunk_group: String, strip_prefix: Option<String> },
    /// 转复杂呼叫流程（触发第二层图引擎）
    CallFlow { flow_id: i64 },
    /// 转会议
    Conference { conference_id: String },
    /// 拒绝
    Deny { reason: String },
    /// 外部路由（跨租户/跨站点）
    External { target: String, params: serde_json::Value },
}
```

#### 4.1.5 第二层数据结构（图引擎）

**flow_definition JSON 格式**：

`call_flows.flow_definition` 字段的 JSON 结构如下，路由器启动时将其编译为 `CallFlowGraph`：

```json
{
    "entry_node_id": 1,
    "nodes": [
        { "id": 1, "type": "play_prompt", "config": { "prompt_id": 101, "allow_skip": true } },
        { "id": 2, "type": "collect_digits", "config": { "timeout_secs": 5, "max_digits": 1, "result_var": "digit" } },
        { "id": 3, "type": "condition", "config": { "condition": { "op": "header_matches", "key": "digit", "pattern": "1" } } },
        { "id": 4, "type": "enqueue", "config": { "queue_id": 10, "priority": 0 } },
        { "id": 5, "type": "hangup", "config": { "reason": "no_input" } }
    ],
    "edges": [
        { "from": 1, "to": 2 },
        { "from": 2, "to": 3 },
        { "from": 3, "to": 4, "condition": { "op": "header_matches", "key": "digit", "pattern": "1" }, "label": "销售" },
        { "from": 3, "to": 5, "label": "默认" }
    ]
}
```

**Rust 运行时结构**：

```rust
/// 呼叫流程图 —— 从 call_flows.flow_definition JSON 编译而来
pub struct CallFlowGraph {
    pub id: i64,
    pub name: String,
    pub tenant_id: i64,
    pub entry_node_id: i64,
    pub nodes: HashMap<i64, FlowNode>,
    pub edges: HashMap<i64, Vec<FlowEdge>>,       // from_node_id → 出边列表
}

/// 流程节点
pub enum FlowNode {
    /// 条件判断节点
    Condition { condition: RouteCondition },
    /// 查外部数据（CRM、数据库）
    DataLookup { source: String, query: String, result_var: String, timeout_ms: u64 },
    /// 播放提示音
    PlayPrompt { prompt_id: i64, allow_skip: bool },
    /// 收集用户输入
    CollectDigits { timeout_secs: u32, max_digits: u32, result_var: String },
    /// 排队等待
    Enqueue { queue_id: i64, priority: i32 },
    /// 分配坐席（触发 ACD）
    SelectAgent { queue_id: i64, strategy: Option<String> },
    /// 转接
    Transfer { target: TransferTarget },
    /// 挂断
    Hangup { reason: String },
}

pub enum TransferTarget {
    Extension(String),
    Queue(i64),
    External(String),
}

/// 流程边
pub struct FlowEdge {
    pub to_node_id: i64,
    pub condition: Option<RouteCondition>,        // None = 默认边（default branch）
    pub label: Option<String>,
}

/// 流程变量
pub enum FlowVar {
    String(String),
    Number(f64),
    Bool(bool),
    Json(serde_json::Value),
}
```

### 4.2 与配置服务 DB 表的映射

| config-service DB 表 | 路由引擎运行时结构 | 编译动作 |
|----------------------|-------------------|---------|
| `dial_plans` | `Vec<DialPlanEntry>` | 正则预编译，按 priority DESC 排序 |
| `route_points` | `HashMap<String, RoutePointEntry>` | 以 extension 为 key 建索引 |
| `routing_rules` | `Vec<RoutingRuleEntry>` | condition_expr JSON → `RouteCondition` 树，按 priority DESC 排序 |
| `time_conditions` | `HashMap<String, TimeConditionEntry>` | 时间范围 JSON → 可求值结构 |
| `call_flows` | `HashMap<i64, CallFlowGraph>` | flow_definition JSON → 节点+边图 |

---

## 5. 路由决策流程

### 5.1 第一层：快速路径

```
RouteRequest 到达
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 1: 号码标准化（Dial Plan）                               │
│                                                              │
│ 遍历 dial_plans（按 priority DESC）：                          │
│   - 匹配 Deny → 返回 RouteDecision::Deny                    │
│   - 匹配 Transform → 替换 callee，继续                       │
│   - 匹配 Allow → 不修改，继续                                │
│   - 无匹配 → 保持原始号码                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ normalized_callee
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 2: 路由点查找（Route Point Lookup）                      │
│                                                              │
│ route_points.get(normalized_callee)                          │
│   - 命中 → 根据 route_type 处理：                             │
│       Extension → 查注册表解析 Contact → Direct              │
│       Queue → Queue                                        │
│       Ivr → 启动图引擎 → CallFlow                            │
│       CallFlow → 启动图引擎 → CallFlow                       │
│       Trunk → Trunk                                        │
│       Conference → Conference                                │
│       External → External                                    │
│   - 未命中 → 继续 Step 3                                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Step 3: 规则匹配（Routing Rules）                             │
│                                                              │
│ 遍历 routing_rules（按 priority DESC）：                      │
│   - evaluate(condition, request) == true                    │
│     → 执行 action → 返回对应 RouteDecision                   │
│   - 全部未命中 → 返回 RouteDecision::NoMatch                 │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 第一层核心实现

```rust
impl RoutingEngine {
    /// 路由一个交互 —— 主入口
    pub async fn route(&self, request: &RouteRequest) -> RouteResult {
        let start = Instant::now();
        
        let table = self.tables.get(&request.tenant_id)
            .ok_or(RouteError::TenantNotFound(request.tenant_id))?;
        
        // Step 1: 号码标准化
        let normalized = self.apply_dial_plans(&table.dial_plans, &request.callee);
        if let Some(deny) = normalized.as_denied() {
            return Ok(RouteResult {
                decision: RouteDecision::Deny,
                target: Some(RouteTarget::Deny(DenyTarget { reason: deny.reason })),
                decision_time_us: start.elapsed().as_micros() as i64,
                route_table_version: table.version,
                ..Default::default()
            });
        }
        let callee = normalized.callee();
        
        // Step 2: 路由点查找
        if let Some(rp) = table.route_points.get(callee) {
            return self.resolve_route_point(rp, request, &table, start).await;
        }
        
        // Step 3: 规则匹配
        for rule in &table.routing_rules {
            if self.evaluate_condition(&rule.condition, request, &table.time_conditions) {
                return self.execute_action(&rule.action, request, &table, rule.id, start).await;
            }
        }
        
        // 无匹配
        Ok(RouteResult {
            decision: RouteDecision::NoMatch,
            decision_time_us: start.elapsed().as_micros() as i64,
            route_table_version: table.version,
            ..Default::default()
        })
    }
    
    /// 拨号计划处理
    fn apply_dial_plans(&self, plans: &[DialPlanEntry], callee: &str) -> DialPlanResult {
        for plan in plans {
            if plan.pattern.is_match(callee) {
                match plan.action {
                    DialPlanAction::Deny => return DialPlanResult::Denied(plan.name.clone()),
                    DialPlanAction::Transform => {
                        let transformed = plan.replacement.as_ref()
                            .map(|r| plan.pattern.replace(callee, r).into_owned())
                            .unwrap_or_else(|| callee.to_string());
                        return DialPlanResult::Transformed(transformed);
                    }
                    DialPlanAction::Allow => return DialPlanResult::Allowed(callee.to_string()),
                }
            }
        }
        DialPlanResult::Allowed(callee.to_string())
    }
}
```

### 5.3 第二层：图引擎执行

当第一层的 `RouteAction::CallFlow` 或 `RouteType::CallFlow` / `RouteType::Ivr` 被命中时，交互进入第二层图引擎。

#### 5.3.1 执行模型

图引擎是一个**事件驱动的状态机**。每个流程实例（FlowInstance）在节点间流转，每个节点执行一个动作后根据边的条件跳转到下一个节点。

关键区别：第一层是**同步决策**（输入 → 匹配 → 输出目标），第二层是**异步编排**（流程可能在某个节点挂起等待外部事件，如用户按键、坐席应答、API 返回）。

#### 5.3.2 流程实例

```rust
/// 流程实例 —— 一次 call_flow 的执行
pub struct FlowInstance {
    pub instance_id: Uuid,
    pub flow_id: i64,
    pub tenant_id: i64,
    pub interaction: InteractionInfo,
    
    pub state: FlowState,
    pub current_node_id: i64,
    
    /// 运行时变量池
    pub variables: HashMap<String, FlowVar>,
    
    /// 执行追踪（审计 + 调试）
    pub trace: Vec<FlowTraceEntry>,
    
    pub started_at: Instant,
    pub node_entered_at: Instant,
    pub global_timeout: Option<Duration>,
}

pub enum FlowState {
    /// 正在执行节点动作
    Executing,
    /// 等待外部事件
    Waiting { event: WaitEvent, timeout: Duration },
    /// 流程正常结束
    Completed { reason: String },
    /// 流程异常终止
    Failed { error: FlowError },
}

pub enum WaitEvent {
    Digits { result_var: String },
    AgentAnswered { queue_id: i64 },
    ExternalResult { request_id: String },
    PlaybackFinished { prompt_id: i64 },
}
```

#### 5.3.3 节点执行器

每个节点类型有独立的执行逻辑，统一通过 `NodeExecutor` trait 抽象：

```rust
#[async_trait]
pub trait NodeExecutor: Send + Sync {
    async fn execute(
        &self,
        instance: &mut FlowInstance,
        node: &FlowNode,
        ctx: &FlowExecutionContext,
    ) -> NodeResult;
}

pub enum NodeResult {
    /// 动作立即完成，携带输出变量
    Completed { outputs: HashMap<String, FlowVar> },
    /// 动作需要等待外部事件
    Pending { event: WaitEvent },
    /// 节点执行失败
    Failed { error: FlowError },
}
```

**各节点执行逻辑**：

| 节点类型 | 执行方式 | 结果 | 交互对象 |
|---------|---------|------|---------|
| `Condition` | 同步求值 | Completed | 无 |
| `DataLookup` | 异步 HTTP/gRPC | Completed（携带查询结果变量） | 外部 API |
| `PlayPrompt` | 异步 | Pending(PlaybackFinished) | medserver |
| `CollectDigits` | 异步 | Pending(Digits) | medserver |
| `Enqueue` | 异步 | Pending(AgentAnswered) | cti-server |
| `SelectAgent` | 异步 | Pending(AgentAnswered) | cti-server (ACD) |
| `Transfer` | 同步（返回目标） | Completed | 无 |
| `Hangup` | 同步 | Completed | 无 |

#### 5.3.4 流程调度器

```rust
pub struct FlowScheduler {
    executors: HashMap<NodeType, Box<dyn NodeExecutor>>,
    evaluator: ConditionEvaluator,
    instance_store: FlowInstanceStore,
    engine: Arc<RoutingEngine>,
    media_client: MediaServerClient,
    cti_client: CtiServiceClient,
    http_client: reqwest::Client,
}

impl FlowScheduler {
    /// 启动一个流程实例
    pub async fn start(
        &self,
        flow: &Arc<CallFlowGraph>,
        interaction: InteractionInfo,
    ) -> Result<FlowInstance> {
        let mut instance = FlowInstance::new(flow, interaction);
        
        // 执行循环：持续执行直到 Pending 或 Completed
        while instance.state == FlowState::Executing {
            self.step(&mut instance, flow).await?;
        }
        
        // 如果挂起，持久化状态到 Redis
        if matches!(instance.state, FlowState::Waiting { .. }) {
            self.instance_store.save(&instance).await?;
        }
        
        Ok(instance)
    }
    
    /// 单步执行：执行当前节点，跳转到下一个节点
    async fn step(&self, instance: &mut FlowInstance, flow: &CallFlowGraph) -> Result<()> {
        let node = flow.nodes.get(&instance.current_node_id)
            .ok_or(FlowError::NodeNotFound(instance.current_node_id))?;
        
        let executor = self.executors.get(&node.node_type())
            .ok_or(FlowError::UnsupportedNodeType(node.node_type()))?;
        
        instance.trace.push(FlowTraceEntry {
            node_id: instance.current_node_id,
            entered_at: Instant::now(),
        });
        
        let ctx = FlowExecutionContext {
            evaluator: &self.evaluator,
            media_client: &self.media_client,
            cti_client: &self.cti_client,
            http_client: &self.http_client,
        };
        
        let result = executor.execute(instance, node, &ctx).await?;
        
        match result {
            NodeResult::Completed { outputs } => {
                instance.variables.extend(outputs);
                let next_node = self.resolve_next_node(instance, flow)?;
                instance.current_node_id = next_node;
            }
            NodeResult::Pending { event } => {
                instance.state = FlowState::Waiting {
                    event,
                    timeout: self.node_timeout(node),
                };
            }
            NodeResult::Failed { error } => {
                instance.state = FlowState::Failed { error };
            }
        }
        
        Ok(())
    }
    
    /// 边选择：从当前节点的出边中找第一条条件匹配的边
    fn resolve_next_node(&self, instance: &FlowInstance, flow: &CallFlowGraph) -> Result<i64> {
        let edges = flow.edges.get(&instance.current_node_id)
            .ok_or(FlowError::NoEdges(instance.current_node_id))?;
        
        let mut default_edge = None;
        
        for edge in edges {
            match &edge.condition {
                Some(cond) => {
                    if self.evaluator.evaluate(cond, &instance.variables, &instance.interaction) {
                        return Ok(edge.to_node_id);
                    }
                }
                None => default_edge = Some(edge),
            }
        }
        
        default_edge
            .map(|e| e.to_node_id)
            .ok_or(FlowError::NoMatchingEdge(instance.current_node_id))
    }
}
```

#### 5.3.5 事件恢复

当外部事件到达时，调度器从 Redis 恢复流程实例继续执行：

```rust
impl FlowScheduler {
    /// 处理外部事件，唤醒挂起的流程实例
    pub async fn on_event(&self, event: FlowExternalEvent) -> Result<()> {
        match event {
            FlowExternalEvent::DigitsReceived { call_id, digits } => {
                let mut instance = self.instance_store.load_by_call_id(&call_id).await?;
                
                if let FlowState::Waiting { event: WaitEvent::Digits { result_var }, .. } = &instance.state {
                    instance.variables.insert(result_var.clone(), FlowVar::String(digits));
                    instance.state = FlowState::Executing;
                    
                    let flow = self.engine.get_flow(instance.flow_id).await?;
                    self.resume(&mut instance, &flow).await?;
                }
            }
            
            FlowExternalEvent::AgentAnswered { call_id, agent_id } => {
                let mut instance = self.instance_store.load_by_call_id(&call_id).await?;
                
                instance.variables.insert("selected_agent".into(), FlowVar::String(agent_id));
                instance.state = FlowState::Executing;
                
                let flow = self.engine.get_flow(instance.flow_id).await?;
                self.resume(&mut instance, &flow).await?;
            }
            
            FlowExternalEvent::PlaybackFinished { call_id } => {
                let mut instance = self.instance_store.load_by_call_id(&call_id).await?;
                instance.state = FlowState::Executing;
                
                let flow = self.engine.get_flow(instance.flow_id).await?;
                self.resume(&mut instance, &flow).await?;
            }
            
            FlowExternalEvent::Timeout { instance_id } => {
                let mut instance = self.instance_store.load(&instance_id).await?;
                let flow = self.engine.get_flow(instance.flow_id).await?;
                
                // 超时走默认边（无条件边）或终止
                let edges = flow.edges.get(&instance.current_node_id);
                if let Some(default_edge) = edges.and_then(|es| es.iter().find(|e| e.condition.is_none())) {
                    instance.current_node_id = default_edge.to_node_id;
                    instance.state = FlowState::Executing;
                    self.resume(&mut instance, &flow).await?;
                } else {
                    instance.state = FlowState::Failed { error: FlowError::Timeout };
                    self.instance_store.save(&instance).await?;
                }
            }
        }
        
        Ok(())
    }
    
    async fn resume(&self, instance: &mut FlowInstance, flow: &CallFlowGraph) -> Result<()> {
        while instance.state == FlowState::Executing {
            self.step(instance, flow).await?;
        }
        
        if matches!(instance.state, FlowState::Waiting { .. }) {
            self.instance_store.save(instance).await?;
        } else {
            self.instance_store.remove(&instance.instance_id).await?;
        }
        
        Ok(())
    }
}
```

#### 5.3.6 流程实例持久化（Redis）

```
Key: router:flow:instance:{instance_id}
Type: Hash
Fields:
  - flow_id: i64
  - tenant_id: i64
  - call_id: string
  - caller: string
  - callee: string
  - current_node_id: i64
  - state: Executing | Waiting | Completed | Failed
  - wait_event: JSON (WaitEvent 序列化)
  - variables: JSON (HashMap<String, FlowVar>)
  - trace: JSON (Vec<FlowTraceEntry>)
  - started_at: timestamp
  - node_entered_at: timestamp
TTL: 86400 (24h 自动清理僵尸实例)

Key: router:flow:call_index:{call_id}
Type: String
Value: {instance_id}
TTL: 86400
```

#### 5.3.7 执行示例

一个典型的 IVR → 技能路由流程：

```
call_flow: "sales_ivr_flow"

  ┌─────────┐     ┌──────────────┐     ┌────────────┐     ┌──────────┐
  │ Play    │────►│ Collect      │────►│ Condition  │────►│ Enqueue  │
  │ Prompt  │     │ Digits       │     │ digits=="1"│     │ sales_q  │
  │ "按1销售│     │ (5秒超时)    │     │ digits=="2"│──┐  │          │
  │  按2技术 │     │              │     │ timeout    │──┼─►│ Enqueue  │
  └─────────┘     └──────────────┘     └────────────┘  │  │ tech_q   │
                                                       │  └──────────┘
                                                       │
                                                       └──► Hangup
                                                         (无输入)

执行序列：
1. PlayPrompt     → Pending(PlaybackFinished)
                    → 事件到达：播放完成 → 继续
2. CollectDigits  → Pending(Digits)
                    → 用户按 "1" → variables["collected_digit"] = "1" → 继续
3. Condition      → Completed(matched=true, digits=="1" 的边)
                    → 继续
4. Enqueue(sales_q) → Pending(AgentAnswered)
                    → 坐席 A003 应答 → variables["selected_agent"] = "A003" → 继续
5. Transfer(agent=A003) → Completed
                    → 无出边 → Flow Completed
```

### 5.4 两层协作边界

```
SIP INVITE / IM Message 到达
    │
    ▼
第一层：RoutingEngine.route()
    │
    ├── dial_plan 匹配 → Deny → 403 Forbidden
    ├── route_point 命中 → route_type=extension → 查注册表 → Direct
    ├── route_point 命中 → route_type=queue → Queue（不进图引擎）
    ├── route_point 命中 → route_type=ivr → 启动图引擎 → CallFlow
    ├── route_point 命中 → route_type=call_flow → 启动图引擎 → CallFlow
    ├── route_point 命中 → route_type=trunk → Trunk
    ├── routing_rule 命中 → action=Direct → Direct
    ├── routing_rule 命中 → action=CallFlow{flow_id} → 启动图引擎 → CallFlow
    └── 无匹配 → NoMatch
    
第二层：FlowScheduler.start()
    │
    ├── 纯同步节点链（Condition → Transfer）→ 立即返回结果
    ├── 含异步节点（PlayPrompt → CollectDigits → Enqueue）→ 挂起等事件
    └── 图引擎需要 ACD 选坐席 → 通知 CTI 的 ACD Router 执行
```

**关键边界**：图引擎**不做坐席选择**。它只负责编排流程（播放、收号、查数据、排队），坐席选择是 CTI 服务 ACD Router 的职责。图引擎通过 `Enqueue` / `SelectAgent` 节点将交互交给 CTI，CTI 的 `DistributionStrategy` 负责选坐席。

---

## 6. 配置加载机制

### 6.1 架构

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Config Service  │         │  Redis Pub/Sub   │         │  Router Service  │
│                  │         │                  │         │                  │
│  DB (MySQL)      │         │                  │         │                  │
│  ┌────────────┐  │  write  │  config:{tid}:   │  sub    │  ┌────────────┐  │
│  │route_points│──┼────────►│  {entity_type}   │◄────────┼──│ ConfigSync │  │
│  │routing_rules│ │         │                  │         │  │  Manager   │  │
│  │dial_plans  │  │         │                  │         │  └─────┬──────┘  │
│  │call_flows  │  │         │                  │         │        │         │
│  └────────────┘  │         │                  │         │        ▼         │
│                  │         │                  │         │  ┌────────────┐  │
│  gRPC API        │         │                  │         │  │ load_full() │  │
│  LoadTenantConf()│◄────────┼──────────────────┼─────────┼──│ swap Arc   │  │
│                  │         │                  │         │  └─────┬──────┘  │
└──────────────────┘         │                  │         │        │         │
                             │                  │         │        ▼         │
                             │                  │         │  ┌────────────┐  │
                             │                  │         │  │RoutingEngine│  │
                             │                  │         │  │ (Arc swap) │  │
                             │                  │         │  └────────────┘  │
                             └──────────────────┘         └──────────────────┘
```

### 6.2 启动加载

```rust
pub struct ConfigSyncManager {
    engine: Arc<RoutingEngine>,
    config_client: ConfigServiceClient,     // gRPC 客户端
    redis: RedisPool,
}

impl ConfigSyncManager {
    /// 服务启动时：全量加载所有活跃租户的路由配置
    pub async fn initial_load(&self) -> Result<()> {
        let tenants = self.config_client.list_active_tenants().await?;
        
        for tenant in tenants {
            let table = self.load_tenant_table(tenant.id).await?;
            let flows = self.load_tenant_flows(tenant.id).await?;
            
            self.engine.install_table(tenant.id, Arc::new(table));
            for flow in flows {
                self.engine.install_flow(flow.id, Arc::new(flow));
            }
        }
        
        info!("Initial load complete: {} tenants", tenants.len());
        Ok(())
    }
    
    /// 加载单个租户的完整路由表
    async fn load_tenant_table(&self, tenant_id: i64) -> Result<TenantRouteTable> {
        // 并行加载四类配置
        let (dial_plans, route_points, routing_rules, time_conditions) = tokio::try_join!(
            self.config_client.get_dial_plans(tenant_id),
            self.config_client.get_route_points(tenant_id),
            self.config_client.get_routing_rules(tenant_id),
            self.config_client.get_time_conditions(tenant_id),
        )?;
        
        // 编译为运行时结构
        let compiled_plans = compile_dial_plans(dial_plans)?;
        let compiled_points = compile_route_points(route_points)?;
        let compiled_rules = compile_routing_rules(routing_rules)?;
        let compiled_times = compile_time_conditions(time_conditions)?;
        
        let version = self.engine.next_version(tenant_id);
        
        Ok(TenantRouteTable {
            tenant_id,
            version,
            dial_plans: compiled_plans,
            route_points: compiled_points,
            routing_rules: compiled_rules,
            time_conditions: compiled_times,
        })
    }
}
```

### 6.3 增量更新（Redis Pub/Sub 驱动）

```rust
impl ConfigSyncManager {
    /// 订阅配置变更，增量更新路由表
    pub async fn watch_changes(self: Arc<Self>) -> Result<()> {
        let mut pubsub = self.redis.get_async_pubsub().await?;
        
        // 订阅路由相关实体的变更通知
        // channel 格式: config:{tenant_id}:{entity_type}
        pubsub.psubscribe("config:*:route_points").await?;
        pubsub.psubscribe("config:*:routing_rules").await?;
        pubsub.psubscribe("config:*:dial_plans").await?;
        pubsub.psubscribe("config:*:call_flows").await?;
        pubsub.psubscribe("config:*:time_conditions").await?;
        
        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let (tenant_id, entity_type) = parse_channel(msg.channel())?;
            
            // 防抖：同一租户 500ms 内的多次变更合并为一次重载
            self.debounce_reload(tenant_id, &entity_type).await;
        }
        Ok(())
    }
    
    async fn debounce_reload(&self, tenant_id: i64, entity_type: &str) {
        // 500ms 防抖窗口
        tokio::time::sleep(Duration::from_millis(500)).await;
        
        // 重新加载该租户的完整路由表（而非单个实体）
        // 理由：实体之间有引用关系（route_point 引用 call_flow，routing_rule 引用 queue），
        // 增量更新容易不一致，全量重载更安全
        match self.load_tenant_table(tenant_id).await {
            Ok(new_table) => {
                let old_version = self.engine.get_version(tenant_id);
                self.engine.swap_table(tenant_id, Arc::new(new_table));
                info!(
                    tenant_id, entity_type,
                    old_version, new_version = old_version + 1,
                    "Route table reloaded"
                );
            }
            Err(e) => {
                error!(tenant_id, error = %e, "Failed to reload route table, keeping old version");
                // 不 panic，保留旧版本继续服务
            }
        }
    }
}
```

### 6.4 Arc 原子替换（无锁读路径）

```rust
impl RoutingEngine {
    /// 原子替换租户路由表
    /// 正在执行的 route() 调用使用旧 Arc 完成，新调用使用新 Arc
    pub fn swap_table(&self, tenant_id: i64, new_table: Arc<TenantRouteTable>) {
        self.tables.insert(tenant_id, new_table);
    }
    
    /// 路由时的读取路径 —— 无锁
    pub async fn route(&self, request: &RouteRequest) -> RouteResult {
        // Arc::clone 是原子操作，拿到快照引用
        let table = match self.tables.get(&request.tenant_id) {
            Some(t) => t.clone(),
            None => return Ok(RouteResult::no_match()),
        };
        // 即使此刻后台在 swap_table，本次 route 仍使用一致的旧快照
        // ...
    }
}
```

### 6.5 配置加载策略总结

| 决策 | 选择 | 理由 |
|------|------|------|
| 运行时结构 vs DB 表 | 编译后结构（Regex、HashMap） | 避免每次路由都做字符串解析和 JSON 反序列化 |
| 配置更新粒度 | 租户级全量重载 | 实体间有引用关系，增量更新容易不一致 |
| 变更通知 | Redis Pub/Sub + 500ms 防抖 | 与现有架构一致，防抖合并高频变更 |
| 并发控制 | Arc + DashMap | 读路径无锁，写路径原子替换 |
| 加载失败处理 | 保留旧版本 + 告警 | 路由是核心路径，不能因配置错误而完全不可用 |

---

## 7. 错误处理

### 7.1 错误分类

```rust
pub enum RouteError {
    /// 租户不存在（路由表未加载）
    TenantNotFound(i64),
    /// 流程图不存在
    FlowNotFound(i64),
    /// 条件表达式编译失败
    ConditionCompileError { rule_id: i64, detail: String },
    /// 图引擎节点不存在
    NodeNotFound(i64),
    /// 图引擎不支持的节点类型
    UnsupportedNodeType(String),
    /// 图引擎无匹配的出边
    NoMatchingEdge(i64),
    /// 外部服务调用失败（medserver、cti-server、HTTP）
    ExternalServiceError { service: String, detail: String },
    /// 流程实例超时
    FlowTimeout { instance_id: Uuid },
    /// 流程实例 Redis 持久化失败
    InstanceStoreError(String),
    /// 配置加载失败
    ConfigLoadError(String),
}
```

### 7.2 错误处理策略

| 错误场景 | 处理方式 | 影响范围 |
|---------|---------|---------|
| 租户路由表不存在 | 返回 `NoMatch`，不 panic | 单次请求 |
| 正则编译失败 | 跳过该规则，记录 error 日志，告警 | 该规则不可用 |
| 图引擎节点执行失败 | 走 fallback_target 或 Hangup | 当前流程实例 |
| 外部服务超时（medserver/cti） | 重试 1 次，失败则走默认边或 Hangup | 当前流程实例 |
| 配置加载失败 | 保留旧版本，error 日志 + 告警 | 新配置不生效 |
| Redis 持久化失败 | 重试 1 次，失败则流程标记为 Failed | 流程实例无法恢复 |
| DashMap 操作失败 | 不可能（不会 panic），忽略 | 无 |

### 7.3 统一错误响应格式

router-server 通过 gRPC 返回错误时，status message 遵循统一错误格式（详见 `config-and-gateway-design.md` 14.1 节）：

```json
{
  "error": {
    "code": "ROUTE_NO_MATCH",
    "message": "无匹配的路由规则",
    "details": [
      {
        "field": "callee",
        "message": "号码 12345 未匹配任何路由点或规则"
      }
    ],
    "request_id": "req-uuid-v4"
  }
}
```

**路由引擎错误码**：

| 错误码 | gRPC Status | 说明 |
|--------|-------------|------|
| `ROUTE_NO_MATCH` | OK（携带 NoMatch decision） | 无匹配路由规则 |
| `TENANT_NOT_FOUND` | NOT_FOUND | 租户路由表未加载 |
| `FLOW_NOT_FOUND` | NOT_FOUND | 流程图不存在 |
| `FLOW_TIMEOUT` | DEADLINE_EXCEEDED | 流程实例超时 |
| `EXTERNAL_SERVICE_ERROR` | UNAVAILABLE | 外部服务调用失败 |
| `CONFIG_LOAD_ERROR` | INTERNAL | 配置加载失败 |
| `INTERNAL_ERROR` | INTERNAL | 内部错误 |

---

## 8. 可观测性

### 8.1 Metrics

| 指标名 | 类型 | 标签 | 描述 |
|--------|------|------|------|
| `router_route_requests_total` | Counter | `tenant_id`, `decision`, `layer` (1/2) | 路由请求总数 |
| `router_route_decision_duration_seconds` | Histogram | `tenant_id`, `layer` | 路由决策延迟 |
| `router_rule_matches_total` | Counter | `tenant_id`, `rule_id`, `rule_name` | 各规则命中次数 |
| `router_flow_instances_active` | Gauge | `tenant_id` | 当前活跃的流程实例数 |
| `router_flow_step_duration_seconds` | Histogram | `tenant_id`, `node_type` | 图引擎单步执行延迟 |
| `router_flow_timeouts_total` | Counter | `tenant_id`, `node_type` | 流程超时次数 |
| `router_config_reload_total` | Counter | `tenant_id`, `status` (ok/error) | 配置重载次数 |
| `router_config_table_version` | Gauge | `tenant_id` | 当前路由表版本号 |
| `router_external_call_duration_seconds` | Histogram | `service` (medserver/cti/http) | 外部服务调用延迟 |
| `router_fallback_cache_hits_total` | Counter | `tenant_id` | 降级缓存命中次数 |

### 8.2 Tracing

每个路由请求生成一个 trace span：

```
router.route
  │
  ├─ dial_plan { callee, normalized_callee, matched_plan }
  │
  ├─ route_point_lookup { extension, hit, route_type }
  │
  ├─ rule_match { rule_id, rule_name, matched }
  │
  ├─ [可选] flow_start { flow_id, instance_id }
  │   ├─ flow_step { node_id, node_type, result, duration }
  │   ├─ flow_step { ... }
  │   └─ flow_suspend / flow_complete / flow_fail
  │
  └─ route_decision { decision, target, duration_us }
```

### 8.3 日志

| 级别 | 场景 |
|------|------|
| `INFO` | 服务启动/关闭、配置加载完成、路由表版本变更 |
| `WARN` | 配置加载失败（保留旧版本）、流程超时、降级缓存使用 |
| `ERROR` | 外部服务调用失败、Redis 持久化失败、正则编译失败 |
| `DEBUG` | 每条规则的条件求值细节、图引擎每步执行的变量快照 |

---

## 9. 部署与高可用

### 9.1 部署模型

```
┌─────────────────────────────────────────────────┐
│                   Site A                         │
│                                                  │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ router-1     │  │ router-2     │  ← gRPC     │
│  │ (Primary)    │  │ (Standby)    │    负载均衡   │
│  └──────┬───────┘  └──────┬───────┘             │
│         │                 │                      │
│         └────────┬────────┘                      │
│                  │                               │
│         ┌────────▼────────┐                      │
│         │  Redis Cluster  │  ← 流程实例存储       │
│         │  + Pub/Sub      │    + 配置变更通知      │
│         └─────────────────┘                      │
└─────────────────────────────────────────────────┘
```

### 9.2 无状态设计

路由引擎的第一层（快速路径）是**完全无状态**的：

- 路由表从 config-service 加载，内存中维护快照
- 每次路由请求独立处理，无跨请求状态
- 任意 router 实例可处理任意请求

这意味着第一层可以水平扩展，多个实例通过 gRPC 负载均衡分流。

### 9.3 流程实例的有状态处理

第二层（图引擎）的流程实例是有状态的，但通过 Redis 持久化实现了**实例亲和性解耦**：

- 流程实例存储在 Redis，不绑定特定 router 进程
- 事件到达时，任意 router 实例可从 Redis 加载实例并恢复执行
- 如果 router-1 处理了 PlayPrompt 后挂起，事件回来时 router-2 可以恢复执行

### 9.4 高可用

| 场景 | 处理方式 |
|------|---------|
| 单个 router 实例宕机 | gRPC 负载均衡自动摘除，新请求路由到其他实例 |
| 挂起的流程实例（Redis 中有状态） | 事件到达时任意存活的 router 实例可恢复 |
| Redis 不可用 | 第一层不受影响（内存路由表）；第二层新流程可启动但无法挂起恢复 |
| Config Service 不可用 | 路由引擎使用内存缓存继续服务，不加载新配置 |
| 全量路由引擎不可用 | 消费方降级到本地缓存（仅支持简单路由） |

### 9.5 容量规划

| 指标 | 预估值 | 依据 |
|------|--------|------|
| 单实例第一层 QPS | ~50,000 | 纯内存操作 + HashMap 查找 |
| 单实例第二层并发流程 | ~10,000 | 受 Redis 读写和网络延迟约束 |
| 路由表内存占用（单租户） | ~1-5 MB | 取决于规则数量和流程图复杂度 |
| 配置重载延迟 | <500ms | 防抖窗口 + gRPC 加载 + 编译 |

### 9.6 端口分配与健康检查

router-server 的端口分配遵循统一端口表（详见 `config-and-gateway-design.md` Appendix B）：

| 协议 | 端口 | 说明 |
|------|------|------|
| HTTP | - | 不提供 HTTP 服务 |
| Metrics/Health | 9098 | Prometheus 指标 + 健康检查 |
| gRPC | 50051 | 路由服务接口 |

**健康检查端点**（详见 `config-and-gateway-design.md` Appendix D）：

| 端点 | 用途 | router-server 判断逻辑 |
|------|------|----------------------|
| `GET /health` | 综合健康检查 | Redis 可达 + 至少一个租户路由表已加载 |
| `GET /health/live` | K8s 存活探针 | 进程是否在响应 HTTP |
| `GET /health/ready` | K8s 就绪探针 | Redis 可达 + 配置已加载 |
| `GET /health/startup` | K8s 启动探针 | 初始配置拉取完成 |

---

## 10. 实施阶段

### Phase 1: 核心路由引擎（第一层）

- `RoutingEngine` 核心结构（DashMap + Arc 快照）
- `DialPlan` 号码标准化
- `RoutePoint` 查找
- `RoutingRule` 条件匹配
- gRPC `RouteInteraction` 接口
- `ConfigSyncManager` 启动加载 + Redis Pub/Sub 监听
- 基础 Metrics + Tracing

### Phase 2: 图引擎（第二层）

- `CallFlowGraph` 编译与缓存
- `FlowScheduler` 调度器
- 同步节点：Condition、Transfer、Hangup
- 异步节点：PlayPrompt、CollectDigits（与 medserver 集成）
- 异步节点：Enqueue、SelectAgent（与 CTI 集成）
- `FlowInstanceStore` Redis 持久化
- 事件恢复机制

### Phase 3: 高级特性

- `DataLookup` 节点（外部 API 查询）
- 降级缓存（SIP 信令服务器侧）
- 路由决策审计日志
- 路由表版本管理与回滚
- 多站点路由同步

---

## 附录 A: 术语表

| 术语 | 定义 |
|------|------|
| **Interaction** | 一次交互的抽象，可以是语音呼叫、IM 消息、邮件、回调请求 |
| **Route Point** | 路由接入点，关联一个号码/标识，触发路由决策 |
| **Routing Rule** | 路由规则，条件表达式 + 动作的有序列表 |
| **Dial Plan** | 拨号计划，用于号码标准化（允许/拒绝/转换） |
| **Call Flow** | 呼叫流程，由节点和边组成的图结构，定义复杂的交互编排 |
| **Flow Instance** | 呼叫流程的一次执行实例 |
| **Route Table** | 路由表，编译后的内存数据结构，按租户隔离 |
| **Layer 1** | 第一层快速路径，规则匹配，同步决策 |
| **Layer 2** | 第二层图引擎，复杂编排，异步事件驱动 |

## 附录 B: 与现有设计文档的关系

| 文档 | 关系 |
|------|------|
| `signaling-server-design.md` | sipserver 作为路由引擎的 gRPC 客户端，调用 `RouteInteraction` |
| `config-and-gateway-design.md` | 路由引擎消费 config-service 的数据（route_points、routing_rules 等），通过 Redis Pub/Sub 接收变更通知 |
| `cti-service-design.md` | 图引擎通过 Enqueue/SelectAgent 节点将交互交给 CTI 的 ACD Router |
| `media-server-design.md` | 图引擎通过 PlayPrompt/CollectDigits 节点与 medserver 交互 |
| `im-service-design.md` | IM 服务作为路由引擎的 gRPC 客户端，消息路由复用同一套引擎 |
| `config-and-gateway-design.md` | API 网关不直接调用路由引擎，路由请求由后端服务发起 |

---

## 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-09-09 | 初始版本 |
| 2.0.0 | 2026-09-09 | 跨文档一致性验证。修正：更新附录 B 文档引用（config-service-design → config-and-gateway-design、nextswitch-api-design → config-and-gateway-design）；新增端口分配与健康检查端点（§9.6，引用 config-and-gateway-design Appendix B/D）；新增统一错误响应格式（§7.3，引用 config-and-gateway-design §14.1） |

---

**文档结束**
