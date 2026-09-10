# NextSWITCH 信令服务器设计规格书

## 文档信息

- **Version**: 2.0.0
- **Date**: 2026-09-09
- **Status**: Active
- **Supersedes**: signaling-server-design v1.1.0, signaling-call-flows-security-supplement v1.0.0

---

## 1. 概述

NextSWITCH 是新一代 VoIP 软交换平台，面向呼叫中心场景，支持大规模分布式部署（>50K 分机，>10K 并发呼叫）。

本规格覆盖两个核心信令组件：
- **sipserver**：SIP 代理服务器，处理 SIP 协议信令
- **signalserver**：WebSocket 信令服务器，处理 WebRTC 客户端私有协议接入

### 1.1 设计目标

| 目标 | 指标 |
|------|------|
| 规模 | >50K 分机，>10K 并发呼叫 |
| 协议 | SIP (UDP/TCP/TLS/WSS) + WebSocket 私有协议 |
| 可用性 | 数据库宕机不影响呼叫，CDR 零丢失 |
| 扩展性 | 多实例集群，多站点/多可用区部署 |
| 延迟 | 纯代理呼叫 <10ms 信令延迟 |

### 1.2 系统架构

#### 1.2.1 整体拓扑

```
WebRTC 客户端                SIP 话机
      │                        │
      │  WS 私有协议            │  SIP
      ▼                        ▼
┌──────────┐            ┌──────────┐
│ signalserver│            │ sipserver│
└────┬─────┘            └────┬─────┘
     │                       │
     └───────────┬───────────┘
                 │
          ┌──────┴──────┐
          │    Redis    │  共享注册表 + Pub/Sub
          └──────┬──────┘
                 │
          ┌──────┴──────┐
          │   config    │  共享配置
          └──────┬──────┘
                 │
          ┌──────┴──────┐
          │  medserver  │  媒体桥接
          └──────┬──────┘
                 │
          ┌──────┴──────┐
          │router-server│  复杂路由（呼叫流程、IVR、ACD）
          └─────────────┘
```

#### 1.2.2 架构选型

**方案 A：单进程多线程 + Redis（已选定）**

每个 sipserver/signalserver 实例是一个 Tokio 多线程进程，所有实例共享 Redis 集群用于注册表和呼叫状态。

理由：
- 简单可靠，Redis 注册表是业界验证方案
- rsipstack 已支持所有传输协议
- 运维成本低，可平滑演进到分层架构

#### 1.2.3 路由职责划分

sipserver 的路由职责分为两级：

| 层级 | 执行者 | 范围 | 说明 |
|------|--------|------|------|
| 快速路径（Fast Path） | sipserver 本地 | 基本拨号计划查询 | 分机直拨匹配、简单模式匹配，本地缓存 ~50K QPS |
| 复杂路径（Complex Path） | router-server (gRPC) | 呼叫流程编排 | IVR 导航、ACD 排队、复杂呼叫流程、时间条件路由 |

sipserver 本地维护简化的路由规则匹配器（`RouteRule`），仅用于快速路径场景（分机直拨、简单号码模式匹配）。复杂的路由决策（涉及 IVR、ACD 队列分配、呼叫流程编排）通过 gRPC 委托给 router-server（routing-engine）处理。

#### 1.2.4 Workspace Crate 结构

```
crates/
├── nextswitch-core      (共享类型：Call, CallState, Error)
├── nextswitch-sip       (SIP 信令服务器)
├── nextswitch-signal    (WebSocket 信令服务器，WebRTC 接入)
├── nextswitch-media     (媒体处理：rustrtc + audio-codec)
├── nextswitch-cti       (CTI 服务：坐席状态、ACD、呼叫控制)
├── nextswitch-im        (IM 服务：多渠道消息、会话管理、AI 集成)
└── nextswitch-api       (REST API 网关)
```

---

## 2. sipserver 设计

### 2.1 模块划分

```
nextswitch-sip (binary)
├── transport    — UDP/TCP/TLS/WSS 监听，复用 rsipstack TransportLayer
├── proxy        — 无状态 SIP 代理核心：路由决策、消息转发
├── registrar    — REGISTER 处理，写入/查询 Redis 注册表
├── dialog       — B2BUA 降级时的会话管理（录音、会议触发）
├── router       — 本地快速路径路由匹配器（分机直拨、简单模式匹配）
├── firewall     — SIP 信令防火墙（消息校验、反注入、拓扑隐藏）
├── security     — SIP 认证、防伪造注册、Toll Fraud 检测
├── cac          — 呼叫准入控制（多层并发限制、CPS 限流）
├── cluster      — Redis 客户端封装、注册表读写、健康检查、Pub/Sub
├── config       — 本地配置缓存、订阅 config 服务事件
├── metrics      — Prometheus 指标采集（业务/基础设施/运行时指标）
├── health       — HTTP 健康检查端点（liveness/readiness/startup）
└── tracing      — OpenTelemetry 追踪上下文传播、span 管理
```

### 2.2 SIP 消息处理管线

```
入站消息
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Transport 层                                                     │
│  rsipstack 接收，解析为 SIP 消息                                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Pre-Route 管线                                                   │
│  ├─ SIP 信令防火墙（消息格式校验、大小限制、方法白名单）                 │
│  ├─ 速率限制（per-IP INVITE CPS）                                  │
│  ├─ 呼叫准入控制（系统/租户/分机级并发限制）                           │
│  └─ 头部规范化（标准化 Request-URI、From、To）                       │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Method Router — 按方法分发                                        │
│  ├─ REGISTER → security 模块（认证校验）→ registrar 模块             │
│  ├─ INVITE/BYE/ACK → proxy 模块                                   │
│  ├─ OPTIONS → 直接回复 200（心跳）                                  │
│  └─ 其他 → 405 Method Not Allowed                                 │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Proxy / Registrar                                                │
│  ├─ 查询本地路由规则（快速路径匹配器，本地缓存）                       │
│  ├─ 如需要复杂路由 → gRPC 调用 router-server                        │
│  ├─ 查询注册表（Redis）定位被叫                                     │
│  ├─ 判断是否需要 B2BUA 降级                                        │
│  └─ 转发或降级处理                                                 │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Post-Route                                                       │
│  ├─ 添加 Via/Record-Route、修改 TTL                                │
│  ├─ 拓扑隐藏（出站消息移除内部信息）                                  │
│  └─ 日志记录                                                      │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
                        出站转发
```

### 2.3 Redis 注册表

**Redis 数据结构**：
```
# 注册表（Hash）
reg:sip:1001@domain → {
  "contact": "sip:1001@192.168.1.100:5060",
  "expires": 1699999999,
  "instance_id": "sipserver-03",
  "transport": "udp",
  "call_id": "abc123",
  "cseq": 1
}

# 实例心跳（String + TTL）
heartbeat:sipserver:sipserver-03 → "alive"  # TTL 30s，每 10s 刷新
# 格式：heartbeat:{service}:{instance_id}
```

**查询流程**：
1. 查本地 LRU 缓存（命中率高时避免 Redis 往返）
2. 缓存未命中 → Redis HGET reg:<aor>
3. 检查 expires 是否过期（惰性清理）
4. 检查 instance_id 对应实例是否存活（heartbeat key）
5. 转发到目标实例或直接转发到 contact 地址

### 2.4 呼叫路由与代理

**路由职责分层**：

sipserver 内部的路由匹配器（`router` 模块）是一个简化的快速路径匹配器，专为 ~50K QPS 的低延迟查询设计。它仅处理基本的分机直拨匹配和简单的号码模式匹配。复杂路由逻辑（呼叫流程编排、IVR、ACD 排队）委托给 router-server。

**纯 Proxy 路径（默认）**：
1. 解析 Request-URI，提取被叫号码/域名
2. 查询本地路由规则（快速路径匹配器，本地缓存）
3. 判断是否需要 B2BUA 降级
4. 查注册表定位被叫
5. 转发 INVITE 到被叫 contact

**本地路由规则示例**（快速路径）：
```json
{ "pattern": "^1001$", "action": "direct", "flags": {} }
{ "pattern": "^(\\d{11})$", "action": "trunk", "trunk_group": "pstn-primary", "flags": { "record": true } }
```

**复杂路由委托**（通过 gRPC 调用 router-server）：
- 呼叫流程编排（call_flow_id 绑定）
- IVR 导航
- ACD 队列分配
- 时间条件路由

> **设计说明**：本地 `RouteRule` 是简化的快速路径匹配器，不是完整的路由引擎。完整的路由引擎位于 router-server（routing-engine-design），sipserver 通过 gRPC 与其交互。

### 2.5 B2BUA 降级策略

**降级触发条件**：
- `record: true` → 通话录音
- `conference: true` → 会议桥
- `ivr: true` → IVR 导航
- `transcode: true` → 协议转换（SIP↔WebRTC）

**处理流程**：
1. sipserver 作为 B2BUA 终结主叫侧会话（Leg A）
2. 请求 medserver 建立媒体桥（内部 gRPC）
3. medserver 返回媒体端点
4. sipserver 向被叫发起新 INVITE（Leg B），SDP 指向 medserver
5. 通话结束后通知 medserver 销毁媒体会话

**medserver 交互协议**：
```rust
trait MediaServer {
    async fn create_session(&self, req: CreateSessionRequest) -> Result<CreateSessionResponse>;
    async fn destroy_session(&self, session_id: &str) -> Result<()>;
    async fn update_session(&self, req: UpdateSessionRequest) -> Result<()>;
}
```

---

## 3. signalserver 设计

### 3.1 模块划分

```
nextswitch-signal (binary)
├── ws           — WebSocket 传输层，连接管理，心跳检测
├── protocol     — 私有协议解析/序列化（JSON-RPC 2.0）
├── auth         — JWT/API Key 认证，分机鉴权
├── session      — 客户端会话管理（在线状态、关联的呼叫）
├── call         — WebRTC 呼叫控制（invite/answer/bye 状态机）
├── media        — WebRTC 媒体协商（SDP offer/answer、ICE candidate 交换）
├── cluster      — Redis 客户端封装（与 sipserver 共享注册表）
├── config       — 本地配置缓存（与 sipserver 共享 config 事件）
├── cdr          — 话单生成 + WAL 缓冲
├── metrics      — Prometheus 指标采集（WebSocket 连接、消息吞吐、心跳超时）
├── health       — HTTP 健康检查端点（liveness/readiness/startup）
└── tracing      — OpenTelemetry 追踪上下文传播、span 管理
```

### 3.2 内部管线

```
WebSocket 消息入站
  │
  ▼
┌──────────────┐
│  ws 模块     │  连接管理、帧解析、心跳、二进制/文本分发
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  protocol    │  JSON-RPC 解析、method 路由、参数校验
│  模块        │  ├─ register → auth 模块
│              │  ├─ invite   → call 模块
│              │  ├─ answer   → call 模块
│              │  ├─ bye      → call 模块
│              │  ├─ dtmf     → call 模块
│              │  ├─ ice_candidate → media 模块
│              │  └─ ping/pong → ws 模块
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  call 模块   │  呼叫状态机（Idle → Trying → Ringing → Answered → Terminated）
│              │  与 sipserver 通过 Redis 共享呼叫状态
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  media 模块  │  PeerConnection 管理、SDP 协商、ICE 交换
│  (rustrtc)   │  媒体流通过 medserver 桥接到 SIP 侧
└──────────────┘
```

### 3.3 与 sipserver 协作

**WebRTC 客户端 (1001) 呼叫 SIP 话机 (1002)**：
1. 1001 通过 WS 发送 invite → signalserver
2. signalserver 查询 Redis 注册表，发现 1002 注册在 sipserver-02
3. signalserver 通过 Redis Pub/Sub（`call:command:{sipserver-02}`）通知 sipserver-02
4. sipserver-02 向 1002 发起 SIP INVITE
5. 1002 应答 → sipserver-02 通过 Redis Pub/Sub（`call:event:{signalserver-id}`）通知 signalserver
6. signalserver 向 1001 推送 call_progress (answered) + SDP answer
7. 媒体流：1001 ↔ medserver（WebRTC） ↔ medserver（RTP） ↔ 1002

---

## 4. WebSocket 协议规范

### 4.1 JSON-RPC 2.0 消息格式

**协议**：JSON-RPC 2.0 over WebSocket

**Request（客户端 → 服务端）**：
```json
{ "jsonrpc": "2.0", "method": "<method>", "params": { ... }, "id": <id> }
```

**Response（服务端 → 客户端）**：
```json
{ "jsonrpc": "2.0", "result": { ... }, "id": <id> }
```

**Notification（服务端推送）**：
```json
{ "jsonrpc": "2.0", "method": "<event>", "params": { ... } }
```

### 4.2 端点注册

**端点**：`wss://<signalserver-host>:8443/ws`

**认证**：URL 参数传递 JWT Token
```
wss://signalserver.example.com/ws?token=<jwt_token>
```

此认证模式适用于信令 WebSocket（SIP 端机注册场景），在连接建立时即完成认证。

> **注意**：CTI/IM WebSocket 使用不同的认证模式——连接后通过 JSON-RPC `auth` 方法进行认证。详见 `platform-security-design` 文档。

### 4.3 信令消息

| 方法 | 方向 | 说明 |
|------|------|------|
| `register` | C→S | 注册分机 |
| `invite` | C→S | 发起呼叫 |
| `answer` | C→S | 应答来电 |
| `bye` | C→S | 挂断 |
| `dtmf` | C→S | 按键事件 |
| `ice_candidate` | 双向 | ICE 候选交换 |
| `ping`/`pong` | 双向 | 心跳保活 |
| `incoming_call` | S→C | 来电通知 |
| `call_progress` | S→C | 呼叫进展（ringing/answered） |
| `call_ended` | S→C | 通话结束 |

**错误码**：

| 错误码 | 含义 |
|--------|------|
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found（被叫不存在） |
| 408 | Request Timeout |
| 480 | Temporarily Unavailable |
| 486 | Busy Here |
| 500 | Internal Error |
| 503 | Service Unavailable |

### 4.4 WebSocket 认证

信令 WebSocket 使用 JWT via URL query parameter `?token=<jwt>` 进行认证。该模式适用于 SIP 端机注册场景——客户端在 WebSocket 握手阶段即完成身份验证。

> **跨服务说明**：CTI 和 IM 的 WebSocket 使用 JSON-RPC post-connect 认证（连接建立后通过 `auth` 方法传递凭证）。这是不同的认证模式，详见 `platform-security-design` 文档。

---

## 5. 呼叫流程

### 5.1 入站呼叫流程

```
外部 PSTN / SIP Trunk 来电
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  ① 入站预处理（Pre-Route）                                       │
│  ├─ IP 白名单校验（trunk 来源 IP 匹配）                            │
│  ├─ SIP 消息深度校验（格式、大小、方法合法性）                       │
│  ├─ 速率限制（per-IP INVITE CPS）                                │
│  └─ 头部规范化（标准化 Request-URI、From、To）                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ② 中继识别（Trunk Identification）                               │
│  ├─ 根据来源 IP + 端口匹配 trunks 表                               │
│  ├─ 匹配失败 → 检查默认中继（default_trunk 配置）                   │
│  └─ 仍失败 → 403 Forbidden + 告警                                 │
│  输出：trunk_id, tenant_id                                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ③ DID 匹配（Number Matching）                                    │
│  ├─ 提取 Request-URI 中的被叫号码（DNIS）                          │
│  ├─ 查询 dids 表：WHERE tenant_id = ? AND phone_number = ?       │
│  ├─ 匹配成功 → 获取 call_flow_id 或 trunk_id                      │
│  ├─ 匹配失败 → 尝试号码规范化后重试（去前缀、补位等）                │
│  └─ 仍失败 → 404 Not Found（Number Not Found）                    │
│  输出：did_id, call_flow_id（可能为 NULL）                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ④ 路由决策                                                      │
│                                                                  │
│  快速路径（sipserver 本地匹配）：                                    │
│  ├─ DID 直接绑定分机 → 直接路由到目标分机                            │
│  ├─ 简单模式匹配命中 → 按 action 执行                               │
│  └─ 无本地匹配 → 进入复杂路径                                      │
│                                                                  │
│  复杂路径（委托 router-server via gRPC）：                           │
│  ├─ DID 绑定了 call_flow_id → router-server 执行呼叫流程编排        │
│  ├─ 时间条件路由 → router-server 评估时间条件                       │
│  ├─ IVR 流程 → router-server 返回 IVR 指令                         │
│  ├─ ACD 排队 → router-server 执行队列分配策略                       │
│  └─ 无匹配 → 播放"号码不存在"提示 → 挂断                            │
│                                                                  │
│  输出：route_action（extension / queue / ivr / call_flow / trunk）│
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐  ┌──────────┐
         │ 分机   │  │ 队列   │  │ IVR 流程  │
         │ 直连   │  │ 排队   │  │ 导航      │
         └────────┘  └────────┘  └──────────┘
```

#### 5.1.1 路由规则匹配（本地快速路径）

sipserver 本地路由匹配器按优先级从高到低逐条匹配，首条命中即执行。

**数据模型**：

```rust
/// 简化的本地快速路径路由规则（非完整路由引擎）
/// 复杂路由通过 gRPC 委托给 router-server
struct RouteRule {
    id: i64,
    tenant_id: i64,
    priority: i32,                          // 越高越优先
    conditions: RouteConditions,            // 匹配条件（全部 AND）
    action: RouteAction,                    // 路由动作
    fallback_action: Option<RouteAction>,   // 动作失败时的备选
    time_condition_id: Option<i64>,         // 时间条件（NULL = 始终生效）
    status: RouteStatus,                    // active / inactive
}

struct RouteConditions {
    caller_pattern: Option<String>,         // 主叫号码正则（如 "^13900139000$"）
    callee_pattern: Option<String>,         // 被叫号码正则
    did_id: Option<i64>,                    // 指定 DID
    trunk_id: Option<i64>,                  // 指定中继
}

enum RouteAction {
    Extension { extension_id: i64 },
    Trunk { trunk_id: i64 },
    External { phone_number: String, trunk_id: i64 },
    DelegateToRouter { reason: String },    // 委托给 router-server
}
```

> **注意**：本地 `RouteAction` 仅包含可直接在 sipserver 内执行的简单动作（分机直拨、中继路由）。复杂动作（Queue、Ivrs、CallFlow）由 router-server 处理，sipserver 通过 `DelegateToRouter` 变体将请求转发。

**匹配流程**：

```
输入：(tenant_id, caller, callee, did_id, trunk_id, current_time)
  │
  ├─ ① 加载该 tenant 的所有 active 规则（本地缓存）
  │
  ├─ ② 按 priority DESC 排序
  │
  ├─ ③ 逐条评估：
  │     ├─ 检查 time_condition（如有）→ 不在时间范围内则跳过
  │     ├─ 检查 caller_pattern → 不匹配则跳过
  │     ├─ 检查 callee_pattern → 不匹配则跳过
  │     ├─ 检查 did_id → 不匹配则跳过
  │     └─ 全部通过 → 命中，执行 action
  │
  ├─ ④ 执行 action
  │     ├─ 简单动作（Extension/Trunk）→ 本地执行
  │     ├─ DelegateToRouter → gRPC 调用 router-server
  │     ├─ 成功 → 结束
  │     └─ 失败（如分机未注册）→ 执行 fallback_action
  │           └─ fallback 也失败 → 播放提示音后挂断
  │
  └─ ⑤ 无规则命中 → gRPC 调用 router-server 尝试复杂路由
        └─ router-server 也无匹配 → 播放"号码不存在"提示 → 挂断
```

**路由规则示例**：

```json
// 规则 1：VIP 客户来电直接转经理（最高优先级）
{
  "priority": 100,
  "conditions": { "caller_pattern": "^13900139000$" },
  "action": { "type": "Extension", "extension_id": 1001 },
  "time_condition_id": null
}

// 规则 2：特定 DID → 委托给 router-server 进行呼叫流程编排
{
  "priority": 50,
  "conditions": { "did_id": 10 },
  "action": { "type": "DelegateToRouter", "reason": "call_flow" },
  "time_condition_id": 1,
  "fallback_action": { "type": "DelegateToRouter", "reason": "after_hours_flow" }
}
```

#### 5.1.2 IVR 执行引擎（router-server 返回后在 sipserver B2BUA 模式执行）

IVR 引擎在 sipserver 中以 B2BUA 模式运行（需要媒体交互时降级到 medserver）。

**节点执行流程**：

```
来电进入 IVR
  │
  ▼
┌──────────────┐
│  answer 节点  │  接听来电，建立媒体通道
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ play_prompt  │  播放提示音（通过 medserver 播放 RTP）
│              │  支持 interruptible（按键打断）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ collect_     │  收集用户按键（DTMF）
│ digits       │  ├─ 超时未输入 → 走 timeout 分支
│              │  └─ 收到按键 → 匹配 edges
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ match_digits │  按键匹配
│              │  ├─ 匹配成功 → 沿对应 edge 到下一节点
│              │  └─ 匹配失败 → 重播提示（最多 3 次）→ 走 default 分支
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ transfer     │  转接到目标
│              │  ├─ target_type=extension → 直接呼叫分机
│              │  ├─ target_type=queue → 进入队列
│              │  └─ target_type=external → 通过中继呼出
└──────────────┘
```

**IVR 与 medserver 交互**：

```
sipserver (B2BUA)                    medserver
    │                                    │
    │  create_session(iv_play)           │
    │ ──────────────────────────────────►│
    │  { media_endpoint: rtp://... }     │
    │ ◄──────────────────────────────────│
    │                                    │
    │  RTP 媒体流 ──────────────────────►│  (播放提示音)
    │                                    │
    │  DTMF 事件 (RFC 2833) ◄───────────│  (透传按键)
    │                                    │
    │  destroy_session                   │
    │ ──────────────────────────────────►│  (IVR 结束，转接后释放)
```

**IVR 超时与异常处理**：

| 场景 | 处理 |
|------|------|
| 用户无按键输入（超时） | 走 timeout edge 或重播提示（最多 3 次） |
| 用户输入无效按键 | 播放"输入无效"提示，重新收集 |
| IVR 流程配置错误（无出口边） | 播放"系统繁忙"提示 → 挂断 |
| medserver 不可用 | 降级：跳过 IVR，走默认路由（fallback_action） |
| 用户在 IVR 中挂断 | 清理 medserver 会话 → 结束 |

#### 5.1.3 队列/ACD 集成

来电路由到队列后的处理流程（ACD 决策由 router-server 通过 gRPC 协调 cti-server 完成）。

**排队流程**：

```
来电进入队列
  │
  ├─ ① 播放队列提示音（announcement）→ 通过 medserver
  │
  ├─ ② 检查队列状态
  │     ├─ 有可用坐席 → 立即分配（ACD 策略）
  │     └─ 无可用坐席 → 进入排队等待
  │           ├─ 播放等待音乐（MOH）
  │           ├─ 定期播报排队位置
  │           ├─ 检查 max_wait_time → 超时走 overflow 分支
  │           └─ 检查 max_queue_size → 队列满走 busy 分支
  │
  ├─ ③ ACD 分配策略
  │     ├─ fifo → 按等待时间排序
  │     ├─ round_robin → 轮询分配
  │     ├─ least_recent → 最久未分配坐席优先
  │     ├─ fewest_calls → 当日接听最少的坐席优先
  │     └─ skill_based → 按技能匹配度 + 熟练度排序
  │
  ├─ ④ 坐席振铃
  │     ├─ 通过 Redis Pub/Sub 通知 signalserver/sipserver
  │     ├─ 坐席在 call_timeout 内应答 → 通话建立
  │     └─ 超时 → 尝试下一个坐席
  │
  └─ ⑤ 所有坐席尝试完毕
        └─ 走 fallback（留言 / 转其他队列 / 回拨）
```

**队列与 CTI 交互**：

```
sipserver                              cti-server
    │                                      │
    │  queue_call_arrived                  │
    │  { queue_id, caller, priority }      │
    │ ────────────────────────────────────►│  (via Redis Pub/Sub)
    │                                      │
    │  assign_agent                        │
    │ ◄────────────────────────────────────│  (ACD 决策结果)
    │  { agent_id, extension }             │
    │                                      │
    │  call_answered / call_timeout        │
    │ ────────────────────────────────────►│  (更新坐席状态)
```

**队列溢出处理**：

| 条件 | 溢出动作 |
|------|---------|
| `max_wait_time` 超时 | 转备用队列 / 播放提示后挂断 / 触发回拨 |
| `max_queue_size` 队列满 | 播放"队列已满"提示 → 转备用队列或挂断 |
| 所有坐席不可用 | 走 `fallback_target`（route_points.fallback_target） |
| 等待中超时（caller 挂断） | 从队列移除，写入 CDR（direction=inbound, queue_id） |

### 5.2 内部扩展呼叫

#### 5.2.1 SIP → SIP（同实例）

```
分机 1001 (SIP)                    sipserver-01                    分机 1002 (SIP)
    │                                  │                                  │
    │  INVITE (to: 1002)               │                                  │
    │ ────────────────────────────────►│                                  │
    │                                  │  查注册表: 1002 → sipserver-01   │
    │                                  │  (本地命中，无需跨实例)            │
    │                                  │                                  │
    │                                  │  INVITE (to: 1002)              │
    │                                  │ ────────────────────────────────►│
    │                                  │                                  │
    │  180 Ringing                     │  180 Ringing                     │
    │ ◄────────────────────────────────│ ◄────────────────────────────────│
    │                                  │                                  │
    │  200 OK                          │  200 OK                          │
    │ ◄────────────────────────────────│ ◄────────────────────────────────│
    │                                  │                                  │
    │  ACK ──────────────────────────────────────────────────────────────►│
    │                                  │                                  │
    │  ◄═══════════════ RTP 媒体直连（P2P）══════════════════════════════►│
```

#### 5.2.2 SIP → SIP（跨实例）

```
分机 1001 (SIP)                    sipserver-01         Redis          sipserver-02         分机 1002 (SIP)
    │                                  │                  │                 │                    │
    │  INVITE (to: 1002)               │                  │                 │                    │
    │ ────────────────────────────────►│                  │                 │                    │
    │                                  │  查本地缓存 miss │                 │                    │
    │                                  │ ────────────────►│                 │                    │
    │                                  │  1002 → server-02│                 │                    │
    │                                  │ ◄────────────────│                 │                    │
    │                                  │                  │                 │                    │
    │                                  │  call:command:   │                 │                    │
    │                                  │  sipserver-02    │                 │                    │
    │                                  │  (Redis Pub-Sub) │                 │                    │
    │                                  │ ─────────────────────────────────►│                    │
    │                                  │                  │                 │  INVITE            │
    │                                  │                  │                 │ ──────────────────►│
    │                                  │                  │                 │                    │
    │  180 Ringing ◄──────────────────│◄──────────────────────────────────│◄───────────────────│
    │                                  │  call:event:     │                 │                    │
    │                                  │  sipserver-01    │                 │                    │
    │  200 OK ◄───────────────────────│◄──────────────────────────────────│◄───────────────────│
    │                                  │                  │                 │                    │
    │  ◄═══════════════════ RTP 媒体通过 medserver 中继 ═════════════════════════════════════►│
```

> **媒体路径说明**：跨实例呼叫时，两端不在同一网络，媒体通过各自实例的 medserver 中继。同实例且双方支持直连时，sipserver 在 SDP 中交换双方 contact 地址，实现 P2P 媒体。

#### 5.2.3 WebRTC ↔ SIP

```
WebRTC 1001                      signalserver           sipserver             SIP 1002
    │                                  │                    │                    │
    │  invite { callee: "1002" }       │                    │                    │
    │ ────────────────────────────────►│                    │                    │
    │                                  │  查注册表:          │                    │
    │                                  │  1002 在 sipserver │                    │
    │                                  │ ──────────────────►│                    │
    │                                  │                    │  INVITE            │
    │                                  │                    │ ──────────────────►│
    │                                  │                    │                    │
    │                                  │  call_progress     │  200 OK + SDP      │
    │                                  │  { answered, sdp } │ ◄──────────────────│
    │                                  │ ◄──────────────────│                    │
    │  call_progress + SDP answer      │                    │                    │
    │ ◄───────────────────────────────│                    │                    │
    │                                  │                    │                    │
    │  ◄══ WebRTC ══► medserver ◄══ RTP/SIP ══► 1002       │                    │
```

> WebRTC 侧始终通过 medserver 桥接（WebRTC 无法与 SIP 端直连 RTP）。

#### 5.2.4 WebRTC ↔ WebRTC

```
WebRTC 1001                      signalserver           signalserver           WebRTC 1002
    │                                  │                    │                    │
    │  invite { callee: "1002" }       │                    │                    │
    │ ────────────────────────────────►│                    │                    │
    │                                  │  查注册表:          │                    │
    │                                  │  1002 在 sig-02    │                    │
    │                                  │ ──────────────────►│                    │
    │                                  │  incoming_call     │                    │
    │                                  │ ──────────────────►│                    │
    │                                  │                    │  call_progress     │
    │                                  │                    │  { ringing }       │
    │                                  │ ◄──────────────────│                    │
    │  call_progress { ringing }       │                    │                    │
    │ ◄───────────────────────────────│                    │                    │
    │                                  │                    │                    │
    │                                  │  call_progress     │                    │
    │                                  │  { answered, sdp } │                    │
    │                                  │ ◄──────────────────│                    │
    │  call_progress + SDP answer      │                    │                    │
    │ ◄───────────────────────────────│                    │                    │
    │                                  │                    │                    │
    │  ◄══ WebRTC ══► medserver-01 ◄══ WebRTC ══► medserver-02 ◄══ WebRTC ══► 1002
```

> 两端均为 WebRTC 时，通过各自 signalserver 的 medserver 桥接。如果两端在同一 signalserver 实例，可优化为单 medserver 桥接。

#### 5.2.5 呼叫特性

##### 呼叫等待（Call Waiting）

```
分机 1002 正在与 1001 通话
  │
  │  分机 1003 呼叫 1002
  │
  ▼
sipserver 检查 1002 的 call_waiting 设置
  ├─ 未启用 → 返回 486 Busy Here
  └─ 已启用 →
      ├─ 向 1002 发送呼叫等待提示音（RTP 注入，通过 medserver）
      ├─ 向 1002 发送 incoming_call 通知（显示 1003 来电）
      │
      ├─ 1002 按 flash/hold → 切换到 1003 通话
      ├─ 1002 按 flash/hold → 切换回 1001 通话
      └─ 1002 忽略 → 1003 振铃超时 → 走 1002 的无应答前转逻辑
```

**数据模型扩展**（extensions.settings）：

```json
{
  "call_waiting": true,
  "max_call_waiting_slots": 2
}
```

##### 呼叫转接（Call Transfer）

**盲转（Blind Transfer）**：

```
1001 与 1002 通话中，1002 要转给 1003
  │
  │  1002 发送 REFER (Refer-To: 1003)
  │
  ▼
sipserver 收到 REFER
  ├─ 向 1002 返回 202 Accepted
  ├─ 向 1003 发起 INVITE（主叫保持为原始主叫 1001）
  ├─ 1003 应答 → 1001 与 1003 建立通话
  └─ 1002 自动挂断（BYE）
```

**协商转（Attended Transfer）**：

```
1001 与 1002 通话中，1002 要先和 1003 协商
  │
  │  ① 1002 按 hold → 保持 1001（medserver 播放 MOH）
  │  ② 1002 拨打 1003 → 与 1003 建立第二路通话
  │  ③ 1002 与 1003 协商后，按 transfer
  │
  ▼
sipserver 处理转接
  ├─ 将 1001 的媒体桥接到 1003
  ├─ 1002 退出通话（BYE 两路）
  └─ 1001 与 1003 直接通话
```

> 协商转需要 sipserver 维护一个 **transfer session**，关联两路呼叫的 Call-ID。

**转接权限控制**：

| 配置项 | 说明 |
|--------|------|
| `extensions.settings.allow_blind_transfer` | 是否允许盲转（默认 true） |
| `extensions.settings.allow_attended_transfer` | 是否允许协商转（默认 true） |
| `extensions.settings.transfer_allowed_targets` | 转接目标限制（如仅允许同租户分机） |

##### 呼叫代答（Call Pickup）

```
分机 1003 呼叫 1001，1001 振铃中
  │
  │  分机 1002 拨打 *8（代答码）或指定代答组
  │
  ▼
sipserver 处理代答
  ├─ 查询 1001 的活跃呼叫（来自 1003 的 INVITE）
  ├─ 检查代答权限（pickup_group 匹配）
  ├─ 向 1003 发送 200 OK（媒体指向 1002）
  ├─ 向 1002 发送 200 OK（媒体指向 1003）
  └─ 1001 停止振铃，1002 与 1003 通话建立
```

**代拾取组数据模型**（extensions.settings）：

```json
{
  "pickup_groups": [100, 200],
  "pickup_code": "*8",
  "directed_pickup_code": "*8"
}
```

**代答类型**：

| 类型 | 触发方式 | 说明 |
|------|---------|------|
| 组拾取 | 拨打 `*8` | 代答本组内任意振铃呼叫 |
| 定向拾取 | 拨打 `*8*1001` | 指定代答呼叫 1001 的那路振铃 |

##### 呼叫拦截（Call Intercept）

```
管理员或班长席拦截正在振铃/通话中的呼叫
  │
  │  通过 CTI 接口或拨打拦截码
  │
  ▼
sipserver 处理拦截
  ├─ 验证拦截权限（需要 supervisor 角色）
  ├─ 终结当前通话（向双方发送 BYE）
  ├─ 将主叫接到拦截者
  └─ 写入 operation_logs（action=intercept）
```

##### 呼叫驻留（Call Park）

```
1001 与 1002 通话中，1002 要驻留呼叫
  │
  │  1002 拨打驻留码（如 *68）
  │
  ▼
sipserver 处理驻留
  ├─ 分配驻留槽位（parking_slot: 1~20）
  ├─ 将 1001 的媒体桥接到 medserver（播放 MOH）
  ├─ 向 1002 播报驻留槽位号（"您的呼叫已驻留在 5 号"）
  ├─ 1002 挂断
  │
  │  任意分机拨打提取码 + 槽位号（如 *685）
  │
  ▼
sipserver 处理提取
  ├─ 验证槽位有效性
  ├─ 将 1001 的媒体桥接到提取者
  └─ 通话恢复
```

**驻留槽位数据模型**（Redis）：

```
park:slot:{tenant_id}:5 → {
  "call_id": "abc123",
  "parked_by": "1002",
  "parked_at": 1699999999,
  "caller_aor": "1001",
  "timeout_secs": 300
}
```

**驻留超时**：超过 `timeout_secs` 后，呼叫自动转接到预设的超时目标（如总机或语音信箱）。

##### 多方通话 / 会议

**临时会议（Ad-hoc Conference）**：

```
1001 与 1002 通话中，1001 要拉 1003 入会
  │
  │  ① 1001 保持 1002（medserver 播放 MOH）
  │  ② 1001 拨打 1003 → 建立第二路通话
  │  ③ 1001 拨打会议码 *23（merge）
  │
  ▼
sipserver 处理合并
  ├─ 请求 medserver 创建会议桥（conf_id）
  ├─ 将 1001、1002、1003 的媒体全部桥接到会议桥
  ├─ 向三方发送会议通知（conference_info）
  └─ 任一方挂断 → 其余方继续会议
```

**medserver 会议桥接口**：

```rust
trait ConferenceBridge {
    async fn create_bridge(&self, conf_id: &str) -> Result<ConferenceBridgeInfo>;
    async fn add_participant(&self, conf_id: &str, participant: ParticipantInfo) -> Result<()>;
    async fn remove_participant(&self, conf_id: &str, participant_id: &str) -> Result<()>;
    async fn destroy_bridge(&self, conf_id: &str) -> Result<()>;
}

struct ConferenceBridgeInfo {
    conf_id: String,
    media_endpoint: String,     // RTP 端点地址
    max_participants: u32,      // 默认 8
}
```

**预约会议**：

```json
{
  "conference_id": "conf-20260909-001",
  "tenant_id": 1,
  "name": "周例会",
  "scheduled_start": "2026-09-10T14:00:00Z",
  "scheduled_end": "2026-09-10T15:00:00Z",
  "pin_code": "1234",
  "max_participants": 20,
  "participants": [
    { "extension": "1001", "role": "moderator" },
    { "extension": "1002", "role": "participant" },
    { "extension": "1003", "role": "participant" }
  ],
  "settings": {
    "mute_on_entry": true,
    "play_entry_tone": true,
    "record": true
  }
}
```

预约会议在 sipserver 启动时通过定时器触发：到达 `scheduled_start` 时自动创建会议桥，并向参与者发送呼叫邀请。

**会议控制**：

| 控制动作 | 触发方式 | 说明 |
|---------|---------|------|
| 静音/解除静音 | 主持人按 `*1` | 仅主持人可操作其他参与者 |
| 踢出参与者 | 主持人按 `*3` + 参与者编号 | 被踢出者收到挂断 |
| 锁定会议 | 主持人按 `*5` | 锁定后新参与者无法加入 |
| 录音开始/停止 | 主持人按 `*7` | 需要 B2BUA 降级到 medserver |
| 查看参与者 | 主持人按 `*9` | 播放参与者列表（TTS 或提示音） |

#### 5.2.6 分机级功能

##### 呼叫前转（Call Forwarding）

```json
{
  "unconditional": {
    "enabled": false,
    "target": "1003"
  },
  "busy": {
    "enabled": true,
    "target": "1003"
  },
  "no_answer": {
    "enabled": true,
    "target": "voicemail",
    "timeout_secs": 20
  }
}
```

**前转优先级**：无条件 > 忙 > 无应答。无条件前转时，分机不振铃直接转发。

**前转链防环**：

```rust
struct ForwardChain {
    visited: Vec<String>,       // 已经过的分机号列表
    max_depth: usize,           // 默认 5
}

impl ForwardChain {
    fn check_and_add(&mut self, extension: &str) -> Result<()> {
        if self.visited.contains(&extension.to_string()) {
            return Err(Error::ForwardLoop);
        }
        if self.visited.len() >= self.max_depth {
            return Err(Error::ForwardTooDeep);
        }
        self.visited.push(extension.to_string());
        Ok(())
    }
}
```

##### 免打扰（DND）

```json
{
  "dnd": false,
  "dnd_forward_target": "voicemail"
}
```

DND 启用时，sipserver 对该分机的 INVITE 直接返回 480 Temporarily Unavailable（或按配置前转到语音信箱）。

### 5.3 出站呼叫流程

```
分机发起外呼（拨打外线号码）
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  ① 号码分析（Number Analysis）                                    │
│  ├─ 提取被叫号码（去除外线前缀，如拨 9+号码时去掉 9）               │
│  ├─ 号码规范化（补国际区号、去前导零等）                            │
│  └─ 号码分类：本地 / 国内长途 / 国际 / 特服号（110/119/120 等）     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ② 外呼权限校验（Outbound Permission Check）                      │
│  ├─ 检查分机/坐席的外呼类别权限（见第 6.3 节）                      │
│  ├─ 检查时段限制                                                    │
│  ├─ 检查并发呼叫数限制                                              │
│  └─ 校验失败 → 播放拒绝提示音 → 挂断                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ③ 中继选择（Trunk Selection）                                    │
│  ├─ 按号码分类筛选可用中继（如国际呼叫只走国际中继）                  │
│  ├─ 按选择策略排序（优先级/轮询/最少使用）                           │
│  ├─ 检查中继并发通道余量                                           │
│  └─ 选定目标中继                                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ④ 主叫号码呈现（CLI/ANI）                                        │
│  ├─ 确定外显号码（见第 5.3.1 节）                                  │
│  ├─ 重写 SIP From/PAI 头                                          │
│  └─ 设置 P-Asserted-Identity                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⑤ 发起 SIP INVITE                                                │
│  ├─ 通过选定中继发送 INVITE                                        │
│  ├─ 处理响应                                                       │
│  │   ├─ 100 Trying → 向主叫回 ringing                             │
│  │   ├─ 180 Ringing → 向主叫回 ringing                            │
│  │   ├─ 200 OK → 通话建立                                         │
│  │   ├─ 4xx/5xx/6xx → 失败处理（见第 5.3.3 节）                    │
│  │   └─ 超时（30s）→ 视为失败                                      │
│  └─ 通话结束 → 生成 CDR                                            │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.3.1 主叫号码呈现（CLI/ANI）

**外显号码策略**：

```rust
enum CallerIdPolicy {
    /// 使用中继的注册号码（运营商分配的号码）
    TrunkNumber,
    /// 使用指定的 DID 号码（需在 dids 表中属于该租户）
    FixedDid { phone_number: String },
    /// 使用主叫分机的外显号（extensions 表中配置的 outbound_cid）
    ExtensionCid,
    /// 透传主叫原始号码（不做修改，部分运营商不允许）
    Passthrough,
}
```

**优先级**：分机级配置 > 租户级默认配置

```json
// extensions.settings（分机级）
{
  "outbound_cid": {
    "policy": "fixed_did",
    "phone_number": "02112345678"
  }
}

// tenants.settings（租户级默认）
{
  "default_outbound_cid": {
    "policy": "trunk_number"
  }
}
```

**SIP 头重写规则**：

```rust
fn rewrite_caller_id(invite: &mut SipMessage, cid: &CallerIdConfig, trunk: &Trunk) {
    let display_number = match &cid.policy {
        CallerIdPolicy::TrunkNumber => trunk.caller_id.clone(),
        CallerIdPolicy::FixedDid { phone_number } => phone_number.clone(),
        CallerIdPolicy::ExtensionCid => cid.extension_cid.clone(),
        CallerIdPolicy::Passthrough => invite.from().uri.user.clone(),
    };

    // 重写 From header
    invite.from().uri.user = display_number.clone();

    // 设置 P-Asserted-Identity（运营商通常要求此头）
    invite.set_header("P-Asserted-Identity",
        &format!("<sip:{}@{}>", display_number, trunk.host));

    // 设置 Remote-Party-ID（部分运营商使用此头）
    invite.set_header("Remote-Party-ID",
        &format!("<sip:{}@{}>;screen=yes;party=calling", display_number, trunk.host));
}
```

#### 5.3.2 外呼限制

**外呼类别（Call Class）**：

每个分机/坐席分配外呼类别，决定可以拨打的号码类型：

| 外呼类别 | 可拨号码范围 | 典型分配 |
|---------|------------|---------|
| `internal` | 仅内部分机 | 普通坐席 |
| `local` | 本地号码 + 内部分机 | 普通坐席 |
| `domestic` | 国内号码 + 本地 + 内部 | 高级坐席 |
| `international` | 国际号码 + 国内 + 本地 + 内部 | 经理/主管 |
| `emergency` | 特服号（110/119/120/122） | 所有分机（强制允许） |

**数据模型**（extensions.settings）：

```json
{
  "call_class": "domestic",
  "outbound_restrictions": {
    "allowed_call_classes": ["internal", "local", "domestic"],
    "blocked_patterns": ["0900", "0800"],
    "time_restrictions": {
      "allowed_hours": { "start": "08:00", "end": "20:00" },
      "allowed_days": [1, 2, 3, 4, 5]
    }
  }
}
```

**号码匹配校验**：

```rust
fn check_outbound_permission(
    extension: &Extension,
    destination: &str,
    current_time: &DateTime<Utc>,
) -> Result<(), OutboundDenied> {
    // ① 特服号始终放行
    if is_emergency_number(destination) {
        return Ok(());
    }

    let restrictions = &extension.settings.outbound_restrictions;

    // ② 号码分类匹配
    let dest_class = classify_number(destination);
    if !restrictions.allowed_call_classes.contains(&dest_class) {
        return Err(OutboundDenied::ClassNotAllowed);
    }

    // ③ 黑名单模式匹配
    for pattern in &restrictions.blocked_patterns {
        if destination.starts_with(pattern) {
            return Err(OutboundDenied::PatternBlocked);
        }
    }

    // ④ 时段限制
    if let Some(hours) = &restrictions.time_restrictions.allowed_hours {
        let time = current_time.time();
        if time < hours.start || time > hours.end {
            return Err(OutboundDenied::TimeNotAllowed);
        }
    }

    // ⑤ 星期限制
    if let Some(days) = &restrictions.time_restrictions.allowed_days {
        let weekday = current_time.weekday().number_from_monday();
        if !days.contains(&weekday) {
            return Err(OutboundDenied::DayNotAllowed);
        }
    }

    Ok(())
}
```

**并发通道数限制**：

```
Redis 数据结构：
  outbound:channels:{tenant_id}:{extension_id} → 当前并发数（INCR/DECR）
  outbound:channels:limit:{tenant_id}:{extension_id} → 最大并发数

呼叫建立时：
  INCR outbound:channels:{tenant_id}:{ext_id}
  → 如果结果 > limit → 拒绝呼叫，返回提示音
  → DECR 回退计数

呼叫结束时：
  DECR outbound:channels:{tenant_id}:{ext_id}
```

**限制维度**：

| 维度 | Key 模式 | 说明 |
|------|---------|------|
| 分机级 | `outbound:channels:{tenant_id}:{ext_id}` | 单个分机的最大外呼并发 |
| 租户级 | `outbound:channels:{tenant_id}` | 整个租户的最大外呼并发 |
| 中继级 | `outbound:channels:trunk:{trunk_id}` | 中继的最大并发通道（trunks.max_channels） |

三层限制取最先触发者。

#### 5.3.3 失败处理

**中继选择策略**：

```rust
struct TrunkCandidate {
    trunk_id: i64,
    priority: i32,
    current_channels: u32,
    max_channels: u32,
    status: TrunkStatus,
}

enum TrunkSelectionStrategy {
    /// 按优先级排序，高优先级优先使用
    Priority,
    /// 轮询（每次选择上次使用最久前的中继）
    RoundRobin,
    /// 最少使用（选择当前通道占用率最低的中继）
    LeastUsed,
}
```

**选择流程**：

```rust
impl TrunkSelection {
    fn next_available(&mut self) -> Option<&TrunkCandidate> {
        while self.current_index < self.candidates.len() {
            let candidate = &self.candidates[self.current_index];
            self.current_index += 1;

            if candidate.status != TrunkStatus::Active {
                continue;
            }
            if candidate.current_channels >= candidate.max_channels {
                continue;
            }
            return Some(candidate);
        }
        None
    }
}
```

**快速重拨（Fast Retry）**：

```
INVITE 发送到中继 A
  │
  ├─ 收到 503 Service Unavailable
  │   → 标记中继 A 为暂时不可用（熔断 30s）
  │   → 立即切换到中继 B 重新发起 INVITE
  │   → 对主叫透明（主叫仍在等待振铃）
  │
  ├─ 收到 408 Request Timeout（30s 无响应）
  │   → 标记中继 A 响应超时
  │   → 切换到中继 B 重新发起
  │
  ├─ 收到 404/480/603（被叫不存在/不可达/拒绝）
  │   → 不切换中继（这是被叫侧问题，不是中继问题）
  │   → 直接向主叫返回对应错误
  │
  └─ 所有候选中继均失败
      → 向主叫播放"所有线路繁忙"提示音
      → 挂断
```

**重拨次数限制**：最多尝试 3 个中继（避免无限重试消耗资源）。

**SIP 错误码映射**：

| SIP 响应码 | 含义 | 是否切换中继 | 主叫提示 |
|-----------|------|------------|---------|
| 404 Not Found | 号码不存在 | 否 | "您拨打的号码不存在" |
| 408 Request Timeout | 超时 | 是 | 继续尝试或"无人接听" |
| 480 Temporarily Unavailable | 暂时不可达 | 否 | "对方暂时无法接通" |
| 486 Busy Here | 忙 | 否 | "对方占线" |
| 487 Request Terminated | 被取消 | 否 | 无（主叫主动取消） |
| 503 Service Unavailable | 服务不可用 | **是** | 继续尝试 |
| 603 Decline | 拒绝 | 否 | "对方拒绝接听" |
| 无响应（30s） | 网络超时 | **是** | 继续尝试 |

**中继熔断机制**：

```rust
struct TrunkCircuitBreaker {
    /// trunk_id → 熔断状态
    states: DashMap<i64, CircuitState>,
    /// 熔断恢复探测间隔
    recovery_interval: Duration,        // 默认 30s
}

enum CircuitState {
    Closed,                             // 正常
    Open { opened_at: Instant },        // 熔断中
    HalfOpen,                           // 探测中（放行一个请求测试）
}

impl TrunkCircuitBreaker {
    /// 记录中继失败
    fn record_failure(&self, trunk_id: i64) {
        // 连续 3 次失败 → 熔断（Open）
    }

    /// 记录中继成功
    fn record_success(&self, trunk_id: i64) {
        // 成功 → 重置为 Closed
    }

    /// 检查中继是否可用
    fn is_available(&self, trunk_id: i64) -> bool {
        match self.states.get(&trunk_id) {
            Some(CircuitState::Closed) | None => true,
            Some(CircuitState::Open { opened_at }) => {
                // 超过恢复间隔 → 转为 HalfOpen，允许一次探测
                opened_at.elapsed() >= self.recovery_interval
            }
            Some(CircuitState::HalfOpen) => false,
        }
    }
}
```

---

## 6. SIP 安全

### 6.1 SIP DIGEST 认证

```
SIP 话机                              sipserver
  │                                      │
  │  REGISTER                            │
  │  Authorization: (空)                  │
  │ ────────────────────────────────────►│
  │                                      │
  │  401 Unauthorized                    │
  │  WWW-Authenticate: Digest            │
  │    realm="nextswitch",               │
  │    nonce="随机生成的64位hex",          │
  │    algorithm=MD5,                    │
  │    qop="auth"                        │
  ◄────────────────────────────────────│
  │                                      │
  │  REGISTER                            │
  │  Authorization: Digest               │
  │    username="1001",                  │
  │    realm="nextswitch",               │
  │    nonce="...",                      │
  │    uri="sip:nextswitch.com",         │
  │    response="MD5计算结果",             │
  │    qop=auth,                         │
  │    nc=00000001,                      │
  │    cnonce="客户端随机数"               │
  │ ────────────────────────────────────►│
  │                                      │
  │  ① 从 extensions 表获取 password_hash │
  │  ② 用相同参数计算期望 response         │
  │  ③ 比对 response                     │
  │                                      │
  │  200 OK                              │
  │  (认证通过，写入 Redis 注册表)          │
  ◄────────────────────────────────────│
```

**认证参数**：

```rust
struct SipDigestChallenge {
    realm: String,                      // 固定 "nextswitch"
    nonce: String,                      // 16 字节随机 hex
    algorithm: DigestAlgorithm,         // MD5 (SIP 标准)
    qop: QualityOfProtection,           // auth (仅认证)
    nonce_lifetime: Duration,           // nonce 有效期，默认 60s
}
```

> **与平台 JWT 认证的关系**：SIP DIGEST 认证（RFC 2617）与平台的 JWT 认证体系完全独立。SIP 话机注册使用 DIGEST 认证，凭证基于 `extensions.auth_secret` 字段（存储密码哈希或明文密码），用于计算 Digest response。WebSocket 信令端点使用 JWT（通过 `?token=<jwt>` 传递），由平台 Auth Service 签发。两套认证机制互不影响：SIP 话机无需 JWT，WebSocket 客户端无需 SIP DIGEST。

### 6.2 反欺骗注册

```rust
pub struct RegistrationSecurityChecker {
    /// 注册速率检测（per IP）
    register_rate: RateLimiter,
    /// 用户名枚举检测（per IP）
    username_enumeration: RateLimiter,
}

impl RegistrationSecurityChecker {
    pub fn check(&self, register: &SipRegister, source_ip: IpAddr) -> Result<(), RegSecurityError> {
        // ① 注册速率限制：同一 IP 每秒最多 5 次 REGISTER
        if !self.register_rate.check(&source_ip, 5, Duration::from_secs(1)) {
            return Err(RegSecurityError::RateLimited);
        }

        // ② 用户名枚举防护：同一 IP 对不同用户名注册失败 ≥ 10 次 → 临时封禁
        if !self.username_enumeration.check(&source_ip, 10, Duration::from_secs(60)) {
            return Err(RegSecurityError::UsernameEnumeration);
        }

        // ③ Contact 地址校验：Contact 中的 IP 必须与来源 IP 一致
        //    （防止攻击者将注册指向其他主机，劫持通话）
        let contact_ip = extract_ip_from_contact(&register.contact)?;
        if contact_ip != source_ip {
            if !is_nat_scenario(contact_ip, source_ip) {
                return Err(RegSecurityError::ContactMismatch {
                    expected: source_ip,
                    got: contact_ip,
                });
            }
        }

        // ④ 分机状态检查：disabled/locked 的分机不允许注册
        Ok(())
    }
}
```

**安全响应策略**：

| 场景 | 响应 | 理由 |
|------|------|------|
| 用户名不存在 | 403 Forbidden | 不暴露分机是否存在（防枚举） |
| 密码错误 | 401 Unauthorized | 正常认证失败 |
| 分机已禁用 | 403 Forbidden | 与"不存在"相同响应 |
| 分机已锁定 | 403 Forbidden | 与"不存在"相同响应 |
| Contact 不匹配 | 403 Forbidden + 告警 | 可能的劫持尝试 |

### 6.3 话费欺诈检测

```rust
pub struct TollFraudDetector {
    /// 分机维度：短时间内大量外呼检测
    per_extension: DashMap<i64, CallWindow>,
    /// 租户维度：异常费用模式检测
    per_tenant: DashMap<i64, CallWindow>,
    /// 全局：国际号码突增检测
    international_spike: DashMap<i64, CallWindow>,
}

struct CallWindow {
    calls: VecDeque<Instant>,
    international_count: u32,
    total_duration_secs: u64,
    window: Duration,                 // 检测窗口，默认 10 分钟
}

impl TollFraudDetector {
    pub fn record_call(&self, call: &CallRecord) -> Option<SecurityEvent> {
        // ① 分机维度：10 分钟内外呼 > 20 次 → 告警
        // ② 分机维度：10 分钟内国际呼叫 > 5 次 → 告警
        // ③ 分机维度：10 分钟内总通话时长 > 600 秒 → 告警
        // ④ 租户维度：1 小时内国际呼叫费用突增 3 倍 → 告警
        // ⑤ 非工作时间（23:00-06:00）的国际呼叫 → 告警

        // 自动响应：暂停该分机外呼权限（需管理员手动恢复）
    }
}
```

**自动响应动作**：

| 检测规则 | 阈值 | 自动动作 |
|---------|------|---------|
| 分机短时间大量外呼 | 10 分钟 > 20 次 | 暂停外呼权限 + 告警 |
| 分机国际呼叫突增 | 10 分钟 > 5 次 | 暂停外呼权限 + 告警 |
| 非工作时间国际呼叫 | 任何 | 告警（不自动暂停，可能有合法场景） |
| 租户费用突增 | 1 小时 > 3x 基线 | 告警管理员 |

### 6.4 呼叫准入控制 (CAC)

#### 多层限制体系

```
呼叫请求进入
  │
  ├─ ① 系统级限制
  │     ├─ 全局最大并发呼叫数（系统容量上限）
  │     └─ 全局 CPS 上限（每秒呼叫建立数）
  │
  ├─ ② 租户级限制
  │     ├─ 租户最大并发呼叫数
  │     ├─ 租户 CPS 上限
  │     └─ 租户月度呼叫总量配额（可选）
  │
  ├─ ③ 分机/坐席级限制
  │     ├─ 单分机最大并发呼叫数（通常 1-3）
  │     └─ 单分机外呼并发数
  │
  └─ ④ 中继级限制
        ├─ 中继最大并发通道数（trunks.max_channels）
        └─ 中继 CPS 上限（防止对运营商造成压力）
```

#### Redis 计数器实现

```rust
pub struct CallAdmissionController {
    redis: RedisClient,
}

impl CallAdmissionController {
    /// 呼叫准入检查（在 INVITE 处理前调用）
    pub async fn admit(&self, call: &CallRequest) -> Result<(), CacDenied> {
        // ① 系统级
        let system_active = self.redis.get("cac:system:active").await?.unwrap_or(0);
        if system_active >= self.system_max_calls {
            return Err(CacDenied::SystemCapacity);
        }

        // ② 租户级
        let tenant_key = format!("cac:tenant:{}:active", call.tenant_id);
        let tenant_active: u64 = self.redis.get(&tenant_key).await?.unwrap_or(0);
        if tenant_active >= call.tenant_max_calls {
            return Err(CacDenied::TenantCapacity);
        }

        // ③ 分机级
        let ext_key = format!("cac:ext:{}:active", call.extension_id);
        let ext_active: u64 = self.redis.get(&ext_key).await?.unwrap_or(0);
        if ext_active >= call.extension_max_calls {
            return Err(CacDenied::ExtensionCapacity);
        }

        // ④ 中继级（仅呼出）
        if let Some(trunk_id) = call.trunk_id {
            let trunk_key = format!("cac:trunk:{}:active", trunk_id);
            let trunk_active: u64 = self.redis.get(&trunk_key).await?.unwrap_or(0);
            if trunk_active >= call.trunk_max_channels {
                return Err(CacDenied::TrunkCapacity);
            }
        }

        // 全部通过 → 递增所有计数器
        self.redis.incr("cac:system:active").await?;
        self.redis.incr(&tenant_key).await?;
        self.redis.incr(&ext_key).await?;
        if let Some(trunk_id) = call.trunk_id {
            self.redis.incr(&format!("cac:trunk:{}:active", trunk_id)).await?;
        }

        Ok(())
    }

    /// 呼叫结束 → 递减计数器
    pub async fn release(&self, call: &CallRecord) -> Result<()> {
        self.redis.decr("cac:system:active").await?;
        self.redis.decr(&format!("cac:tenant:{}:active", call.tenant_id)).await?;
        self.redis.decr(&format!("cac:ext:{}:active", call.extension_id)).await?;
        if let Some(trunk_id) = call.trunk_id {
            self.redis.decr(&format!("cac:trunk:{}:active", trunk_id)).await?;
        }
        Ok(())
    }
}
```

#### 计数器一致性保障

```
问题：如果 sipserver 进程崩溃，计数器未被递减，导致"泄漏"。

解决方案：
① 每次呼叫建立时，同时写入 Redis Hash：
   cac:calls:{instance_id} → { call_id: expire_at }

② 实例启动时，扫描 cac:calls:{自身 instance_id}
   → 发现未清理的呼叫 → 递减对应计数器

③ 定时任务（每 60s）：
   → 扫描所有 cac:calls:*
   → 清理已超时的记录（expire_at < now）
   → 递减对应计数器
```

#### CPS 限流

```rust
pub struct CpsLimiter {
    window: SlidingWindowCounter,
}

impl CpsLimiter {
    /// 检查是否允许新的呼叫建立
    pub fn allow(&self, scope: &str, limit: u32) -> bool {
        // scope: "system" / "tenant:{id}" / "trunk:{id}"
        let current = self.window.count(scope, Duration::from_secs(1));
        current < limit
    }
}
```

### 6.5 SIP 防火墙

#### SIP 消息深度校验

```rust
pub struct SipFirewall {
    /// 消息格式校验器
    validator: SipMessageValidator,
    /// 拓扑隐藏处理器
    topology_hider: TopologyHider,
    /// SDP 安全处理器
    sdp_security: SdpSecurityProcessor,
}

impl SipFirewall {
    pub fn inspect(&self, msg: &mut SipMessage, source_ip: IpAddr) -> Result<(), SipFirewallError> {
        // ① 消息格式合法性
        self.validator.validate(msg)?;

        // ② 消息大小限制
        if msg.raw_len() > MAX_SIP_MESSAGE_SIZE {     // 默认 8KB
            return Err(SipFirewallError::MessageTooLarge);
        }

        // ③ 方法白名单
        const ALLOWED_METHODS: &[&str] = &[
            "INVITE", "ACK", "BYE", "CANCEL", "REGISTER", "OPTIONS", "REFER", "NOTIFY", "INFO",
        ];
        if !ALLOWED_METHODS.contains(&msg.method()) {
            return Err(SipFirewallError::MethodNotAllowed);
        }

        // ④ 必选头检查
        self.validator.require_headers(msg, &[
            "Via", "From", "To", "Call-ID", "CSeq", "Max-Forwards",
        ])?;

        // ⑤ Max-Forwards 检查（防循环）
        if msg.max_forwards() == 0 {
            return Err(SipFirewallError::MaxForwardsExceeded);
        }

        // ⑥ Via 头检查（防路由循环和注入）
        self.validator.check_via_integrity(msg)?;

        // ⑦ SDP 安全处理（INVITE/200 OK 时）
        if msg.has_sdp() {
            self.sdp_security.process(msg)?;
        }

        // ⑧ 拓扑隐藏（出站消息）
        self.topology_hider.hide(msg);

        Ok(())
    }
}
```

#### SIP 消息格式校验详情

```rust
pub struct SipMessageValidator;

impl SipMessageValidator {
    pub fn validate(&self, msg: &SipMessage) -> Result<(), ValidationError> {
        // ① SIP 版本检查：仅允许 SIP/2.0
        if msg.version() != "SIP/2.0" {
            return Err(ValidationError::InvalidVersion);
        }

        // ② URI 合法性：不允许包含危险字符
        //    防止 SIP 注入（如在 From display name 中注入 \r\n）
        self.check_uri_injection(msg.from())?;
        self.check_uri_injection(msg.to())?;
        self.check_uri_injection(msg.request_uri())?;

        // ③ Call-ID 格式：必须为合法字符串（防过长/特殊字符）
        if msg.call_id().len() > 256 {
            return Err(ValidationError::CallIdTooLong);
        }

        // ④ CSeq 合法性：方法必须与请求方法一致
        if msg.cseq_method() != msg.method() {
            return Err(ValidationError::CseqMethodMismatch);
        }

        // ⑤ Contact URI 合法性（REGISTER 时）
        if msg.method() == "REGISTER" {
            if let Some(contact) = msg.contact() {
                self.validate_contact_uri(contact)?;
            }
        }

        // ⑥ 自定义头数量限制（防头部泛洪）
        if msg.header_count() > 64 {
            return Err(ValidationError::TooManyHeaders);
        }

        // ⑦ 单个头部大小限制
        for header in msg.headers() {
            if header.value_len() > 4096 {
                return Err(ValidationError::HeaderTooLarge);
            }
        }

        Ok(())
    }

    /// 检查 URI 中是否存在注入字符
    fn check_uri_injection(&self, uri: &SipUri) -> Result<(), ValidationError> {
        let raw = uri.to_string();
        // 禁止 \r\n（CRLF 注入）
        if raw.contains('\r') || raw.contains('\n') {
            return Err(ValidationError::CrlfInjection);
        }
        // 禁止 <> 嵌套（防止伪造额外头）
        if raw.matches('<').count() > 1 || raw.matches('>').count() > 1 {
            return Err(ValidationError::BracketInjection);
        }
        Ok(())
    }
}
```

### 6.6 拓扑隐藏

防止外部实体获取内部网络拓扑信息：

```rust
pub struct TopologyHider;

impl TopologyHider {
    /// 处理出站 SIP 消息（发往外部）
    pub fn hide(&self, msg: &mut SipMessage) {
        // ① 移除内部 Via 头
        //    保留最外层的 Via（指向 sipserver 公网地址），
        //    移除内部实例的 Via 头
        self.strip_internal_vias(msg);

        // ② 移除 Record-Route 中的内部地址
        //    仅保留 sipserver 公网地址的 Record-Route
        self.strip_internal_record_routes(msg);

        // ③ 移除泄露内部信息的自定义头
        const STRIP_HEADERS: &[&str] = &[
            "X-Internal-Route",
            "X-Trace-Id",           // 追踪 ID 仅在内部传递
            "X-Instance-Id",
            "X-Site-Id",
        ];
        for header in STRIP_HEADERS {
            msg.remove_header(header);
        }

        // ④ 替换 Contact 中的内部 IP
        //    将 Contact 指向 sipserver 的公网地址
        self.rewrite_contact_to_public(msg);
    }
}
```

### 6.7 SDP 安全

```rust
pub struct SdpSecurityProcessor;

impl SdpSecurityProcessor {
    pub fn process(&self, msg: &mut SipMessage) -> Result<(), SdpError> {
        let sdp = msg.sdp_mut().ok_or(SdpError::NoSdp)?;

        // ① 媒体端口范围校验
        //    仅允许 RTP 端口范围 10000-60000（与防火墙规则一致）
        for media in &sdp.media {
            if media.port < 10000 || media.port > 60000 {
                return Err(SdpError::PortOutOfRange);
            }
        }

        // ② 编解码器白名单
        //    仅允许系统支持的编解码器
        const ALLOWED_CODECS: &[&str] = &[
            "PCMU", "PCMA", "G729", "G722", "opus", "G723",
        ];
        for media in &sdp.media {
            for codec in &media.codecs {
                if !ALLOWED_CODECS.contains(&codec.name.as_str()) {
                    // 移除不支持的编解码器（不拒绝，静默过滤）
                    media.remove_codec(&codec.name);
                }
            }
        }

        // ③ SDP 大小限制
        if sdp.raw_len() > 4096 {
            return Err(SdpError::SdpTooLarge);
        }

        // ④ 连接地址重写（NAT 穿越）
        //    将 SDP 中的内网 IP 替换为 sipserver 看到的公网 IP
        //    （或指向 medserver 的媒体地址）
        self.rewrite_connection_address(sdp, msg.source_ip())?;

        Ok(())
    }
}
```

---

## 7. 服务间通信

### 7.1 通信矩阵

| 通信 | 方式 | 说明 |
|------|------|------|
| config → sipserver/signalserver | Redis Pub/Sub | 配置增量下发（频道：`config:{tenant_id}:{entity_type}`） |
| sipserver ↔ signalserver | Redis Pub/Sub | 跨协议呼叫协调（频道：`call:command:{instance_id}` / `call:event:{instance_id}`） |
| sipserver ↔ router-server | gRPC | 复杂路由决策（呼叫流程、IVR、ACD 排队） |
| sipserver ↔ medserver | gRPC | 媒体会话控制 |
| signalserver ↔ cti-server | Redis Pub/Sub | 坐席状态同步、呼叫事件（频道：`call:command:{instance_id}` / `call:event:{instance_id}`） |
| signalserver ↔ medserver | gRPC | 媒体会话控制 |
| im-server → cti-server | gRPC | ACD 排队、坐席容量管理 |
| im-server ↔ cti-server | Redis Pub/Sub | 会话事件同步 |
| 所有 → Redis | redis-rs | 注册表读写 |

**Pub/Sub 频道命名规范**：

| 频道模式 | 用途 |
|---------|------|
| `call:command:{instance_id}` | 向指定实例发送呼叫指令 |
| `call:event:{instance_id}` | 接收指定实例的呼叫事件通知 |
| `config:{tenant_id}:{entity_type}` | 配置增量下发 |

### 7.2 连接池与重试

```
Redis: 超时 100ms，重试 2 次
gRPC (medserver): 超时 500ms，重试 1 次
gRPC (router-server): 超时 1000ms，重试 1 次，降级到本地路由
config (Pub/Sub): 自动重连，本地缓存兜底
```

---

## 8. 集群与高可用

### 8.1 实例生命周期

**启动**：
1. 连接 Redis，注册 heartbeat（TTL 30s）
   - Key 格式：`heartbeat:sipserver:{instance_id}` 或 `heartbeat:signalserver:{instance_id}`
2. 从 config 服务拉取全量配置
3. 订阅 Redis Pub/Sub 频道（`call:command:{instance_id}` 等）
4. 启动 SIP/WS 监听
5. 启动心跳协程（每 10s 刷新 TTL）

**关闭（graceful）**：
1. 停止接受新连接
2. 等待活跃呼叫结束（超时 30s）
3. 删除 heartbeat key
4. 通知其他实例清理注册记录

### 8.2 故障场景

| 场景 | 处理 |
|------|------|
| 实例宕机 | heartbeat TTL 过期，其他实例清理注册，新呼叫不路由到该实例 |
| Redis 短暂不可用 | 注册查询走本地缓存，新注册返回 503，恢复后自动重连 |
| config 服务不可用 | 使用本地缓存，无法接收增量更新，恢复后自动重连 |
| router-server 不可用 | sipserver 降级到本地路由匹配器，仅支持快速路径（分机直拨、简单模式匹配） |

---

## 9. 多站点设计

### 9.1 站点拓扑

```
Global DNS / GeoIP LB
       │
  ┌────┼────┐
  │    │    │
Site  Site  Site
US    EU    AP
  │
┌─┴─┐
AZ1 AZ2  ← 每站点多可用区
```

### 9.2 路由策略

- **站点内优先**：主叫被叫同站点 → 直接路由
- **跨站点**：通过站点间 SIP Trunk，需 SDP 重写
- **故障切换**：DNS 切换到备用站点

### 9.3 数据模型扩展

```rust
reg:sip:1001@domain → {
  "contact": "sip:1001@192.168.1.100:5060",
  "site_id": "us-east-1",
  "az_id": "us-east-1a",
  "instance_id": "sipserver-01",
  ...
}
```

---

## 10. CDR 设计

### 10.1 CDR 数据模型

```rust
struct Cdr {
    call_id: String,
    caller: String,
    callee: String,
    source: CallSource,        // Sip, WebRTC
    start_time: DateTime<Utc>,
    answer_time: Option<DateTime<Utc>>,
    end_time: DateTime<Utc>,
    duration_secs: u64,
    hangup_cause: String,
    sip_code: u16,
    recording_url: Option<String>,
    site_id: String,
    instance_id: String,
}
```

**数据库表定义**（遵循宪法 Principle IX）：

```sql
CREATE TABLE cdrs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    call_id VARCHAR(255) NOT NULL,
    caller VARCHAR(50) NOT NULL,
    callee VARCHAR(50) NOT NULL,
    source VARCHAR(20) NOT NULL,                -- sip / webrtc
    direction VARCHAR(20) NOT NULL,             -- inbound / outbound / internal
    start_time DATETIME NOT NULL,
    answer_time DATETIME,
    end_time DATETIME NOT NULL,
    duration_secs INT NOT NULL DEFAULT 0,
    hangup_cause VARCHAR(50) NOT NULL,
    sip_code INT NOT NULL DEFAULT 0,
    recording_url VARCHAR(500),
    site_id VARCHAR(100) NOT NULL,
    az_id VARCHAR(100),
    instance_id VARCHAR(100) NOT NULL,
    caller_agent_id BIGINT,                     -- 主叫坐席（如有）
    callee_agent_id BIGINT,                     -- 被叫坐席（如有）
    queue_id BIGINT,                            -- 经过的队列（如有）
    trunk_id BIGINT,                            -- 使用的外继（如有）
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
CREATE INDEX idx_cdrs_tenant_id ON cdrs(tenant_id);
CREATE INDEX idx_cdrs_call_id ON cdrs(call_id);
CREATE INDEX idx_cdrs_site_id ON cdrs(site_id);
CREATE INDEX idx_cdrs_start_time ON cdrs(start_time DESC);
CREATE INDEX idx_cdrs_caller ON cdrs(tenant_id, caller);
CREATE INDEX idx_cdrs_callee ON cdrs(tenant_id, callee);
CREATE INDEX idx_cdrs_agent ON cdrs(tenant_id, caller_agent_id);
CREATE INDEX idx_cdrs_sync ON cdrs(site_id, instance_id, id);
```

> **注意**：`cdrs` 表由 sipserver 和 signalserver 共同写入，通过 WAL 缓冲异步同步。
> 表所有权归信令层，不属于 Config Service 或 Auth Service。

### 10.2 WAL Buffer 写入流水线

```
呼叫结束 → CDR 生成 → WAL 追加写 (fsync) → 异步写 DB
                                              ├─ 成功 → 标记已同步
                                              └─ 失败 → 等待重试
```

### 10.3 WAL 文件结构

```
data/wal/
├── 000001.wal    # [length][crc32][cdr_json][newline]
├── 000002.wal    # 按大小滚动（64MB/文件）
└── checkpoint     # 已同步到 DB 的位置
```

Redis 同步位置追踪：`cdr:sync:{instance_id}:wal_position`

### 10.4 恢复流程

**自动模式**：后台 worker 每 5s 探测 DB，恢复后从 checkpoint 读取 WAL 逐条写入

**手动模式**：`POST /api/cdr/flush` 或 `nextswitch cdr flush --site us-east-1`

---

## 11. 错误处理

### 11.1 分层策略

| 层级 | 策略 |
|------|------|
| 协议层 | 返回协议级错误（SIP 4xx/5xx, JSON-RPC error） |
| 业务层 | 自定义 Error enum，携带上下文 |
| 基础设施层 | 熔断器 + 超时 + 重试，降级到缓存 |

### 11.2 熔断器配置

```
Redis：失败 5 次 → 熔断，每 3s 探测恢复，降级到本地缓存
数据库：失败 3 次 → 熔断，每 5s 探测恢复，CDR 写 WAL
medserver：超时 500ms，重试 1 次，失败返回 503
router-server：超时 1000ms，重试 1 次，降级到本地路由
```

---

## 12. 监控与可观测性

### 12.1 技术选型

| 组件 | 选型 | 说明 |
|------|------|------|
| 指标采集 | Prometheus + `metrics` crate | 标准 `/metrics` 端点，Pull 模式 |
| 结构化日志 | `tracing` + `tracing-subscriber` | JSON 格式输出，与指标关联 |
| 分布式追踪 | OpenTelemetry → Jaeger/Tempo | 呼叫级链路追踪 |
| 告警 | Prometheus Alertmanager | 阈值 + 趋势告警 |
| 仪表板 | Grafana | 运维/业务双视图 |

### 12.2 指标体系

**SIP 信令指标**（sipserver）：

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `sip_calls_total` | Counter | `method`, `response_code`, `site_id` | SIP 请求/响应计数 |
| `sip_calls_active` | Gauge | `site_id`, `instance_id` | 当前活跃呼叫数 |
| `sip_cps` | Counter | `site_id` | 每秒呼叫建立数（通过 rate() 计算） |
| `sip_register_total` | Counter | `action`（add/refresh/remove） | 注册事件计数 |
| `sip_register_active` | Gauge | `site_id`, `domain` | 当前活跃注册数 |
| `sip_proxy_duration_seconds` | Histogram | `method` | 代理处理延迟分布 |
| `sip_b2bua_downgrade_total` | Counter | `reason`（record/conference/ivr/transcode） | B2BUA 降级次数 |

**WebSocket 信令指标**（signalserver）：

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `ws_connections_active` | Gauge | `site_id`, `instance_id` | 当前活跃 WebSocket 连接数 |
| `ws_messages_total` | Counter | `method`, `direction`（in/out） | JSON-RPC 消息计数 |
| `ws_handshake_duration_seconds` | Histogram | — | WebSocket 握手 + 认证延迟 |
| `ws_heartbeat_timeout_total` | Counter | `instance_id` | 心跳超时断连次数 |

**安全指标**：

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `sip_auth_failures_total` | Counter | `reason`（invalid_password/contact_mismatch/rate_limited） | SIP 认证失败率 |
| `sip_registration_attacks_total` | Counter | `type`（enumeration/spoof/flood） | 伪造注册检测次数 |
| `toll_fraud_alerts_total` | Counter | `scope`（extension/tenant） | Toll Fraud 检测次数 |
| `cac_denials_total` | Counter | `layer`（system/tenant/extension/trunk） | CAC 拒绝次数 |
| `sip_firewall_blocks_total` | Counter | `reason`（injection/oversized/invalid_method/sdp_violation） | SIP 防火墙拦截次数 |
| `topology_hidden_total` | Counter | `action`（via_stripped/contact_rewritten/header_removed） | 拓扑隐藏处理次数 |

**基础设施指标**：

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `redis_command_duration_seconds` | Histogram | `command`, `status`（ok/error） | Redis 命令延迟 |
| `redis_pool_active_connections` | Gauge | — | 连接池活跃连接数 |
| `redis_cache_hit_total` | Counter | `cache`（registration/route） | 本地缓存命中计数 |
| `redis_cache_miss_total` | Counter | `cache`（registration/route） | 本地缓存未命中计数 |
| `cdr_wal_pending` | Gauge | `instance_id` | WAL 中待同步到 DB 的 CDR 条数 |
| `cdr_db_write_duration_seconds` | Histogram | `status` | CDR 写数据库延迟 |
| `tokio_worker_utilization` | Gauge | `instance_id` | Tokio worker 线程利用率 |
| `process_cpu_seconds_total` | Counter | — | 进程 CPU 时间 |
| `process_resident_memory_bytes` | Gauge | — | 进程常驻内存 |

### 12.3 OpenTelemetry 追踪

每次呼叫生成唯一 `trace_id`（优先使用 SIP Call-ID），贯穿全链路：

```
INVITE 入站
  │  span: sip_proxy { call_id, from, to, method=INVITE }
  │
  ├─ redis_lookup { aor, cache_hit=true/false, duration }
  │
  ├─ route_decision { pattern, action, flags }
  │
  ├─ [可选] b2bua_downgrade { reason, medserver_session_id }
  │
  └─ forward { target_instance, transport, duration }
       │
       └─ 180 Ringing / 200 OK / 失败
```

**追踪上下文传播**：
- SIP：通过 `X-Trace-Id` 自定义头传递
- WebSocket：通过 JSON-RPC 消息 `_trace` 字段传递
- gRPC（medserver, router-server）：通过 gRPC metadata 传递
- Redis Pub/Sub：通过消息 payload 中的 `trace_id` 字段传递

**Span 属性**：

| 属性 | 来源 | 说明 |
|------|------|------|
| `call.id` | SIP Call-ID / WS session_id | 呼叫唯一标识 |
| `call.caller` | From header / register | 主叫号码 |
| `call.callee` | Request-URI / invite params | 被叫号码 |
| `call.site_id` | 配置 | 站点标识 |
| `call.instance_id` | 运行时 | 处理实例 |
| `call.direction` | 计算 | inbound / outbound |
| `call.result` | 最终响应码 | 200/486/503 等 |

### 12.4 结构化日志

**日志级别策略**：

| 级别 | 使用场景 |
|------|----------|
| ERROR | 呼叫失败、基础设施不可用、panic recovery |
| WARN | 降级操作、熔断器触发、重试、缓存未命中 |
| INFO | 呼叫建立/结束、注册/注销、实例启动/关闭 |
| DEBUG | 消息详情、路由决策、Redis 命令 |
| TRACE | 帧级协议数据、序列化/反序列化 |

**日志格式**（JSON）：
```json
{
  "timestamp": "2026-09-09T10:30:00.123Z",
  "level": "INFO",
  "target": "nextswitch_sip::proxy",
  "fields": {
    "call_id": "abc123@192.168.1.1",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "method": "INVITE",
    "caller": "1001",
    "callee": "1002",
    "instance_id": "sipserver-03",
    "site_id": "us-east-1",
    "duration_ms": 3
  },
  "message": "call established"
}
```

**关联规则**：
- 所有与同一呼叫相关的日志必须携带相同 `call_id`
- `trace_id` 用于跨服务关联（sipserver ↔ signalserver ↔ medserver ↔ router-server）
- 生产环境默认 INFO 级别，可按 `call_id` 动态调整到 DEBUG

### 12.5 健康检查

**HTTP 端点**：`GET /health`（端口 9090）

**响应格式**：
```json
{
  "status": "healthy",
  "instance_id": "sipserver-03",
  "uptime_secs": 86400,
  "checks": {
    "redis": { "status": "healthy", "latency_ms": 2 },
    "database": { "status": "degraded", "latency_ms": 450, "detail": "circuit breaker half-open" },
    "medserver": { "status": "healthy", "latency_ms": 15 },
    "router_server": { "status": "healthy", "latency_ms": 8 }
  },
  "metrics": {
    "active_calls": 342,
    "active_registrations": 12050,
    "active_ws_connections": 890
  }
}
```

**探针分类**：

| 探针 | 端点 | 用途 | 检查内容 |
|------|------|------|----------|
| liveness | `/health/live` | K8s 存活探针 | 进程是否响应 |
| readiness | `/health/ready` | K8s 就绪探针 | Redis 可达、配置已加载 |
| startup | `/health/startup` | K8s 启动探针 | 初始化完成（配置拉取 + 监听绑定） |

**状态判定**：
- `healthy`：所有依赖正常
- `degraded`：部分依赖降级但核心功能可用（如 DB 熔断、Redis 走缓存、router-server 降级到本地路由）
- `unhealthy`：核心依赖不可用（如 Redis 完全不可达且缓存为空）

### 12.6 告警规则

**P0 — 立即处理（电话告警）**：

| 规则 | 条件 | 说明 |
|------|------|------|
| 服务不可用 | `up == 0` 持续 30s | 实例完全宕机 |
| Redis 不可达 | `redis_cache_hit_total` 增速归零 + 错误率 >50% | 注册表不可用 |
| 呼叫建立失败率 | `rate(sip_calls_total{response_code=~"5.."}) / rate(sip_calls_total) > 0.1` 持续 2m | 10% 以上呼叫失败 |
| Toll Fraud 疑似 | `toll_fraud_alerts_total` 增速 > 0 | 话费欺诈检测 |
| SIP 注入尝试 | `sip_firewall_blocks_total{reason="injection"}` > 0 | SIP 消息注入攻击 |

**P1 — 15 分钟内处理（即时消息告警）**：

| 规则 | 条件 | 说明 |
|------|------|------|
| 高延迟 | `histogram_quantile(0.99, sip_proxy_duration_seconds) > 0.5` 持续 5m | P99 延迟超 500ms |
| WAL 积压 | `cdr_wal_pending > 10000` 持续 10m | CDR 写入 DB 异常 |
| 连接池耗尽 | `redis_pool_active_connections / redis_pool_max_connections > 0.9` 持续 3m | Redis 连接池即将耗尽 |
| 实例数不足 | `count(sip_calls_active) < expected_instances * 0.8` | 实例数低于预期 |
| SIP 认证攻击 | `rate(sip_auth_failures_total) > 50/min` 持续 2m | SIP 认证暴力攻击 |
| CAC 频繁触发 | `rate(cac_denials_total) > 100/min` 持续 5m | 呼叫准入频繁拒绝 |

**P2 — 工作时间处理（工单告警）**：

| 规则 | 条件 | 说明 |
|------|------|------|
| 缓存命中率下降 | `rate(redis_cache_hit_total) / (rate(redis_cache_hit_total) + rate(redis_cache_miss_total)) < 0.8` 持续 15m | 缓存效率低 |
| 内存增长 | `process_resident_memory_bytes` 持续增长无回落 持续 1h | 潜在内存泄漏 |
| 心跳超时频繁 | `rate(ws_heartbeat_timeout_total) > 10/min` 持续 5m | 网络或客户端异常 |

### 12.7 Grafana 仪表板

**运维视图**：

```
┌─────────────────────────────────────────────────┐
│  集群概览                                        │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐           │
│  │实例数 │ │注册数 │ │并发呼叫│ │ CPS  │           │
│  │  4/4 │ │ 48.2K│ │ 3,420│ │  185 │           │
│  └──────┘ └──────┘ └──────┘ └──────┘           │
├─────────────────────────────────────────────────┤
│  信令延迟 (P50/P95/P99)                          │
│  ▁▂▃▅▃▂▁▁▂▃▅▇▅▃▂▁▁▂▃▅▃▂▁                     │
├─────────────────────────────────────────────────┤
│  Redis 命令延迟          │  连接池使用率           │
│  ▁▁▁▂▁▁▁▁▃▁▁▁▁▁▁▁▁▁   │  ████████░░ 78%       │
├─────────────────────────────────────────────────┤
│  错误率 (5xx/s)          │  WAL 积压              │
│  ▁▁▁▁▁▁▃▁▁▁▁▁▁▁▁▁▁▁   │  120 条               │
└─────────────────────────────────────────────────┘
```

**业务视图**：

```
┌─────────────────────────────────────────────────┐
│  呼叫统计（今日）                                  │
│  总呼叫: 125,430  │  接通率: 94.2%  │  平均时长: 4m32s │
├─────────────────────────────────────────────────┤
│  呼叫来源分布                                     │
│  SIP→SIP: 62%  │  WebRTC→SIP: 28%  │  SIP→WebRTC: 10% │
├─────────────────────────────────────────────────┤
│  B2BUA 降级分布                                   │
│  录音: 45%  │  会议: 12%  │  IVR: 8%  │  转码: 3%   │
├─────────────────────────────────────────────────┤
│  站点负载                                          │
│  US-East: ████░░ 42%  │  EU-West: ██░░░░ 28%     │
│  AP-SE:   ███░░░ 30%                             │
└─────────────────────────────────────────────────┘
```

### 12.8 前端监控 API

前端 Web UI 通过 nextswitch-api 提供的 REST API 获取监控数据，用于自定义仪表板和实时监控页面。

**架构**：

```
Web UI (前端)
    │
    │  REST API
    ▼
nextswitch-api
    │
    ├── 实时数据 → 直连 sipserver/signalserver /health 端点
    │
    └── 历史数据 → Prometheus HTTP API (query_range)
```

**API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/monitoring/overview` | 集群概览（实例数、注册数、并发呼叫、CPS） |
| GET | `/api/v1/monitoring/calls` | 呼叫统计（接通率、平均时长、来源分布） |
| GET | `/api/v1/monitoring/instances` | 各实例状态（CPU、内存、活跃连接） |
| GET | `/api/v1/monitoring/instances/{id}/detail` | 单实例详情（延迟分布、错误率、B2BUA 降级统计） |
| GET | `/api/v1/monitoring/infrastructure` | 基础设施状态（Redis 延迟、连接池、缓存命中率） |
| GET | `/api/v1/monitoring/cdr` | CDR 统计（WAL 积压、写入延迟、同步状态） |
| GET | `/api/v1/monitoring/alerts` | 当前活跃告警列表（聚合自各实例 `/alerts` 端点） |
| GET | `/api/v1/monitoring/media` | 媒体服务器状态（代理自 medserver，含活跃媒体会话、编解码器使用、端口利用率） |
| WS | `/ws/monitoring` | 实时指标推送（WebSocket，每 5s 推送一次） |

> **媒体服务器监控**：medserver 的监控端点由 nextswitch-api 代理暴露，前端无需直连 medserver。代理端点包括：活跃媒体会话数、编解码器使用分布、RTP 端口利用率、媒体延迟/jitter 统计。

**响应示例**（`/api/v1/monitoring/overview`）：

```json
{
  "timestamp": "2026-09-09T10:30:00Z",
  "cluster": {
    "total_instances": 4,
    "healthy_instances": 4,
    "total_sites": 3
  },
  "calls": {
    "active": 3420,
    "cps": 185,
    "success_rate_24h": 0.942,
    "avg_duration_secs": 272
  },
  "registrations": {
    "active": 48200,
    "domains": [
      { "domain": "example.com", "count": 32100 },
      { "domain": "corp.example.com", "count": 16100 }
    ]
  },
  "connections": {
    "websocket_active": 890,
    "redis_pool_active": 45,
    "redis_pool_max": 100
  }
}
```

**实时推送**（`/ws/monitoring`）：

```json
{
  "type": "metrics_update",
  "timestamp": "2026-09-09T10:30:05Z",
  "data": {
    "active_calls": 3421,
    "cps": 186,
    "active_registrations": 48200,
    "ws_connections": 891,
    "redis_latency_p99_ms": 5,
    "error_rate_5xx": 0.002
  }
}
```

**数据源策略**：

| 数据类型 | 来源 | 延迟 |
|----------|------|------|
| 实时概览 | 直连各实例 `/health` 端点聚合 | <1s |
| 历史趋势 | Prometheus `query_range` API | 15s（scrape 间隔） |
| 告警状态 | Alertmanager API（聚合自各服务 `/alerts` 端点） | 实时 |
| 实时推送 | WebSocket 长连接 | 5s 推送间隔 |
| 媒体服务器 | nextswitch-api 代理 medserver 端点 | <1s |

> **告警端点所有权**：每个服务（sipserver、signalserver、medserver 等）维护自己的 `/alerts` 端点，暴露本服务的活跃告警。nextswitch-api 通过聚合各实例的 `/alerts` 端点，提供统一的 `/api/v1/monitoring/alerts` 接口。

**认证与授权**：
- 复用 nextswitch-api 现有 JWT 认证
- 需要 `monitoring:read` 权限
- 实时推送 WebSocket 复用连接认证

### 12.9 Prometheus 集成

**Scrape 配置**：

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'nextswitch-sipserver'
    scrape_interval: 15s
    metrics_path: '/metrics'
    static_configs:
      - targets:
        - 'sipserver-01.internal:9090'
        - 'sipserver-02.internal:9090'
        - 'sipserver-03.internal:9090'
        - 'sipserver-04.internal:9090'
        labels:
          service: 'sipserver'

  - job_name: 'nextswitch-signalserver'
    scrape_interval: 15s
    metrics_path: '/metrics'
    static_configs:
      - targets:
        - 'signalserver-01.internal:9091'
        - 'signalserver-02.internal:9091'
        labels:
          service: 'signalserver'

  # K8s 环境使用服务发现
  - job_name: 'nextswitch-k8s'
    scrape_interval: 15s
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ['nextswitch']
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: '${1}'
```

**Recording Rules**（预计算常用查询，降低 Grafana 查询延迟）：

```yaml
# recording-rules.yml
groups:
  - name: nextswitch_call_metrics
    interval: 30s
    rules:
      # 每秒呼叫建立数（按站点）
      - record: nextswitch:sip_cps:rate5m
        expr: rate(sip_calls_total{response_code="200"}[5m])

      # 呼叫成功率（按站点）
      - record: nextswitch:sip_success_rate:ratio5m
        expr: |
          rate(sip_calls_total{response_code="200"}[5m])
          /
          rate(sip_calls_total[5m])

      # P99 代理延迟（按站点）
      - record: nextswitch:sip_proxy_latency_p99:histogram5m
        expr: histogram_quantile(0.99, rate(sip_proxy_duration_seconds_bucket[5m]))

      # Redis 缓存命中率
      - record: nextswitch:redis_cache_hit_rate:ratio5m
        expr: |
          rate(redis_cache_hit_total[5m])
          /
          (rate(redis_cache_hit_total[5m]) + rate(redis_cache_miss_total[5m]))

      # 每实例活跃呼叫数
      - record: nextswitch:calls_per_instance:gauge
        expr: sip_calls_active

      # WAL 积压总量
      - record: nextswitch:cdr_wal_total:gauge
        expr: sum(cdr_wal_pending) by (site_id)
```

**服务发现（K8s）**：

Pod 注解配置：
```yaml
# sipserver Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sipserver
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
```

**Grafana 数据源配置**：

```yaml
# grafana-datasources.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true

  - name: Jaeger
    type: jaeger
    access: proxy
    url: http://jaeger:16686
```

**告警路由**：

```yaml
# alertmanager.yml
route:
  receiver: 'default'
  group_by: ['alertname', 'site_id']
  routes:
    - match:
        severity: P0
      receiver: 'phone-alert'
      continue: true
    - match:
        severity: P1
      receiver: 'im-alert'
    - match:
        severity: P2
      receiver: 'ticket-alert'

receivers:
  - name: 'phone-alert'
    webhook_configs:
      - url: 'http://alert-bot:8080/phone'
  - name: 'im-alert'
    webhook_configs:
      - url: 'http://alert-bot:8080/im'
  - name: 'ticket-alert'
    webhook_configs:
      - url: 'http://alert-bot:8080/ticket'
```

**指标暴露端点**：

| 服务 | 端口 | 路径 | 说明 |
|------|------|------|------|
| sipserver | 9090 | `/metrics` | Prometheus 指标 |
| sipserver | 9090 | `/health/*` | 健康检查 |
| signalserver | 9091 | `/metrics` | Prometheus 指标 |
| signalserver | 9091 | `/health/*` | 健康检查 |

**安全要求**：
- `/metrics` 和 `/health` 端点仅监听内网地址
- 支持 mTLS 或 Bearer Token 认证（通过配置启用）
- 指标端点限流：10 req/s per client

---

## 13. 测试策略

| 层级 | 范围 | 工具 | 覆盖要求 |
|------|------|------|----------|
| 单元测试 | 各模块内部逻辑 | cargo nextest | 核心路径 100% |
| 集成测试 | 模块间交互 | mock Redis/DB | 注册→路由→呼叫全流程 |
| 协议测试 | SIP/WS 协议合规 | rsipstack 测试套件 | RFC 3261 关键场景 |
| 故障注入 | DB 宕机、Redis 断连 | 自定义 harness | 所有故障场景 |
| 压力测试 | 高并发注册/呼叫 | bench_ua | 目标：10K CPS |

### 13.1 基础设施测试

**关键测试场景**：
1. 正常呼叫流程（WebRTC → SIP, SIP → WebRTC, SIP → SIP）
2. 注册过期 → 重新注册 → 呼叫
3. 数据库宕机 → 新呼叫 → 数据库恢复 → CDR 自动入库
4. 数据库宕机 → 活跃呼叫不中断 → 呼叫结束 → CDR 缓冲
5. Redis 宕机 → 本地缓存命中 → 呼叫继续
6. 实例宕机 → 其他实例接管 → 新注册路由正确
7. 跨站点呼叫 → 媒体中继 → SDP 重写
8. `/health/live`、`/health/ready`、`/health/startup` 端点响应正确性
9. `/metrics` 端点输出 Prometheus 格式、包含所有必需指标
10. 前端监控 API `/api/v1/monitoring/*` 数据聚合正确、WebSocket 实时推送
11. 追踪上下文跨服务传播（SIP `X-Trace-Id` → Redis Pub/Sub → gRPC metadata）
12. 健康检查降级判定（Redis 断连 → degraded、Redis + 缓存空 → unhealthy）

### 13.2 入站呼叫测试

| # | 场景 | 验证点 |
|---|------|--------|
| 1 | 来电 DID 匹配成功 → 路由到分机 | INVITE 正确转发到目标分机 |
| 2 | 来电 DID 匹配成功 → 路由到 IVR | IVR 节点按流程执行，DTMF 正确收集 |
| 3 | 来电 DID 匹配成功 → 路由到队列 | 排队、ACD 分配、坐席振铃流程正确 |
| 4 | 路由规则优先级匹配 | 高优先级规则先命中，低优先级不执行 |
| 5 | 路由规则时间条件 | 工作时间内走规则 A，非工作时间走规则 B |
| 6 | 路由 fallback | 主目标失败（分机未注册）→ 执行 fallback_action |
| 7 | 无 DID 匹配 | 返回 404 + 播放提示音 |
| 8 | router-server 不可用 | sipserver 降级到本地路由，分机直拨仍可用 |

### 13.3 内部分机呼叫测试

| # | 场景 | 验证点 |
|---|------|--------|
| 9 | SIP→SIP 同实例直拨 | P2P 媒体建立，信令正确 |
| 10 | SIP→SIP 跨实例直拨 | 通过 Redis Pub/Sub 协调，媒体通过 medserver |
| 11 | WebRTC→SIP 呼叫 | signalserver 与 sipserver 协作，媒体桥接正确 |
| 12 | 呼叫等待 | 第二路来电提示音正确，hold/switch 正常 |
| 13 | 盲转 | REFER 处理正确，主叫与被转接方通话建立 |
| 14 | 协商转 | 两路呼叫正确合并，原被转接方退出 |
| 15 | 呼叫代答 | 代答方与被叫方通话建立，原目标分机停止振铃 |
| 16 | 呼叫驻留/提取 | 驻留槽位分配正确，提取后通话恢复 |
| 17 | 临时会议 | 三方媒体桥接到会议桥，单方挂断不影响其余 |
| 18 | 前转链防环 | 前转深度超限或循环时正确终止 |

### 13.4 出站呼叫测试

| # | 场景 | 验证点 |
|---|------|--------|
| 19 | 外呼权限拒绝 | 无权限分机外呼被拒绝，播放提示音 |
| 20 | 时段限制 | 非工作时间外呼被拒绝 |
| 21 | 中继选择（优先级） | 高优先级中继优先使用 |
| 22 | 中继选择（轮询） | 中继按轮询顺序使用 |
| 23 | 中继通道满 | 自动切换到下一个可用中继 |
| 24 | 中继失败快速重拨 | 503 响应后自动切换中继，主叫无感知 |
| 25 | 所有中继失败 | 播放"线路繁忙"提示 → 挂断 |
| 26 | 主叫号码呈现 | 外显号码正确写入 From/PAI 头 |
| 27 | 中继熔断 | 连续失败后熔断，恢复间隔后探测 |

### 13.5 安全测试

| # | 场景 | 验证点 |
|---|------|--------|
| 28 | SIP DIGEST 认证成功 | 正确密码注册成功，写入注册表 |
| 29 | SIP DIGEST 认证失败 | 错误密码返回 401，不暴露分机是否存在 |
| 30 | 注册速率限制 | 超过限制后返回 403 + 告警 |
| 31 | 用户名枚举防护 | 同一 IP 多次失败后临时封禁 |
| 32 | Contact 地址不匹配 | 返回 403 + 告警 |
| 33 | Toll Fraud 检测 | 短时间大量外呼触发自动暂停 |
| 34 | CAC 系统级限制 | 超过全局并发上限后拒绝新呼叫 |
| 35 | CAC 租户级限制 | 超过租户并发上限后拒绝 |
| 36 | CAC 计数器泄漏恢复 | 实例崩溃后重启，计数器自动修复 |
| 37 | SIP 消息注入 | CRLF 注入、Bracket 注入被拦截 |
| 38 | 拓扑隐藏 | 出站消息中内部 Via/Record-Route/自定义头被移除 |
| 39 | SDP 端口越界 | 非 10000-60000 范围的端口被拒绝 |

---

## Appendix A: Redis Key 命名空间

| Key 模式 | 类型 | 用途 | TTL |
|---------|------|------|-----|
| `reg:sip:{aor}` | Hash | SIP 端机注册表 | 按 expires 字段过期 |
| `heartbeat:{service}:{instance_id}` | String | 实例心跳（如 `heartbeat:sipserver:sipserver-03`） | 30s，每 10s 刷新 |
| `cdr:sync:{instance_id}:wal_position` | String | CDR WAL 同步位置 | 无 |
| `session:ws:{session_id}` | Hash | WebSocket 会话信息 | 连接期间 |
| `park:slot:{tenant_id}:{slot}` | Hash | 呼叫驻留槽位 | 300s（可配置） |
| `outbound:channels:{tenant_id}:{ext_id}` | String | 分机外呼并发计数 | 无（手动 DEC） |
| `outbound:channels:{tenant_id}` | String | 租户外呼并发计数 | 无（手动 DEC） |
| `outbound:channels:trunk:{trunk_id}` | String | 中继通道并发计数 | 无（手动 DEC） |
| `cac:system:active` | String | 系统全局并发呼叫计数 | 无（手动 DEC） |
| `cac:tenant:{id}:active` | String | 租户并发呼叫计数 | 无（手动 DEC） |
| `cac:ext:{id}:active` | String | 分机并发呼叫计数 | 无（手动 DEC） |
| `cac:trunk:{id}:active` | String | 中继并发通道计数 | 无（手动 DEC） |
| `cac:calls:{instance_id}` | Hash | 实例活跃呼叫追踪（崩溃恢复用） | 无（定时清理） |
| `conf:bridge:{conf_id}` | Hash | 会议桥状态 | 会议结束后删除 |

---

## Appendix B: Prometheus 指标清单

### 信令指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `sip_calls_total` | Counter | `method`, `response_code`, `site_id` | SIP 请求/响应计数 |
| `sip_calls_active` | Gauge | `site_id`, `instance_id` | 当前活跃呼叫数 |
| `sip_register_total` | Counter | `action`（add/refresh/remove） | 注册事件计数 |
| `sip_register_active` | Gauge | `site_id`, `domain` | 当前活跃注册数 |
| `sip_proxy_duration_seconds` | Histogram | `method` | 代理处理延迟分布 |
| `sip_b2bua_downgrade_total` | Counter | `reason` | B2BUA 降级次数 |
| `ws_connections_active` | Gauge | `site_id`, `instance_id` | 当前活跃 WebSocket 连接数 |
| `ws_messages_total` | Counter | `method`, `direction` | JSON-RPC 消息计数 |
| `ws_handshake_duration_seconds` | Histogram | — | WebSocket 握手 + 认证延迟 |
| `ws_heartbeat_timeout_total` | Counter | `instance_id` | 心跳超时断连次数 |

### 安全指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `sip_auth_failures_total` | Counter | `reason` | SIP 认证失败率 |
| `sip_registration_attacks_total` | Counter | `type` | 伪造注册检测次数 |
| `toll_fraud_alerts_total` | Counter | `scope` | Toll Fraud 检测次数 |
| `cac_denials_total` | Counter | `layer` | CAC 拒绝次数 |
| `sip_firewall_blocks_total` | Counter | `reason` | SIP 防火墙拦截次数 |
| `topology_hidden_total` | Counter | `action` | 拓扑隐藏处理次数 |

### 基础设施指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `redis_command_duration_seconds` | Histogram | `command`, `status` | Redis 命令延迟 |
| `redis_pool_active_connections` | Gauge | — | 连接池活跃连接数 |
| `redis_cache_hit_total` | Counter | `cache` | 本地缓存命中计数 |
| `redis_cache_miss_total` | Counter | `cache` | 本地缓存未命中计数 |
| `cdr_wal_pending` | Gauge | `instance_id` | WAL 中待同步 CDR 条数 |
| `cdr_db_write_duration_seconds` | Histogram | `status` | CDR 写数据库延迟 |
| `tokio_worker_utilization` | Gauge | `instance_id` | Tokio worker 线程利用率 |
| `process_cpu_seconds_total` | Counter | — | 进程 CPU 时间 |
| `process_resident_memory_bytes` | Gauge | — | 进程常驻内存 |

---

## Appendix C: 变更历史

| 版本 | 日期 | 变更说明 |
|------|------|---------|
| 1.0.0 | 2026-09-09 | 初始版本：sipserver/signalserver 核心架构、注册管理、代理逻辑、集群高可用、CDR、监控 |
| 1.1.0 | 2026-09-09 | 补充健康检查、前端监控 API、Prometheus 集成、告警规则、仪表板设计 |
| 1.0.0 (supplement) | 2026-09-09 | 呼叫流程补充：入站/出站呼叫流程、内部分机呼叫特性、SIP 安全访问 |
| **2.0.0** | **2026-09-09** | **合并版本**：将呼叫流程与安全补充文档合并为主文档。关键变更：<br>- 明确路由职责分层：sipserver 本地快速路径 + router-server 复杂路由（gRPC）<br>- 移除 NATS 引用，统一使用 Redis Pub/Sub<br>- 标准化 heartbeat key 格式为 `heartbeat:{service}:{instance_id}`<br>- 标准化 Pub/Sub 频道为 `call:command:{instance_id}` / `call:event:{instance_id}`<br>- 添加 WebSocket 认证跨引用（CTI/IM post-connect auth）<br>- 修正通信矩阵：增加 router-server gRPC 通信<br>- 添加媒体服务器监控代理端点<br>- 统一错误处理增加 router-server 降级策略 |

---

**文档结束**
