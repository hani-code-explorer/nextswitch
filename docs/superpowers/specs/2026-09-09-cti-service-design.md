# CTI Service Design Spec

**Status**: Draft  
**Date**: 2026-09-09  
**Author**: Nextswitch Team

## Change History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-09-09 | Initial draft |
| 2.0.0 | 2026-09-09 | Clarify WebSocket auth rationale (post-connect JSON-RPC vs. pre-connection URL param); add IM service to communication matrix; unify error response format with `error` wrapper and `request_id`; add complete REST API route table; add cti-server port allocation; add health check endpoint; add OpenAPI YAML reference; specify exact protocols for all inter-service communication |

## 1. Overview

### 1.1 Purpose

CTI (Computer Telephony Integration) Service 是 Nextswitch 呼叫中心交换机的核心业务层，提供坐席控制、呼叫管理、自动呼叫分配（ACD）和实时事件推送功能。

### 1.2 Goals

- 为 Web UI（坐席工作台）提供完整的呼叫控制 API
- 为第三方 CRM/业务系统提供标准化集成接口（SDK）
- 为内部自动化流程（预测式外呼、智能路由）提供可编程接口
- 支持智能呼叫分配，提升客户体验和服务效率
- 实时推送呼叫事件和坐席状态变化

### 1.3 Non-Goals

- 不实现 SIP 信令处理（由 sipserver/signalserver 负责）
- 不实现媒体处理（由 medserver 负责）
- 不实现配置管理（由 config-service 负责）
- 不实现用户认证（由 auth-service 负责）

## 2. Architecture

### 2.1 Service Positioning

CTI Service 作为独立微服务部署，通过 API 网关统一对外暴露：

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                               │
│  (Web UI / Third-party CRM / Automation Scripts)            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   nextswitch-api (API Gateway)               │
│  - JWT Authentication                                        │
│  - Rate Limiting                                             │
│  - Request Routing                                           │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    cti-server (CTI Service)                  │
│  - Agent State Management                                    │
│  - Call Control                                              │
│  - ACD (Automatic Call Distribution)                         │
│  - Queue Management                                          │
│  - Event Subscription (WebSocket)                           │
└────────┬─────────────────┬─────────────────┬────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Redis Cluster  │ │  sipserver /    │ │  config-service │
│  - Agent State  │ │  signalserver   │ │  - Agents       │
│  - Queue State  │ │  - Call Control │ │  - Queues       │
│  - Events       │ │  - SIP/WebRTC   │ │  - Skill Groups │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### 2.2 Deployment Model

- **独立进程**：CTI Service 作为独立进程运行（`cti-server`）
- **API 网关代理**：所有外部请求通过 `nextswitch-api` 统一入口
- **内部通信**：
  - 与 sipserver/signalserver：通过 Redis Pub/Sub（详见 2.4 通信矩阵）
  - 与 config-service：通过 Redis Pub/Sub 订阅配置变更
  - 与 auth-service：通过 API Gateway 转发的 JWT 验证
  - 与 medserver：通过 gRPC（MediaService）
  - 与 routing-engine：通过 gRPC（RoutingService）
  - 与 im-server：CTI 提供 gRPC 服务供 im-server 调用；通过 Redis Pub/Sub 发布容量更新

### 2.3 Crate Structure

```
crates/
  nextswitch-cti/
    src/
      lib.rs              # 库入口
      main.rs             # 二进制入口
      config.rs           # 配置加载
      agent/
        mod.rs
        state.rs          # 坐席状态机
        manager.rs        # 坐席管理器
      call/
        mod.rs
        controller.rs     # 呼叫控制器
        bridge.rs         # 与信令层交互
      acd/
        mod.rs
        router.rs         # ACD 路由引擎
        strategy.rs       # 分配策略
        predictor.rs      # 等待时间预测
      queue/
        mod.rs
        manager.rs        # 队列管理器
        stats.rs          # 队列统计
      event/
        mod.rs
        publisher.rs      # 事件发布
        websocket.rs      # WebSocket 服务端
      api/
        mod.rs
        agent.rs          # 坐席 API
        call.rs           # 呼叫 API
        queue.rs          # 队列 API
      error.rs            # 错误定义
```

### 2.4 Port Allocation

| 用途 | 端口 | 协议 |
|------|------|------|
| HTTP API + WebSocket | 8083 | HTTP/1.1, HTTP/2, WS |
| Metrics / Health | 9096 | HTTP |
| gRPC (internal services) | 50051 | gRPC / HTTP/2 |

> WebSocket 与 HTTP API 共用 8083 端口，通过路径区分（`/api/v1/cti/events` 为 WebSocket，其余路径为 REST）。

### 2.5 Health Check

cti-server 在 Metrics/Health 端口（9096）暴露健康检查端点：

```
GET /health
```

**Response**:

```json
{
  "status": "ok",
  "service": "cti-server",
  "version": "0.1.0"
}
```

此端点不经过 API Gateway，用于 Kubernetes liveness/readiness probe 和负载均衡器健康检测。

### 2.6 Inter-Service Communication Matrix

| 调用方 | 被调用方 | 协议 | 详情 |
|--------|---------|------|------|
| nextswitch-api | cti-server | HTTP (8083) | REST API 请求转发 |
| cti-server | sipserver / signalserver | Redis Pub/Sub | `call:command:{instance_id}` 下发命令，`call:event:{instance_id}` 接收事件 |
| cti-server | medserver | gRPC (50051) | MediaService：会议桥创建（CreateConference）、录音控制（StartRecording） |
| cti-server | routing-engine | gRPC (50051) | RoutingService：ACD 队列路由决策 |
| cti-server | config-service | Redis Pub/Sub | 订阅 `config:{tenant_id}:agents`、`config:{tenant_id}:queues` 配置变更 |
| cti-server | Redis | Pub/Sub + Data | 坐席状态存储、队列状态存储、事件发布（`cti:events:{tenant_id}`） |
| im-server | cti-server | gRPC (50051) | 调用 CTI 的 AcdService（会话入队/出队）、ImDispatchService（IM 坐席分配）、AgentCapacityService（坐席容量查询） |
| cti-server | im-server | Redis Pub/Sub | 发布 `im:events:{tenant_id}` 频道，通知坐席容量变更 |

### 2.7 IM Channel Integration

IM（即时通讯）会话与语音呼叫共享 CTI 的 ACD 队列系统。CTI 为 IM 提供以下支持：

**共享 ACD 队列**：IM 会话通过 gRPC 调用 CTI 的 AcdService 入队，与语音呼叫使用相同的分配策略引擎（round_robin、longest_idle、skill_weighted 等）。

**按渠道的坐席容量**：每个坐席在不同渠道的最大并发数可独立配置：

```yaml
agent_capacity:
  voice:
    max_concurrent: 1      # 语音通话同时只能 1 通
  im:
    max_concurrent: 3      # IM 会话最多同时 3 个
```

CTI 通过 `AgentCapacityService` gRPC 接口供 im-server 查询坐席当前容量，决定是否分配新的 IM 会话。

**容量更新通知**：当坐席的 IM 会话数发生变化时，CTI 通过 Redis Pub/Sub 发布容量更新事件：

```
Channel: im:events:{tenant_id}
Message: { "type": "capacity_updated", "agentId": "...", "channel": "im", "currentCount": 2, "maxCount": 3 }
```

**gRPC 服务接口**（CTI 提供，im-server 调用）：

- `AcdService.EnqueueSession` — IM 会话入队
- `AcdService.DequeueSession` — IM 会话出队（分配给坐席或取消）
- `ImDispatchService.DispatchToAgent` — 将 IM 会话分配给指定坐席
- `AgentCapacityService.GetCapacity` — 查询坐席当前容量
- `AgentCapacityService.UpdateCapacity` — 更新坐席容量计数

## 3. Communication Protocols

### 3.1 HTTP API (REST)

**协议**：HTTP/1.1 或 HTTP/2  
**数据格式**：JSON  
**认证**：JWT Bearer Token（通过 API Gateway 验证后转发）

**API 规范**：参见 `docs/superpowers/specs/cti-sdk-openapi-draft.yaml`

#### 3.1.1 Complete Route Table

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/cti/agents/signin` | 坐席签入 |
| POST | `/api/v1/cti/agents/signout` | 坐席签出 |
| GET | `/api/v1/cti/agents/status` | 获取坐席状态 |
| PUT | `/api/v1/cti/agents/state` | 变更坐席状态 |
| POST | `/api/v1/cti/agents/{agentId}/force-state` | 强制变更坐席状态（主管） |
| POST | `/api/v1/cti/calls/make` | 发起呼叫 |
| POST | `/api/v1/cti/calls/{callId}/answer` | 应答呼叫 |
| POST | `/api/v1/cti/calls/{callId}/hangup` | 挂断呼叫 |
| POST | `/api/v1/cti/calls/{callId}/hold` | 保持呼叫 |
| POST | `/api/v1/cti/calls/{callId}/unhold` | 恢复呼叫 |
| POST | `/api/v1/cti/calls/{callId}/transfer` | 转接呼叫 |
| POST | `/api/v1/cti/calls/{callId}/conference` | 发起会议 |
| POST | `/api/v1/cti/calls/{callId}/dtmf` | 发送 DTMF |
| GET | `/api/v1/cti/queues` | 获取队列列表 |
| GET | `/api/v1/cti/queues/{queueId}` | 获取队列详情 |
| GET | `/api/v1/cti/queues/{queueId}/agents` | 获取队列坐席 |
| GET | `/api/v1/cti/queues/{queueId}/calls` | 获取队列呼叫 |
| WS | `/api/v1/cti/events` | WebSocket 事件流 |

> 上表中的路径为完整路径（含 API 网关前缀）。cti-server 内部监听的路径不含 `/api/v1/cti` 前缀，由 API Gateway 统一添加。

#### 3.1.2 Error Response Format

所有 API 错误响应使用统一格式：

```json
{
  "error": {
    "code": "AGENT_NOT_SIGNED_IN",
    "message": "Agent must be signed in to perform this action",
    "details": [
      {
        "field": "agentId",
        "message": "No active session found for this agent"
      }
    ],
    "request_id": "req_abc123def456"
  }
}
```

> **注意**：`request_id` 由 API Gateway 在转发响应时自动附加到后端错误响应中。cti-server 返回的错误响应不包含 `request_id` 字段，由 API Gateway 统一添加以便请求追踪。

`details` 字段为数组，每个元素包含 `field` 和 `message`，用于提供字段级别的错误详情。对于非参数校验类错误，`details` 可为空数组。

### 3.2 WebSocket (Real-time Events)

**协议**：WebSocket (wss://)  
**数据格式**：JSON  
**认证**：JSON-RPC 2.0 风格握手认证

> **与信令服务器认证方式的差异说明**：
>
> 信令服务器（signalserver）使用**连接前 URL 参数认证**（`wss://{host}/ws?token=<token>&extension=<ext>`），因为信令连接需要立即绑定分机号，建立长生命周期连接。
>
> CTI WebSocket 使用**连接后 JSON-RPC 认证**（先连接，再发送 auth 消息），因为：
> 1. Agent SDK 连接需要灵活的认证流程——坐席先用工号/密码登录获取 token，再用 token 建立 WebSocket
> 2. CTI 事件流不需要在连接建立时立即绑定资源，认证可以异步完成
> 3. 支持更丰富的认证错误处理和重连逻辑

**连接流程**：

1. 客户端建立 WebSocket 连接到 `wss://{host}/api/v1/cti/events`（注意：不在 URL 中传递 token）
2. 客户端发送认证请求：
   ```json
   {
     "jsonrpc": "2.0",
     "method": "auth",
     "params": { "token": "<access_token>" },
     "id": 1
   }
   ```
3. 服务端验证 token 并响应：
   ```json
   {
     "jsonrpc": "2.0",
     "result": { "authenticated": true },
     "id": 1
   }
   ```
4. 认证成功后，服务端开始推送事件

**事件类型**：

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
| `queue.call_queued` | 呼叫进入队列 |
| `queue.call_dequeued` | 呼叫离开队列 |
| `queue.stats_updated` | 队列统计更新 |

## 4. Agent State Machine

### 4.1 States

```
                                    ┌─────────────┐
                                    │ signed_out  │
                                    └──────┬──────┘
                                           │ sign_in
                                           ▼
┌─────────┐    break    ┌─────────┐  ready  ┌─────────┐
│  break  │◄────────────│not_ready │◄───────│  ready  │
└────┬────┘             └────┬─────┘        └────┬────┘
     │                       │                   │ call_assigned
     │ end_break             │ set_ready         │
     │                       ▼                   ▼
     │                 ┌─────────┐        ┌─────────┐
     └────────────────►│  ready  │        │  busy   │
                       └─────────┘        └────┬────┘
                                               │ call_ended
                                               ▼
                                        ┌─────────┐
                                        │ wrap_up │
                                        └────┬────┘
                                             │ done
                                             ▼
                                        ┌─────────┐
                                        │  ready  │
                                        └─────────┘
```

**状态说明**：

| 状态 | 描述 | 可接收呼叫 |
|------|------|-----------|
| `signed_out` | 未签入 | 否 |
| `ready` | 就绪，可接收呼叫 | 是 |
| `not_ready` | 未就绪 | 否 |
| `busy` | 通话中 | 否 |
| `wrap_up` | 话后处理 | 否 |
| `break` | 小休（可带原因码） | 否 |
| `monitoring` | 监听中 | 否 |
| `training` | 培训中 | 否 |

### 4.2 State Transitions

**合法转换**：

| 当前状态 | 可转换到 | 触发条件 |
|---------|---------|---------|
| `signed_out` | `ready`, `not_ready` | 坐席签入 |
| `ready` | `busy`, `not_ready`, `break` | 呼叫分配 / 手动变更 |
| `busy` | `wrap_up`, `ready` | 呼叫结束 |
| `wrap_up` | `ready`, `not_ready` | 话后处理完成 |
| `not_ready` | `ready`, `break` | 手动变更 |
| `break` | `ready`, `not_ready` | 小休结束 |

**强制转换**：主管可以强制变更任何坐席的状态（需要 `agent:force_state` 权限）。

### 4.3 State Persistence

坐席状态存储在 Redis 中，支持服务重启后恢复：

```
Key: cti:agent:{agent_id}:state
Type: Hash
Fields:
  - status: AgentStatus
  - reason: string (状态原因码)
  - signed_in_at: timestamp
  - status_changed_at: timestamp
  - skill_groups: JSON array
  - current_call_id: string | null
TTL: None (显式删除)
```

## 5. Call Control

### 5.1 Call Flow

CTI Service 不直接处理 SIP 信令，而是通过 Redis Pub/Sub 与信令层交互：

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  CTI Service │         │    Redis     │         │  sipserver / │
│              │         │  Pub/Sub     │         │ signalserver │
│  make_call() │────────►│ call:command │────────►│              │
│              │         │ :{instance}  │         │  处理 SIP    │
│              │◄────────│ call:event   │◄────────│  INVITE      │
│  on_event()  │         │ :{instance}  │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
```

### 5.2 Supported Operations

| 操作 | 描述 | 信令层交互 |
|------|------|-----------|
| `make` | 发起外呼 | 创建 Leg A（坐席），创建 Leg B（被叫） |
| `answer` | 应答来电 | 发送 200 OK |
| `hangup` | 挂断呼叫 | 发送 BYE |
| `hold` | 保持呼叫 | 发送 re-INVITE with hold SDP |
| `unhold` | 恢复呼叫 | 发送 re-INVITE with original SDP |
| `transfer` (blind) | 盲转 | 发送 REFER |
| `transfer` (consult) | 咨询转 | 创建新 Leg，合并后挂断原 Leg |
| `conference` | 会议 | 请求 medserver 创建媒体桥（gRPC MediaService） |
| `dtmf` | 发送 DTMF | RFC 2833 或 SIP INFO |

### 5.3 Call State Tracking

CTI Service 维护呼叫的 logical state：

```
Key: cti:call:{call_id}
Type: Hash
Fields:
  - call_id: string
  - caller: string
  - callee: string
  - direction: inbound | outbound | internal
  - state: CallState
  - agent_id: string | null
  - queue_id: string | null
  - started_at: timestamp
  - answered_at: timestamp | null
TTL: 24h (after terminated)
```

## 6. ACD (Automatic Call Distribution)

### 6.1 Architecture

ACD 引擎负责将队列中的呼叫分配给最合适的坐席：

```
┌─────────────┐
│  Incoming   │
│    Call     │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│         Queue Manager               │
│  - 呼叫进入队列                      │
│  - 维护等待队列                      │
│  - 计算等待时间                      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         ACD Router                  │
│  - 选择分配策略                      │
│  - 筛选可用坐席                      │
│  - 计算坐席评分                      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│       Strategy Engine               │
│  - Round Robin                      │
│  - Longest Idle                     │
│  - Skill-based Weighted             │
│  - Historical Matching              │
│  - Priority-based                   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      Selected Agent                 │
│  - 状态变更为 busy                   │
│  - 推送呼叫事件                      │
└─────────────────────────────────────┘
```

### 6.2 Distribution Strategies

**内置策略**：

| 策略 | 描述 | 适用场景 |
|------|------|---------|
| `round_robin` | 轮询分配 | 坐席能力相近 |
| `longest_idle` | 最长空闲优先 | 均衡工作量 |
| `skill_weighted` | 技能熟练度加权 | 技能差异大 |
| `historical_match` | 历史匹配（同一客户路由到上次服务的坐席） | 提升客户体验 |
| `priority` | 优先级队列 + VIP 路由 | 差异化服务 |

**策略接口**：

```rust
pub trait DistributionStrategy: Send + Sync {
    /// 计算坐席评分，返回最高评分的坐席
    fn select_agent(
        &self,
        call: &QueuedCall,
        available_agents: &[AgentInfo],
        context: &DistributionContext,
    ) -> Option<AgentSelection>;
}
```

**自定义策略**：通过配置文件或插件机制加载自定义分配策略。

### 6.3 Overflow Handling

当主技能组无可用坐席时，支持溢出到备选技能组：

```yaml
overflow:
  - condition: wait_time > 60s
    target_skill_groups: [backup_sales]
  - condition: queue_size > 10
    target_skill_groups: [backup_sales, support]
  - condition: always
    action: voicemail  # 或 callback
```

### 6.4 Wait Time Prediction

基于历史数据和当前队列状态预测等待时间：

```
predicted_wait = (queue_size * avg_handle_time) / available_agents
```

使用指数加权移动平均（EWMA）平滑历史数据。

## 7. Queue Management

### 7.1 Queue Data Model

```
Key: cti:queue:{queue_id}
Type: Hash
Fields:
  - queue_id: string
  - queue_name: string
  - skill_groups: JSON array
  - strategy: string
  - overflow_config: JSON
TTL: None

Key: cti:queue:{queue_id}:calls
Type: List (sorted by priority, then wait_time)
Members: call_id list

Key: cti:queue:{queue_id}:stats
Type: Hash
Fields:
  - total_calls_today: counter
  - answered_calls_today: counter
  - abandoned_calls_today: counter
  - avg_wait_time_today: EWMA
  - avg_talk_time_today: EWMA
TTL: 24h (reset daily)
```

### 7.2 Queue Events

队列状态变化时发布事件：

- `queue.call_queued` — 呼叫进入队列
- `queue.call_dequeued` — 呼叫离开队列（分配给坐席或放弃）
- `queue.stats_updated` — 队列统计更新（每 5 秒推送一次）

### 7.3 Queue Monitoring API

提供实时队列状态查询：

```
GET /api/v1/cti/queues — 所有队列概览
GET /api/v1/cti/queues/{queueId} — 队列详情（含统计）
GET /api/v1/cti/queues/{queueId}/agents — 队列中的坐席列表
GET /api/v1/cti/queues/{queueId}/calls — 队列中等待的呼叫列表
```

## 8. Event System

### 8.1 Event Publishing

CTI Service 通过 Redis Pub/Sub 发布事件：

```
Channel: cti:events:{tenant_id}
Message: JSON-encoded event
```

### 8.2 WebSocket Server

CTI Service 运行 WebSocket 服务端，订阅 Redis 事件并推送给连接的客户端：

```rust
pub struct WebSocketServer {
    redis_sub: RedisSubscriber,
    connections: DashMap<ConnectionId, WebSocketConnection>,
}

impl WebSocketServer {
    pub async fn run(&self) {
        // 订阅 Redis 事件
        let mut event_stream = self.redis_sub.subscribe("cti:events:*");
        
        while let Some(event) = event_stream.next().await {
            // 广播给所有连接的客户端
            for conn in self.connections.values() {
                conn.send(&event).await;
            }
        }
    }
}
```

### 8.3 Event Filtering

客户端可以订阅特定类型的事件：

```json
{
  "jsonrpc": "2.0",
  "method": "subscribe",
  "params": {
    "events": ["call.ringing", "call.answered", "agent.state_changed"]
  },
  "id": 2
}
```

## 9. SDK Design

### 9.1 SDK Architecture

采用分层策略：

1. **OpenAPI 3.0 规范** — 定义所有 API 接口
2. **TypeScript SDK** — 优先开发，用于 Web 前端
3. **Java SDK** — 用于后端集成
4. **其他语言** — 通过 OpenAPI 代码生成支持

完整的 REST API 和 WebSocket 协议规范请参考 `docs/superpowers/specs/cti-sdk-openapi-draft.yaml`，该文件包含所有接口的请求/响应 Schema 定义，可作为 SDK 代码生成的源文件。

### 9.2 TypeScript SDK Structure

```
sdks/cti-sdk/typescript/
  src/
    index.ts              # 主入口
    cti-client.ts         # CtiClient 主类
    api/
      client.ts           # HTTP 客户端
      agent.ts            # AgentApi
      call.ts             # CallApi
      queue.ts            # QueueApi
    events/
      websocket.ts        # EventSubscriber
      types.ts            # 事件类型定义
    types/
      index.ts            # 类型定义
```

### 9.3 SDK Usage Example

```typescript
import { CtiClient, CtiEventType } from '@nextswitch/cti-sdk';

const client = new CtiClient({
  baseUrl: 'https://api.nextswitch.io/api/v1/cti',
  wsUrl: 'wss://api.nextswitch.io/api/v1/cti/events',
  token: 'your-jwt-token',
});

// 坐席签入
await client.agent.signIn({
  agentId: 'agent_001',
  skillGroups: ['sales', 'support'],
});

// 连接事件流（内部自动完成 JSON-RPC 认证握手）
await client.connectEvents();

// 监听来电
client.events.on(CtiEventType.CallRinging, async (event) => {
  console.log('Incoming call:', event.data.callId);
  await client.call.answer(event.data.callId);
});

// 发起外呼
const call = await client.call.make({ callee: '13800138000' });

// 转接呼叫
await client.call.blindTransfer(call.callId, '8002');
```

## 10. Integration with Existing Services

### 10.1 Config Service

CTI Service 从 Config Service 获取：

- Agent 信息（agent_id, name, skill_groups）
- Queue 配置（queue_id, name, strategy, overflow）
- Skill Group 定义

通过 Redis Pub/Sub 订阅配置变更：

```
Channel: config:{tenant_id}:agents
Channel: config:{tenant_id}:queues
```

### 10.2 Auth Service

CTI Service 依赖 Auth Service 进行：

- JWT Token 验证（通过 API Gateway）
- 权限检查（`agent:signin`, `call:make`, `agent:force_state` 等）

### 10.3 Signaling Server

CTI Service 通过 Redis Pub/Sub 与信令层交互（**不使用 gRPC**）：

**CTI → Signaling**：
```
Channel: call:command:{instance_id}
Commands: make, answer, hangup, hold, unhold, transfer, conference, dtmf
```

**Signaling → CTI**：
```
Channel: call:event:{instance_id}
Events: ringing, answered, terminated, hold, unhold, transferred
```

> `instance_id` 为 sipserver/signalserver 的实例标识，CTI 根据坐席绑定的信令实例选择对应的 command channel 发送指令。

### 10.4 Media Server

CTI Service 通过 **gRPC**（非 Redis Pub/Sub）与 Media Server 交互：

- 创建会议桥（`CreateConference` RPC）
- 启动录音（`StartRecording` RPC）

gRPC 接口定义参见 medserver 的 proto 文件。

### 10.5 Routing Engine

CTI Service 通过 **gRPC** 与 Routing Engine 交互：

- `RoutingService.Route` — ACD 队列路由决策，传入呼叫信息和队列配置，返回路由结果（目标坐席或溢出策略）

### 10.6 IM Server

CTI Service 与 IM Server 的集成详见 2.7 节。核心交互模式：

- **im-server → cti-server**：gRPC 调用 AcdService、ImDispatchService、AgentCapacityService
- **cti-server → im-server**：Redis Pub/Sub 发布 `im:events:{tenant_id}` 容量变更通知

## 11. Scalability and High Availability

### 11.1 Horizontal Scaling

CTI Service 支持多实例部署：

- 坐席状态存储在 Redis，所有实例共享
- WebSocket 连接绑定到特定实例，通过 Redis Pub/Sub 广播事件
- API 请求通过 API Gateway 负载均衡

### 11.2 Instance Heartbeat

```
Key: heartbeat:cti:{instance_id}
Type: Hash
Fields:
  - started_at: timestamp
  - active_agents: counter
  - active_calls: counter
  - websocket_connections: counter
TTL: 30s (refresh every 10s)
```

### 11.3 Graceful Shutdown

服务关闭时：

1. 停止接受新的 WebSocket 连接
2. 向所有 WebSocket 客户端发送关闭通知
3. 等待当前 API 请求处理完成
4. 清理 Redis 中的实例心跳

## 12. Observability

### 12.1 Metrics

Prometheus metrics：

```
cti_agents_total{status="ready"} 42
cti_agents_total{status="busy"} 18
cti_calls_active 15
cti_calls_total{direction="inbound"} 1234
cti_calls_total{direction="outbound"} 567
cti_queue_waiting_call{queue_id="sales"} 3
cti_queue_avg_wait_time_seconds{queue_id="sales"} 45.2
cti_websocket_connections_active 89
cti_acd_calls_assigned_total{strategy="round_robin"} 890
```

### 12.2 Tracing

OpenTelemetry tracing：

- Span: `cti.agent.signin`
- Span: `cti.call.make`
- Span: `cti.acd.assign`
- Span: `cti.event.publish`

### 12.3 Logging

结构化 JSON 日志：

```json
{
  "timestamp": "2026-09-09T10:30:00Z",
  "level": "INFO",
  "service": "cti-server",
  "instance_id": "cti-001",
  "tenant_id": "tenant_123",
  "agent_id": "agent_001",
  "event": "agent.state_changed",
  "from_state": "ready",
  "to_state": "busy",
  "call_id": "call_abc123"
}
```

## 13. Security

### 13.1 Authentication

- 所有 API 请求需要有效的 JWT Token
- WebSocket 连接需要 JSON-RPC 认证（详见 3.2 节）
- Token 由 Auth Service 签发，CTI Service 验证签名

### 13.2 Authorization

基于 RBAC 的权限控制：

| 权限 | 描述 |
|------|------|
| `agent:signin` | 坐席签入 |
| `agent:signout` | 坐席签出 |
| `agent:change_state` | 变更自己的状态 |
| `agent:force_state` | 强制变更他人状态（主管） |
| `call:make` | 发起呼叫 |
| `call:answer` | 应答呼叫 |
| `call:hangup` | 挂断呼叫 |
| `call:transfer` | 转接呼叫 |
| `call:conference` | 创建会议 |
| `queue:view` | 查看队列状态 |
| `queue:manage` | 管理队列配置 |

### 13.3 Data Isolation

- 多租户数据隔离（通过 `tenant_id`）
- 坐席只能操作自己租户的资源
- WebSocket 事件按租户过滤

## 14. Testing Strategy

### 14.1 Unit Tests

- 坐席状态机转换逻辑
- ACD 分配策略
- 队列管理逻辑
- 等待时间预测算法

### 14.2 Integration Tests

- API 端点测试（使用 test client）
- Redis 交互测试（使用 test container）
- WebSocket 连接和事件推送测试

### 14.3 End-to-End Tests

- 完整呼叫流程（签入 → 接call → 转接 → 签出）
- 多坐席并发场景
- 队列溢出场景

### 14.4 SDK Automation Tests

提供 SDK 自动化测试脚本模板：

```typescript
import { CtiClient } from '@nextswitch/cti-sdk';

describe('CTI Integration', () => {
  it('should complete a full call flow', async () => {
    const client = new CtiClient({ ... });
    
    // 签入
    await client.agent.signIn({ agentId: 'test_agent', skillGroups: ['test'] });
    
    // 等待来电
    const callPromise = waitForEvent(client, CtiEventType.CallRinging);
    const call = await callPromise;
    
    // 应答
    await client.call.answer(call.data.callId);
    
    // 转接
    await client.call.blindTransfer(call.data.callId, 'backup_agent');
    
    // 签出
    await client.agent.signOut();
  });
});
```

## 15. Demo Projects

### 15.1 Demo Structure

```
demo/
  agent-workbench/      # 完整坐席工作台参考实现
  call-transfer/        # 转接场景演示
  conference/           # 会议场景演示
  queue-monitor/        # 队列监控演示
  webhook-receiver/     # Webhook 回调接收演示
```

### 15.2 Agent Workbench Demo

功能：
- 签入/签出
- 状态切换（就绪/未就绪/小休）
- 拨号盘
- 通话控制（应答/挂断/保持/转接）
- 实时状态显示
- 事件日志

技术栈：
- HTML + CSS + JavaScript
- @nextswitch/cti-sdk

### 15.3 Scenario Demos

每个场景独立可运行，展示特定功能：

- **call-transfer**：演示盲转和咨询转
- **conference**：演示三方会议
- **queue-monitor**：实时显示队列统计和等待呼叫
- **webhook-receiver**：接收并显示 Webhook 回调

## 16. Implementation Phases

### Phase 1: Core Agent Management

- 坐席状态机
- 签入/签出 API
- 状态变更 API
- Redis 状态存储

### Phase 2: Call Control

- 与信令层集成（Redis Pub/Sub）
- 呼叫控制 API（make, answer, hangup, hold, unhold）
- 转接和会议

### Phase 3: ACD and Queue Management

- 队列管理器
- ACD 路由引擎
- 内置分配策略
- 队列监控 API

### Phase 4: Event System

- WebSocket 服务端
- 事件发布/订阅
- JSON-RPC 认证

### Phase 5: SDK and Demo

- TypeScript SDK
- Java SDK
- Demo 项目

### Phase 6: Advanced Features

- 高级 ACD 策略（历史匹配、预测等待时间）
- 溢出处理
- 自定义策略插件

## 17. Appendix

### 17.1 Redis Key Namespace

```
cti:agent:{agent_id}:state      # 坐席状态
cti:call:{call_id}              # 呼叫状态
cti:queue:{queue_id}            # 队列配置
cti:queue:{queue_id}:calls      # 队列中的呼叫
cti:queue:{queue_id}:stats      # 队列统计
heartbeat:cti:{instance_id}     # 实例心跳
```

### 17.2 Error Codes

| Code | Description |
|------|-------------|
| `AGENT_NOT_FOUND` | 坐席不存在 |
| `AGENT_ALREADY_SIGNED_IN` | 坐席已签入 |
| `AGENT_NOT_SIGNED_IN` | 坐席未签入 |
| `INVALID_STATE_TRANSITION` | 非法状态转换 |
| `CALL_NOT_FOUND` | 呼叫不存在 |
| `CALL_NOT_ANSWERABLE` | 呼叫不可应答 |
| `QUEUE_NOT_FOUND` | 队列不存在 |
| `PERMISSION_DENIED` | 权限不足 |
| `AUTHENTICATION_FAILED` | 认证失败 |

### 17.3 OpenAPI Specification Reference

完整的 REST API 和 WebSocket 协议规范定义在 `docs/superpowers/specs/cti-sdk-openapi-draft.yaml` 文件中。该文件遵循 OpenAPI 3.0.3 规范，包含：

- 所有 REST 端点的请求/响应 Schema
- 统一的错误响应格式（`error` 包裹，含 `code`、`message`、`details`、`request_id`）
- WebSocket 事件流的认证流程和事件格式说明
- 坐席状态枚举、呼叫信息、队列状态等核心数据模型

此 YAML 文件可作为以下用途的源文件：
- SDK 代码生成（TypeScript、Java 等）
- API 文档自动生成（Swagger UI、Redoc）
- API 自动化测试（基于 Schema 的契约测试）

### 17.4 References

- OpenAPI Spec: `docs/superpowers/specs/cti-sdk-openapi-draft.yaml`
- TypeScript SDK: `sdks/cti-sdk/typescript/`
- Signaling Server Design: `docs/superpowers/specs/2026-09-09-signaling-server-design.md`
- Config & Gateway Design: `docs/superpowers/specs/2026-09-09-config-and-gateway-design.md`
- Platform Security Design: `docs/superpowers/specs/2026-09-09-platform-security-design.md`
