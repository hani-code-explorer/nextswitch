# IM Service Design Spec

**Status**: Draft  
**Date**: 2026-09-09  
**Author**: Nextswitch Team

## 1. Overview

### 1.1 Purpose

IM Service 是 Nextswitch 呼叫中心交换机的即时通讯模块，提供全渠道客服能力。客户可以通过 Web Chat、微信公众号、WhatsApp 等渠道发起聊天，坐席在工作台统一处理。

### 1.2 Goals

- 提供全渠道客服能力，支持 Web Chat、微信、WhatsApp 等渠道
- 设计统一的渠道抽象层，便于扩展新渠道
- IM 会话与语音呼叫统一排队，共用 ACD 分配策略
- 支持按渠道配置坐席并发能力（语音默认 1，IM 可配置多个）
- 完整消息历史持久化，支持历史查看、质检、续聊关联
- 支持完整富媒体消息（文本、图片、文件、语音、视频、位置、卡片）
- 集成大模型对话能力，支持纯 AI 客服、人机协作、AI 辅助

### 1.3 Non-Goals

- 不实现 SIP 信令处理（由 sipserver/signalserver 负责）
- 不实现媒体处理（由 medserver 负责）
- 不实现配置管理（由 config-service 负责）
- 不实现用户认证（由 auth-service 负责）
- 不实现 ACD 核心逻辑（由 cti-server 负责）

## 2. Architecture

### 2.1 Service Positioning

IM Service 作为独立微服务部署（`im-server`），与 CTI Service 混合部署模式：
- CTI Service 保留核心 ACD/队列逻辑
- IM Service 作为独立进程，通过 gRPC 与 CTI 深度集成
- 所有外部请求通过 `nextswitch-api` 统一入口（包括 HTTP 和 WebSocket）

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Clients                                     │
│  (Web Chat Widget / 微信公众号 / 小程序 / WhatsApp / App)           │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      nextswitch-api (API Gateway)                    │
│  - JWT Authentication / Rate Limiting / Request Routing             │
│  - WebSocket Proxy (支持长连接代理)                                  │
└─────────────┬───────────────────────────────────┬───────────────────┘
              │                                   │
              ▼                                   ▼
┌─────────────────────────────┐     ┌─────────────────────────────────┐
│      cti-server             │     │         im-server               │
│  ┌───────────────────────┐  │     │  ┌───────────────────────────┐  │
│  │  Voice Module         │  │     │  │   Channel Adapters        │  │
│  │  - SIP/WebRTC Control │  │     │  │   - WebChat Adapter       │  │
│  └───────────┬───────────┘  │     │  │   - WeChat Adapter        │  │
│              │              │     │  │   - WhatsApp Adapter       │  │
│  ┌───────────▼───────────┐  │     │  └─────────────┬─────────────┘  │
│  │   ACD Core            │◄─┼─────┼────────────────┤                │
│  │  - Queue Manager      │  │     │  ┌─────────────▼─────────────┐  │
│  │  - Distribution       │  │     │  │   Message Handler         │  │
│  │  - Agent State        │  │     │  │   - Routing               │  │
│  └───────────────────────┘  │     │  │   - Persistence           │  │
│              │              │     │  │   - Rich Media Processing   │  │
│              │              │     │  └─────────────┬─────────────┘  │
│              │              │     │  ┌─────────────▼─────────────┐  │
│              │              │     │  │   Session Manager         │  │
│              │              │     │  │   - Lifecycle             │  │
│              │              │     │  │   - Customer Binding      │  │
│              │              │     │  └───────────────────────────┘  │
│              │              │     └─────────────┬───────────────────┘
│              │              │                   │
└──────────────┼──────────────┘                   │
               │                                   │
               └───────────────┬───────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   gRPC / Redis      │
                    │   - 排队请求        │
                    │   - 坐席分配        │
                    │   - 事件同步        │
                    └─────────────────────┘
```

### 2.2 Deployment Model

- **独立进程**：IM Service 作为独立进程运行（`im-server`）
- **API 网关代理**：所有外部请求（HTTP + WebSocket）通过 `nextswitch-api` 统一入口
- **内部通信**：
  - 与 cti-server：通过 gRPC 进行排队请求、坐席分配、容量查询
  - 事件同步：通过 Redis Pub/Sub 同步坐席状态、会话事件

### 2.3 Crate Structure

```
crates/
  nextswitch-im/
    src/
      lib.rs                    # 库入口
      main.rs                   # 二进制入口
      config.rs                 # 配置加载
      
      channel/                  # 渠道抽象层
        mod.rs
        adapter.rs              # ChannelAdapter trait
        types.rs                # InboundMessage, OutboundMessage, MessageContent
        identity.rs             # CustomerIdentity, ChannelIdentity
        webchat/
          mod.rs
          adapter.rs            # WebChat Adapter 实现
          handler.rs            # HTTP/WebSocket 处理
        wechat/                 # 预留
          mod.rs
        whatsapp/               # 预留
          mod.rs
        registry.rs             # 渠道注册与路由
      
      session/                  # 会话管理
        mod.rs
        manager.rs              # SessionManager
        state.rs                # 会话状态机
        timeout.rs              # 空闲超时检查
        store.rs                # 会话存储接口
      
      message/                  # 消息处理
        mod.rs
        handler.rs              # 消息路由、分发
        content.rs              # 消息内容处理
        media.rs                # 富媒体上传/下载
        store.rs                # 消息存储接口
      
      cti/                      # CTI 集成
        mod.rs
        client.rs               # gRPC Client (调用 cti-server)
        server.rs               # gRPC Server (接收 cti-server 回调)
        proto/                  # protobuf 定义
          cti.proto
        sync.rs                 # 事件同步（Redis Pub/Sub）
      
      ai/                       # AI 模块
        mod.rs
        router.rs               # AI 路由器
        session.rs              # AI 会话管理
        provider/               # LLM 提供商
          mod.rs
          traits.rs             # LlmProvider trait
          openai.rs             # OpenAI / GPT
          claude.rs             # Anthropic Claude
          qwen.rs               # 通义千问
          wenxin.rs             # 文心一言
        knowledge/              # 知识库
          mod.rs
          base.rs               # KnowledgeBase trait
          vector.rs             # 向量检索
          faq.rs                # FAQ 匹配
        assist/                 # AI 辅助（坐席侧）
          mod.rs
          suggest.rs            # 智能回复建议
          search.rs             # 知识库查询
          summary.rs            # 对话摘要
        prompt/                 # Prompt 管理
          mod.rs
          template.rs           # Prompt 模板
          builder.rs            # Prompt 构建器
      
      storage/                  # 存储层
        mod.rs
        mysql/
          mod.rs
          session.rs            # 会话表操作
          message.rs            # 消息表操作
          customer.rs           # 客户历史表操作
          migration.rs          # 数据库迁移
        redis/
          mod.rs
          cache.rs              # 活跃会话缓存
          unread.rs             # 未读计数
      
      api/                      # 对外 API
        mod.rs
        session.rs              # 会话 API
        message.rs              # 消息 API
        media.rs                # 文件上传 API
        widget.rs               # Web Chat Widget API
        websocket.rs            # WebSocket 事件推送
        middleware/             # API 中间件
          mod.rs
          auth.rs               # JWT 验证
          tracing.rs            # 请求追踪
          error_handler.rs      # 统一错误处理
          rate_limit.rs         # 限流
      
      error/                    # 错误处理模块
        mod.rs                  # 错误类型定义
        api.rs                  # API 错误 → HTTP 响应
        grpc.rs                 # gRPC 错误映射
        storage.rs              # 存储层错误
        channel.rs              # 渠道错误
      
      tracing/                  # 追踪与可观测性
        mod.rs
        spans.rs                # 预定义 span 名称
        metrics.rs              # Prometheus metrics
        logging.rs              # 结构化日志格式
        context.rs              # 追踪上下文
      
      health/                   # 健康检查
        mod.rs
        checker.rs              # 健康检查逻辑
        handler.rs              # /health, /ready 端点
      
      error.rs                  # 顶层错误 re-export
```

## 3. Channel Abstraction Layer

### 3.1 Architecture

渠道抽象层是 IM Service 的核心，负责屏蔽各渠道的协议差异，提供统一的消息模型。

```
┌─────────────────────────────────────────────────────────────────┐
│                     Channel Adapter Layer                        │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  WebChat    │  │   WeChat    │  │  WhatsApp   │  ...       │
│  │  Adapter    │  │   Adapter   │  │   Adapter   │            │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
│         │                │                │                     │
│         └────────────────┴────────────────┘                     │
│                          │                                      │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │              Unified Message Interface                    │ │
│  │  - InboundMessage (渠道 → 系统)                          │ │
│  │  - OutboundMessage (系统 → 渠道)                         │ │
│  │  - ChannelContext (渠道上下文、身份信息)                   │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Core Traits

```rust
/// 渠道适配器接口
#[async_trait]
pub trait ChannelAdapter: Send + Sync {
    /// 渠道类型标识
    fn channel_type(&self) -> ChannelType;
    
    /// 接收渠道消息，转换为统一格式
    async fn receive(&self, raw: RawMessage) -> Result<InboundMessage>;
    
    /// 将系统消息发送到渠道
    async fn send(&self, msg: OutboundMessage, ctx: &ChannelContext) -> Result<()>;
    
    /// 解析渠道特有的身份信息
    fn extract_identity(&self, raw: &RawMessage) -> CustomerIdentity;
    
    /// 渠道健康检查
    async fn health_check(&self) -> Result<()>;
}

/// 统一入站消息
pub struct InboundMessage {
    pub message_id: MessageId,
    pub channel_type: ChannelType,
    pub channel_message_id: String,      // 渠道原始消息 ID
    pub session_id: SessionId,           // 关联的会话 ID（可能新建）
    pub customer_identity: CustomerIdentity,
    pub content: MessageContent,         // 统一消息内容
    pub metadata: Metadata,              // 渠道特有元数据
    pub received_at: Timestamp,
}

/// 统一出站消息
pub struct OutboundMessage {
    pub message_id: MessageId,
    pub session_id: SessionId,
    pub agent_id: AgentId,
    pub content: MessageContent,
    pub reply_to: Option<MessageId>,     // 回复的消息
}

/// 统一消息内容（富媒体）
pub enum MessageContent {
    Text(TextContent),
    Image(ImageContent),
    File(FileContent),
    Audio(AudioContent),
    Video(VideoContent),
    Location(LocationContent),
    Card(CardContent),                   // 自定义卡片
    Mixed(Vec<MessageContent>),          // 混合消息
}
```

### 3.3 Channel Configuration

```yaml
# im-server 配置
channels:
  webchat:
    enabled: true
    config:
      widget_url: "https://chat.example.com/widget.js"
      session_timeout: 30m
      allowed_origins: ["*.example.com"]
      
  wechat:
    enabled: true
    config:
      app_id: "${WECHAT_APP_ID}"
      app_secret: "${WECHAT_APP_SECRET}"
      token: "${WECHAT_TOKEN}"
      encoding_aes_key: "${WECHAT_AES_KEY}"
      
  whatsapp:
    enabled: false
    config:
      business_account_id: "${WHATSAPP_BIZ_ID}"
      access_token: "${WHATSAPP_TOKEN}"
```

### 3.4 Identity Recognition

```rust
pub struct CustomerIdentity {
    pub customer_id: Option<CustomerId>,      // 已识别的客户 ID
    pub channel_identity: ChannelIdentity,    // 渠道绑定身份
    pub is_anonymous: bool,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub enum ChannelIdentity {
    WebChat { session_token: String, fingerprint: String },
    WeChat { openid: String, unionid: Option<String> },
    WhatsApp { phone_number: String },
    App { user_id: String },
}
```

## 4. Session Lifecycle

### 4.1 State Machine

IM 会话的生命周期类似语音呼叫，但增加了空闲超时和续聊机制。

```
                                    ┌─────────────┐
                                    │   created   │
                                    └──────┬──────┘
                                           │ 客户发起消息
                                           ▼
                                    ┌─────────────┐
                                    │   queued    │
                                    └──────┬──────┘
                                           │ ACD 分配坐席
                                           ▼
┌─────────┐  超时   ┌─────────┐  应答   ┌─────────┐
│ timeout │◄────────│ assigned │◄───────│ active  │
└────┬────┘         └─────────┘        └────┬────┘
     │                                       │
     │                                       │ 空闲 N 分钟
     │                                       ▼
     │                                ┌─────────┐
     │                                │  idle   │
     │                                └────┬────┘
     │                                     │
     │            ┌────────────────────────┤
     │            │ 客户再次发消息         │ 超时
     │            ▼                        ▼
     │     ┌─────────┐              ┌─────────┐
     │     │ active  │              │ closed  │
     │     └─────────┘              └─────────┘
     │                                       │
     └───────────────────────────────────────┘
```

**状态说明**：

| 状态 | 描述 | 触发条件 |
|------|------|----------|
| `created` | 会话刚创建 | 收到客户首条消息 |
| `queued` | 排队等待分配 | 进入 ACD 队列 |
| `assigned` | 已分配坐席，等待应答 | ACD 选出坐席 |
| `active` | 对话进行中 | 坐席应答或客户发消息 |
| `idle` | 空闲中（等待客户回复） | 超过 N 分钟无新消息 |
| `closed` | 会话结束 | 空闲超时 / 任一方主动结束 |
| `timeout` | 超时关闭 | 长时间无活动 |

### 4.2 Session Data Model

```rust
pub struct ImSession {
    pub session_id: SessionId,
    pub tenant_id: TenantId,
    
    // 客户信息
    pub customer: CustomerIdentity,
    pub customer_history_id: CustomerHistoryId,  // 关联的客户历史记录
    
    // 坐席信息
    pub agent_id: Option<AgentId>,
    pub assigned_at: Option<Timestamp>,
    pub answered_at: Option<Timestamp>,
    
    // 状态
    pub state: SessionState,
    pub channel_type: ChannelType,
    
    // 时间控制
    pub created_at: Timestamp,
    pub last_message_at: Timestamp,
    pub idle_since: Option<Timestamp>,
    pub closed_at: Option<Timestamp>,
    
    // 配置
    pub idle_timeout: Duration,       // 空闲超时（默认 5 分钟）
    pub max_duration: Duration,       // 最大会话时长（可选）
    
    // 关联
    pub queue_id: Option<QueueId>,
    pub messages: Vec<MessageId>,     // 消息 ID 列表
}
```

### 4.3 Session Timeout and Continuation

```rust
/// 会话管理器
pub struct SessionManager {
    idle_timeout: Duration,           // 默认 5 分钟
    session_store: SessionStore,
}

impl SessionManager {
    /// 处理客户新消息
    pub async fn on_customer_message(&self, msg: InboundMessage) -> Result<SessionAction> {
        // 1. 查找该客户的活跃会话
        if let Some(session) = self.find_active_session(&msg.customer).await? {
            // 2a. 有活跃会话：如果是 idle 状态，恢复为 active
            if session.state == SessionState::Idle {
                self.resume_session(&session.id).await?;
                return Ok(SessionAction::ResumeAndDeliver(session.id));
            }
            return Ok(SessionAction::DeliverToAgent(session.id));
        }
        
        // 2b. 无活跃会话：创建新会话，但关联到同一客户历史记录
        let history_id = self.get_or_create_customer_history(&msg.customer).await?;
        let new_session = self.create_session(msg, history_id).await?;
        Ok(SessionAction::CreateAndQueue(new_session))
    }
    
    /// 检查空闲超时
    pub async fn check_idle_timeout(&self) {
        // 定期扫描 idle 状态的会话
        let expired = self.session_store.find_idle_expired(self.idle_timeout).await;
        for session in expired {
            self.close_session(&session.id, CloseReason::IdleTimeout).await;
        }
    }
}
```

### 4.4 Customer History

```
Key: im:customer_history:{customer_id}
Type: Hash
Fields:
  - customer_id: string
  - channel_identities: JSON array (各渠道身份)
  - first_contact_at: timestamp
  - last_contact_at: timestamp
  - total_sessions: counter
  - tags: JSON array (VIP、投诉客户等)

Key: im:customer_history:{customer_id}:sessions
Type: Sorted Set (score = created_at)
Members: session_id list
```

## 5. CTI Integration

### 5.1 Integration Architecture

IM 与语音共享 ACD 核心，通过 gRPC 实现服务间通信。

```
┌─────────────────────────────────────────────────────────────────┐
│                        im-server                                 │
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  Channel    │    │   Message   │    │   CTI Integration   │ │
│  │  Adapters   │───►│   Handler   │───►│   Client (gRPC)     │ │
│  └─────────────┘    └─────────────┘    └──────────┬──────────┘ │
└────────────────────────────────────────────────────┼────────────┘
                                                     │
                                                     │ gRPC
                                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        cti-server                                │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    ACD Core                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │  │
│  │  │   Queue     │  │  Router /   │  │   Agent State   │ │  │
│  │  │   Manager   │  │  Strategy   │  │   Manager       │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌───────────────────────────┼──────────────────────────────┐  │
│  │  Interaction Router       │                              │  │
│  │  ┌─────────────┐  ┌──────▼──────┐  ┌─────────────────┐ │  │
│  │  │   Voice     │  │   Unified   │  │    IM           │ │  │
│  │  │   Handler   │  │   Queue     │  │    Handler      │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 gRPC Service Definition

```protobuf
// cti.proto — CTI 与 IM 之间的服务接口

// ============================================
// IM → CTI
// ============================================
service AcdService {
    // 请求排队
    rpc EnqueueSession(EnqueueRequest) returns (EnqueueResponse);
    
    // 取消排队（客户离开 / 超时）
    rpc DequeueSession(DequeueRequest) returns (DequeueResponse);
    
    // 查询队列位置
    rpc GetQueuePosition(QueuePositionRequest) returns (QueuePositionResponse);
    
    // 会话结束，释放坐席容量
    rpc NotifySessionClosed(SessionClosedNotification) returns (SessionClosedAck);
    
    // 坐席主动结束会话（进入 wrap_up）
    rpc NotifyAgentClosedSession(AgentClosedSessionNotification) returns (AgentClosedSessionAck);
    
    // 请求转接会话
    rpc TransferSession(TransferSessionRequest) returns (TransferSessionResponse);
    
    // 查询队列实时统计
    rpc GetQueueStats(QueueStatsRequest) returns (QueueStatsResponse);
}

// ============================================
// CTI → IM
// ============================================
service ImDispatchService {
    // 分配坐席
    rpc DispatchAgent(DispatchRequest) returns (DispatchResponse);
    
    // 强制关闭会话（主管操作）
    rpc ForceCloseSession(ForceCloseRequest) returns (ForceCloseResponse);
    
    // 转接目标确认（协商转接中，目标坐席接受/拒绝）
    rpc NotifyTransferResult(TransferResultNotification) returns (TransferResultAck);
}

// ============================================
// 坐席容量（CTI ↔ IM 双向查询）
// ============================================
service AgentCapacityService {
    // 查询坐席容量
    rpc GetAgentCapacity(CapacityRequest) returns (CapacityResponse);
    
    // 容量变更通知（IM 侧会话状态变化时主动通知 CTI）
    rpc NotifyCapacityChanged(CapacityChangedNotification) returns (CapacityChangedAck);
}

// ============================================
// 消息定义
// ============================================

message EnqueueRequest {
    int64 tenant_id = 1;
    string session_id = 2;            // UUID
    string interaction_type = 3;      // "voice" | "im"
    string channel_type = 4;          // "webchat" | "wechat" | ...
    string customer_id = 5;           // 可选，已识别客户
    int64 queue_id = 6;               // 目标队列
    int32 priority = 7;               // 优先级（0=普通，越高越优先）
    map<string, string> attributes = 8;  // 路由属性（VIP 标签等）
}

message EnqueueResponse {
    int64 queue_id = 1;
    int32 position = 2;
    int64 estimated_wait_seconds = 3;
}

message DispatchRequest {
    int64 tenant_id = 1;
    string session_id = 2;            // UUID
    int64 agent_id = 3;
    int64 queue_id = 4;
    int64 wait_time_seconds = 5;
}

message CapacityRequest {
    int64 tenant_id = 1;
    int64 agent_id = 2;
}

message CapacityResponse {
    int32 voice_max = 1;
    int32 voice_current = 2;
    int32 im_max = 3;
    int32 im_current = 4;
    bool can_accept_voice = 5;
    bool can_accept_im = 6;
}

message SessionClosedNotification {
    int64 tenant_id = 1;
    string session_id = 2;            // UUID
    int64 agent_id = 3;
    string close_reason = 4;
    int32 total_messages = 5;
    int64 duration_seconds = 6;
}

message TransferSessionRequest {
    int64 tenant_id = 1;
    string session_id = 2;            // UUID
    int64 from_agent_id = 3;
    oneof target {
        int64 to_agent_id = 4;
        int64 to_queue_id = 5;
    }
    string transfer_type = 6;          // "blind" | "consult"
    string reason = 7;
}

message QueueStatsRequest {
    int64 tenant_id = 1;
    int64 queue_id = 2;
}

message QueueStatsResponse {
    int64 queue_id = 1;
    int32 waiting_voice = 2;
    int32 waiting_im = 3;
    int64 avg_wait_seconds = 4;
    int64 longest_wait_seconds = 5;
    int32 available_agents = 6;
    double sla_20s = 7;
}

message CapacityChangedNotification {
    int64 tenant_id = 1;
    int64 agent_id = 2;
    int32 voice_current = 3;
    int32 im_current = 4;
    string changed_reason = 5;
}
```

### 5.3 Unified Queue Flow

```
客户发起 IM 消息
        │
        ▼
┌───────────────────┐
│   im-server       │
│ 1. 创建/恢复会话   │
│ 2. 确定目标队列    │
└────────┬──────────┘
         │ gRPC: EnqueueSession
         ▼
┌───────────────────┐
│   cti-server      │
│ 3. 进入统一队列    │
│ 4. ACD 选择坐席    │
│    - 查询坐席容量  │  ← gRPC: GetAgentCapacity (回调 im-server)
│    - 检查 IM 并发  │
│    - 计算评分      │
│ 5. 分配坐席        │
└────────┬──────────┘
         │ gRPC: DispatchAgent
         ▼
┌───────────────────┐
│   im-server       │
│ 6. 更新会话状态    │
│ 7. 通知坐席        │  ← WebSocket 推送
│ 8. 开始消息路由    │
└───────────────────┘
```

### 5.4 Agent Capacity Control

```yaml
# 配置示例：坐席并发能力
agent_capacity:
  defaults:
    voice_max: 1
    im_max: 3
  overrides:
    - agent_group: "senior"
      voice_max: 1
      im_max: 5
    - agent_group: "trainee"
      voice_max: 1
      im_max: 1
```

### 5.5 Event Synchronization

IM 会话事件通过 Redis Pub/Sub 同步到 CTI，统一推送到 WebSocket：

```
# im-server 发布事件（tenant_id 为 BIGINT，非 UUID 字符串）
Channel: im:events:{tenant_id}
Events:
  - session.created
  - session.queued
  - session.assigned
  - session.active
  - session.idle
  - session.closed
  - message.received
  - message.sent

# cti-server 订阅并转发到 WebSocket
cti-server 订阅 im:events:* → 转换为统一事件格式 → 推送到坐席 WebSocket
```

## 6. Monitoring

### 6.1 Monitoring Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Monitoring Layer                              │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │  Metrics Export  │  │  Real-time Push  │  │  Audit / Quality │ │
│  │  (Prometheus)    │  │  (WebSocket)     │  │  (Storage)       │ │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘ │
└───────────┼─────────────────────┼─────────────────────┼───────────┘
            │                     │                     │
     ┌──────┴──────┐       ┌──────┴──────┐       ┌──────┴──────┐
     │ cti-server  │       │ im-server   │       │  Grafana /  │
     │ + im-server │       │ + cti-server│       │  Web UI     │
     └─────────────┘       └─────────────┘       └─────────────┘
```

### 6.2 Unified Metrics

```
# 坐席总览（语音 + IM 合并）
cti_agents_total{status="ready"} 42
cti_agents_total{status="busy_voice"} 10
cti_agents_total{status="busy_im"} 25
cti_agents_total{status="busy_mixed"} 8
cti_agents_total{status="wrap_up"} 5
cti_agents_total{status="break"} 3

# 队列总览
cti_queue_waiting_total{type="voice"} 5
cti_queue_waiting_total{type="im"} 12
cti_queue_avg_wait_seconds{type="voice"} 30
cti_queue_avg_wait_seconds{type="im"} 15

# 会话/呼叫活跃度
cti_active_interactions{type="voice"} 18
cti_active_interactions{type="im"} 67
cti_interactions_total{type="voice",direction="inbound"} 1234
cti_interactions_total{type="im",direction="inbound"} 5678

# IM 专属指标
im_messages_total{direction="inbound"} 45678
im_messages_total{direction="outbound"} 38901
im_sessions_total{state="active"} 67
im_sessions_total{state="idle"} 23
im_session_avg_duration_seconds 480
im_idle_timeout_total 156
im_channels_active{channel="webchat"} 45
im_channels_active{channel="wechat"} 22

# IM 渠道健康
im_channel_messages_received_total{channel="webchat"} 30000
im_channel_errors_total{channel="wechat",error="timeout"} 12
im_channel_latency_seconds{channel="webchat",quantile="0.99"} 0.3
```

### 6.3 Real-time Events

```
// 已有语音事件（不变）
call.ringing / call.answered / call.terminated / ...

// 新增 IM 事件
im.session.created
im.session.queued
im.session.assigned
im.session.active
im.session.idle
im.session.closed
im.message.received
im.message.sent

// 新增统一监控事件
monitor.queue_stats_updated
monitor.agent_utilization
monitor.service_level
monitor.wait_time_breach
```

### 6.4 Supervisor Monitoring API

```
# 全局监控面板
GET /api/v1/monitoring/im/overview
  → {
      agents: { total: 80, ready: 42, busy_voice: 10, busy_im: 25, break: 3 },
      queues: [
        { id: 1, waiting_voice: 3, waiting_im: 8, avg_wait: 25, sla: 0.92 }
      ],
      active_interactions: { voice: 18, im: 67 },
      service_level: { target_20s: 0.89, target_60s: 0.96 }
    }

# 坐席实时监控
GET /api/v1/monitoring/im/agents/{agentId}/active-interactions
  → {
      agent_id: 101,
      current_voice_call: { call_id: "call_123", caller: "138xxx", duration: 180 },
      current_im_sessions: [
        { session_id: "im_001", customer: "张三", channel: "webchat", state: "active" }
      ],
      utilization: 0.75
    }

# 队列详细监控
GET /api/v1/monitoring/im/queues/{queueId}
  → {
      queue_id: 1,
      waiting: [
        { type: "voice", call_id: "call_456", wait_time: 45 },
        { type: "im", session_id: "im_003", wait_time: 30, channel: "webchat" }
      ],
      stats: { total_today: 234, answered_today: 210, avg_wait: 22 }
    }
```

### 6.5 Alert Rules

```yaml
alerts:
  - name: queue_wait_time_breach
    condition: queue_avg_wait > 60s
    severity: warning
    message: "队列 {queue} 平均等待时间超过 60 秒"

  - name: agent_all_busy
    condition: ready_agents == 0 && queue_waiting > 0
    duration: 30s
    severity: critical

  - name: im_channel_down
    condition: im_channel_errors > threshold
    duration: 10s
    severity: critical

  - name: service_level_breach
    condition: sla_20s < 0.80
    duration: 15m
    severity: warning
```

## 7. Message Storage

### 7.1 Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      im-server                              │
│                                                             │
│  ┌───────────────┐    ┌───────────────┐    ┌────────────┐ │
│  │ Message Handler│───►│ Message Store │───►│  MySQL 8   │ │
│  │               │    │   (接口层)    │    │  (持久化)  │ │
│  └───────┬───────┘    └───────────────┘    └────────────┘ │
│          │                                                 │
│          │ 实时消息                                         │
│          ▼                                                 │
│  ┌───────────────┐                                        │
│  │ Redis         │  ← 活跃会话的消息缓存                   │
│  │ - 活跃消息    │  ← 未读消息计数                         │
│  │ - 会话状态    │  ← 实时推送缓冲                         │
│  └───────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Database Schema

```sql
-- 消息表
CREATE TABLE im_messages (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    message_id      VARCHAR(36) NOT NULL UNIQUE,
    tenant_id       BIGINT NOT NULL,
    session_id      VARCHAR(36) NOT NULL,
    
    sender_type     VARCHAR(16) NOT NULL,    -- 'customer' | 'agent' | 'system'
    sender_id       VARCHAR(128) NOT NULL,
    
    content_type    VARCHAR(32) NOT NULL,
    content         JSON NOT NULL,
    
    channel_type    VARCHAR(32) NOT NULL,
    channel_msg_id  VARCHAR(256),
    
    status          VARCHAR(16) NOT NULL DEFAULT 'delivered',
    delivered_at    DATETIME,
    read_at         DATETIME,
    
    reply_to_id     VARCHAR(36),
    created_at      DATETIME NOT NULL
);

CREATE INDEX idx_messages_session ON im_messages(session_id, created_at);
CREATE INDEX idx_messages_tenant ON im_messages(tenant_id, created_at);

-- 会话表
CREATE TABLE im_sessions (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id      VARCHAR(36) NOT NULL UNIQUE,
    tenant_id       BIGINT NOT NULL,
    
    customer_id     VARCHAR(36),
    customer_history_id VARCHAR(36) NOT NULL,
    display_name    VARCHAR(256),
    avatar_url      VARCHAR(512),
    
    agent_id        BIGINT,
    assigned_at     DATETIME,
    answered_at     DATETIME,
    
    channel_type    VARCHAR(32) NOT NULL,
    channel_identity JSON NOT NULL,
    
    state           VARCHAR(16) NOT NULL,
    close_reason    VARCHAR(32),
    
    message_count   INT NOT NULL DEFAULT 0,
    first_message_at DATETIME,
    last_message_at  DATETIME,
    idle_since       DATETIME,
    closed_at        DATETIME,
    
    queue_id        BIGINT,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL
);

CREATE INDEX idx_sessions_customer_history ON im_sessions(customer_history_id, created_at DESC);
CREATE INDEX idx_sessions_agent ON im_sessions(agent_id, state);

-- 客户历史表
CREATE TABLE im_customer_histories (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_history_id VARCHAR(36) NOT NULL UNIQUE,
    tenant_id       BIGINT NOT NULL,
    
    customer_id     VARCHAR(36),
    channel_identities JSON NOT NULL,
    
    display_name    VARCHAR(256),
    avatar_url      VARCHAR(512),
    tags            JSON NOT NULL,
    
    total_sessions  INT NOT NULL DEFAULT 0,
    total_messages  INT NOT NULL DEFAULT 0,
    first_contact_at DATETIME,
    last_contact_at  DATETIME,
    
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL
);

-- ============================================================
-- IM 配置表（im-service 自行管理，不经过 config-service）
-- 说明：im_channels、im_ai_configs、im_escalation_rules、im_knowledge_bases
-- 这些 IM 特有配置表由 IM 服务自主管理，因为 IM 配置的访问模式和更新频率
-- 与语音配置不同。这些表遵循与 config-service 相同的变更通知模式
-- （Redis Pub/Sub），API 网关代理 IM 配置的 CRUD 端点。
-- ============================================================

-- 渠道配置表
CREATE TABLE im_channels (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    channel_type    VARCHAR(32) NOT NULL,          -- webchat / wechat / whatsapp / app / custom
    name            VARCHAR(255) NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    config          JSON NOT NULL,                 -- 渠道特有配置（widget_url、app_id 等）
    welcome_message JSON,                          -- 欢迎语配置
    offline_message JSON,                          -- 离线留言配置
    session_timeout INT NOT NULL DEFAULT 1800,     -- 会话超时（秒），空闲超过此时自动关闭
    max_concurrent  INT NOT NULL DEFAULT 5,        -- 该渠道每坐席最大并发会话
    settings        JSON NOT NULL,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    UNIQUE(tenant_id, channel_type, name)
);
CREATE INDEX idx_im_channels_tenant ON im_channels(tenant_id, enabled);

-- AI 提供商配置表
CREATE TABLE im_ai_configs (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    name            VARCHAR(255) NOT NULL,
    provider        VARCHAR(32) NOT NULL,          -- openai / claude / qwen / ernie / custom
    model           VARCHAR(100) NOT NULL,
    api_endpoint    VARCHAR(500),                  -- 自定义端点（可选）
    api_key_ref     VARCHAR(255) NOT NULL,         -- 环境变量引用，如 env:OPENAI_API_KEY
    system_prompt   TEXT,                          -- 默认系统提示词
    temperature     DECIMAL(3,2) DEFAULT 0.70,
    max_tokens      INT DEFAULT 2048,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    settings        JSON NOT NULL,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_ai_configs_tenant ON im_ai_configs(tenant_id, enabled);

-- AI 转人工规则表
CREATE TABLE im_escalation_rules (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    ai_config_id    BIGINT NOT NULL,               -- 关联 im_ai_configs.id
    name            VARCHAR(255) NOT NULL,
    condition_type  VARCHAR(32) NOT NULL,          -- intent_not_understood / sensitive_topic / customer_request / max_turns
    condition_value JSON NOT NULL,                 -- 规则参数（如 { "threshold": 3 } 或 { "max_turns": 10 }）
    target_queue_id BIGINT,                        -- 转接目标队列（关联 call_queues.id）
    target_agent_id BIGINT,                        -- 转接目标坐席（关联 agents.id），优先于 queue
    priority        INT NOT NULL DEFAULT 0,        -- 规则优先级，值越大越先匹配
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL
);
CREATE INDEX idx_escalation_rules_tenant ON im_escalation_rules(tenant_id, ai_config_id);
CREATE INDEX idx_escalation_rules_priority ON im_escalation_rules(tenant_id, priority DESC);

-- 知识库配置表（RAG 用）
CREATE TABLE im_knowledge_bases (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    source_type     VARCHAR(32) NOT NULL,          -- file / url / api
    source_config   JSON NOT NULL,                 -- 数据源配置（文件路径、URL、API 端点等）
    embedding_model VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
    chunk_size      INT NOT NULL DEFAULT 512,
    chunk_overlap   INT NOT NULL DEFAULT 50,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending / indexing / ready / error
    last_indexed_at DATETIME,
    settings        JSON NOT NULL,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    UNIQUE(tenant_id, name)
);
CREATE INDEX idx_knowledge_bases_tenant ON im_knowledge_bases(tenant_id, status);

-- ============================================================
-- IM 会话统计表（类似语音 CDR，用于计费和运营分析）
-- ============================================================

CREATE TABLE im_session_stats (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    session_id          VARCHAR(36) NOT NULL,

    -- 客户信息
    customer_id         VARCHAR(36),
    customer_history_id VARCHAR(36),
    display_name        VARCHAR(256),

    -- 渠道信息
    channel_type        VARCHAR(32) NOT NULL,
    channel_id          BIGINT,                    -- 关联 im_channels.id

    -- 坐席信息
    agent_id            BIGINT,
    queue_id            BIGINT,

    -- 时间线
    assigned_at         DATETIME,                  -- 分配到坐席时间
    first_reply_at      DATETIME,                  -- 首次响应时间
    last_message_at     DATETIME,                  -- 最后消息时间
    closed_at           DATETIME NOT NULL,         -- 会话关闭时间

    -- 统计指标
    message_count       INT NOT NULL DEFAULT 0,    -- 总消息数
    customer_message_count INT NOT NULL DEFAULT 0, -- 客户消息数
    agent_message_count INT NOT NULL DEFAULT 0,    -- 坐席消息数
    ai_message_count    INT NOT NULL DEFAULT 0,    -- AI 消息数
    first_response_secs INT,                       -- 首次响应时长（秒）
    avg_response_secs   INT,                       -- 平均响应时长（秒）
    handle_time_secs    INT NOT NULL DEFAULT 0,    -- 处理时长（秒）
    wait_time_secs      INT NOT NULL DEFAULT 0,    -- 排队等待时长（秒）

    -- 关闭信息
    close_reason        VARCHAR(32) NOT NULL,      -- agent_closed / customer_left / idle_timeout / transferred
    satisfaction_rating INT,                       -- 客户满意度评分（1-5）
    satisfaction_comment TEXT,                      -- 客户评价文字

    -- AI 参与信息
    ai_involved         BOOLEAN NOT NULL DEFAULT FALSE,
    ai_config_id        BIGINT,                    -- 使用的 AI 配置
    ai_turns            INT NOT NULL DEFAULT 0,    -- AI 对话轮次
    escalated           BOOLEAN NOT NULL DEFAULT FALSE,
    escalation_reason   VARCHAR(50),               -- 转人工原因

    -- 站点信息
    site_id             VARCHAR(100) NOT NULL,
    instance_id         VARCHAR(100) NOT NULL,

    created_at          DATETIME NOT NULL,
    updated_at          DATETIME NOT NULL
);
CREATE INDEX idx_session_stats_tenant ON im_session_stats(tenant_id, closed_at DESC);
CREATE INDEX idx_session_stats_session ON im_session_stats(session_id);
CREATE INDEX idx_session_stats_agent ON im_session_stats(tenant_id, agent_id, closed_at DESC);
CREATE INDEX idx_session_stats_channel ON im_session_stats(tenant_id, channel_type, closed_at DESC);
CREATE INDEX idx_session_stats_queue ON im_session_stats(tenant_id, queue_id, closed_at DESC);
CREATE INDEX idx_session_stats_sync ON im_session_stats(site_id, instance_id, id);
```

### 7.3 Media Storage

富媒体文件存储到对象存储（MinIO / S3 / OSS），数据库只存 URL 和元数据。

```rust
pub struct MediaStorage {
    storage: ObjectStorage,
    base_url: String,
    presign_ttl: Duration,
}

impl MediaStorage {
    pub async fn upload(&self, file: IncomingFile, session_id: SessionId) -> Result<MediaRef> {
        let key = format!("{}/{}/{}", 
            session_id.tenant_id,
            session_id,
            Uuid::new_v4()
        );
        let url = self.storage.put(&key, file.data, file.content_type).await?;
        Ok(MediaRef {
            url,
            thumbnail_url: self.generate_thumbnail(&key).await?,
            filename: file.filename,
            size: file.size,
            mime_type: file.content_type,
        })
    }
}
```

### 7.4 Redis Cache

```
# 活跃会话最近消息
Key: im:session:{session_id}:messages
Type: List (最近 50 条消息 JSON)
TTL: 会话关闭后 10 分钟清理

# 未读消息计数
Key: im:session:{session_id}:unread
Type: Hash
Fields:
  - customer: counter
  - agent: counter

# 客户当前活跃会话索引
Key: im:customer:{customer_id}:active_session
Type: String (session_id)

# 坐席当前 IM 会话列表
Key: im:agent:{agent_id}:sessions
Type: Set (session_ids)
```

## 8. Port Allocation and Health Check

### 8.1 Port Allocation

| 用途 | 端口 | 说明 |
|------|------|------|
| HTTP API | 8084 | REST API + WebSocket（同端口复用） |
| Metrics / Health | 9097 | Prometheus metrics 端点 + 健康检查 |
| gRPC | 50051 | 与 cti-server / routing-engine 通信 |
| WebSocket | 8084 | 与 HTTP API 共用端口 |

### 8.2 Health Check

```
GET /health (port 9097)
Response:
{
    "status": "ok",
    "service": "im-server",
    "version": "0.1.0"
}
```

健康检查端点用于 Kubernetes liveness/readiness 探针，返回服务运行状态和版本信息。

## 9. API Design

### 9.1 REST API

所有 API 通过 `nextswitch-api` 网关代理，路径前缀 `/api/v1/im`。

**会话管理**：

```
# 客户侧
POST   /im/sessions                      # 创建新会话
GET    /im/sessions/{sessionId}           # 查询会话状态
POST   /im/sessions/{sessionId}/close     # 客户主动关闭
GET    /im/sessions/{sessionId}/messages  # 获取消息历史

# 坐席侧
GET    /im/agents/me/sessions             # 获取当前 IM 会话
POST   /im/sessions/{sessionId}/accept    # 应答会话
POST   /im/sessions/{sessionId}/close     # 关闭会话
POST   /im/sessions/{sessionId}/transfer  # 转接会话

# 主管侧
GET    /im/sessions                       # 查询所有会话
```

**消息发送**：

```
POST   /im/sessions/{sessionId}/messages

Request Body:
{
    "content_type": "text",
    "content": {
        "text": "您好，请问有什么可以帮您？"
    },
    "reply_to": "msg_xxx"
}
```

**文件上传**：

```
POST   /im/media/upload
Content-Type: multipart/form-data

Response:
{
    "media_id": "media_xxx",
    "url": "https://storage.../xxx",
    "content_type": "image/jpeg",
    "size": 102400
}
```

### 9.2 WebSocket Protocol

Web Chat 与后端采用 **HTTP REST + WebSocket** 协议：
- HTTP REST：初始化、发送消息、获取历史
- WebSocket：实时接收消息、状态变化、打字指示器

> **认证方式说明**：IM WebSocket 采用连接后 JSON-RPC 认证（post-connect auth），
> 与信令服务器 WebSocket 的连接前 URL 参数认证（pre-connect auth）不同。
> 原因：信令服务器的连接来自已注册的坐席分机，需要长连接并立即绑定分机身份；
> 而 IM/CTI 的 WebSocket 连接可能来自外部客户（如 Web Chat Widget），
> 这些客户通过不同的方式认证（如 session_token），不适合在 URL 中传递凭据。

```
连接地址: wss://{host}/api/v1/im/events

# 认证
→ {"jsonrpc": "2.0", "method": "auth", "params": {"token": "..."}, "id": 1}
← {"jsonrpc": "2.0", "result": {"authenticated": true}, "id": 1}

# 订阅事件
→ {"jsonrpc": "2.0", "method": "subscribe", "params": {"events": ["im.*"]}, "id": 2}

# 推送事件
← {
    "event": "im.session.assigned",
    "data": {
        "session_id": "sess_xxx",
        "customer": {"display_name": "张三", "channel": "webchat"},
        "queue_id": "sales",
        "wait_time_seconds": 25
    }
}
```

**推送事件列表**：

| 事件 | 描述 | 推送对象 |
|------|------|----------|
| `im.session.assigned` | 新会话分配 | 目标坐席 |
| `im.session.closed` | 会话关闭 | 相关坐席 |
| `im.session.transferred` | 会话转接 | 原坐席 + 目标坐席 |
| `im.message.received` | 收到客户消息 | 处理坐席 |
| `im.message.sent` | 消息发送确认 | 发送坐席 |
| `im.message.read` | 已读回执 | 处理坐席 |
| `im.session.idle_timeout_warning` | 即将超时 | 坐席 + 客户 |

### 9.3 Web Chat Widget API

```
# Widget 初始化
POST   /im/widget/init
Request: {"tenant_id": 1, "channel": "webchat", "page_url": "..."}
Response: {"session_token": "...", "widget_config": {...}}

# 发送消息
POST   /im/widget/messages
Headers: X-Session-Token: xxx
Request: {"content_type": "text", "content": {"text": "你好"}}

# 获取消息历史
GET    /im/widget/messages
Headers: X-Session-Token: xxx

# WebSocket 事件
WS     /im/widget/events
Headers: X-Session-Token: xxx
```

## 10. AI Integration

### 10.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        im-server                                     │
│                                                                     │
│  ┌─────────────┐    ┌─────────────────────────────────────────────┐ │
│  │  Web Chat   │    │           AI Service Layer                  │ │
│  │  Widget     │    │  ┌─────────────┐  ┌─────────────────────┐  │ │
│  │             │    │  │   AI Router │  │   LLM Provider      │  │ │
│  │  ┌───────┐  │    │  │             │  │   ┌───────────────┐ │  │ │
│  │  │ Human │  │    │  │  - AI 直聊  │  │   │  OpenAI       │ │  │ │
│  │  │ Agent │  │    │  │  - AI 转人工│  │   │  Claude       │ │  │ │
│  │  └───────┘  │    │  │  - AI 辅助  │◄─┼───┤  通义千问     │ │  │ │
│  │  ┌───────┐  │    │  │             │  │   │  文心一言     │ │  │ │
│  │  │   AI  │  │    │  └─────────────┘  │   └───────────────┘ │  │ │
│  │  │ Agent │  │    │         │         └─────────────────────┘  │ │
│  │  └───────┘  │    │         ▼                                  │ │
│  └──────┬──────┘    │  ┌─────────────────────────────────────┐  │ │
│         │           │  │   Knowledge Base                    │  │ │
│         │           │  │   - FAQ / 文档                      │  │ │
│         │           │  │   - 向量检索 (RAG)                  │  │ │
│         │           │  └─────────────────────────────────────┘  │ │
│         │           └─────────────────────────────────────────────┘ │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Session Manager                          │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │   │
│  │  │ AI Session  │  │Human Session│  │  Hybrid Session     │ │   │
│  │  │ (纯 AI)     │  │ (纯人工)    │  │  (AI ↔ 人工切换)    │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.2 Session Types

```rust
pub enum SessionType {
    Human,              // 纯人工
    Ai,                 // 纯 AI
    Hybrid {            // 混合模式
        current_handler: Handler,
        history: Vec<HandlerTransition>,
    },
}

pub enum Handler {
    Ai { model: String },
    Human { agent_id: AgentId },
}

pub enum TransitionReason {
    CustomerRequest,        // 客户要求转人工
    AiEscalate,             // AI 主动升级
    AgentTakeover,          // 人工主动接管
    AgentReturnToAi,        // 人工交回 AI
    ConfigRule,             // 配置规则触发
}
```

### 10.3 AI Router

```rust
pub struct AiRouter {
    config: AiRoutingConfig,
    llm_provider: LlmProvider,
    knowledge_base: KnowledgeBase,
}

pub struct AiRoutingConfig {
    pub ai_enabled_queues: Vec<QueueId>,
    pub ai_direct_chat: bool,
    pub escalation_rules: Vec<EscalationRule>,
    pub agent_assist: AgentAssistConfig,
}

pub enum EscalationCondition {
    IntentNotUnderstood { threshold: i32 },
    SensitiveTopic,
    CustomerExplicitRequest,
    MaxTurnsExceeded { max_turns: i32 },
}
```

### 10.4 LLM Provider

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse>;
    async fn chat_stream(&self, request: ChatRequest) -> Result<ChatStream>;
    fn provider_name(&self) -> &str;
}

pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    pub max_tokens: i32,
    pub system_prompt: String,
}
```

### 10.5 Streaming Response

```rust
pub enum ImEvent {
    // ... 其他事件
    
    AiMessageStream {
        session_id: SessionId,
        chunk: String,
        is_final: bool,
        message_id: MessageId,
    },
}
```

### 10.6 Agent Assist

```rust
pub enum AgentAssistFeature {
    SuggestedReplies { suggestions: Vec<String> },
    KnowledgeSearch { query: String, results: Vec<KnowledgeItem> },
    ConversationSummary { summary: String },
    SentimentAnalysis { sentiment: Sentiment, confidence: f32 },
}

// API
POST /im/agent-assist/suggest
POST /im/agent-assist/search
POST /im/sessions/{sessionId}/summary
```

## 11. Implementation Phases

### Phase 1: Core Infrastructure (2-3 weeks)

- Crate 结构搭建
- 配置加载、错误处理、tracing 模块
- MySQL 8 schema + 迁移
- Redis 缓存层
- 会话状态机
- 基础消息存储

### Phase 2: Channel Abstraction + Web Chat (2-3 weeks)

- ChannelAdapter trait
- WebChat Adapter
- Web Chat Widget API
- WebSocket 事件推送

### Phase 3: CTI Integration (2-3 weeks)

- gRPC proto 定义
- gRPC Client/Server
- 坐席并发控制
- 事件同步

### Phase 4: Rich Media + Full Features (2 weeks)

- 对象存储集成
- 富媒体消息
- 会话转接
- 消息已读回执
- 客户身份管理

### Phase 5: AI Integration (3-4 weeks)

- LLM Provider 抽象层
- OpenAI / 通义千问接入
- 流式响应
- AI 会话管理
- AI ↔ 人工切换
- 知识库 + RAG
- AI 辅助功能

### Phase 6: Monitoring + Other Channels (2-3 weeks)

- Prometheus metrics
- 主管监控 API
- 告警规则
- 微信/WhatsApp Adapter

### Phase 7: SDK + Documentation (1-2 weeks)

- TypeScript SDK
- API 文档
- Web Chat Widget 集成文档
- Demo 项目

**Total: 14-20 weeks**

## 12. Appendix

### 12.1 Redis Key Namespace

```
# 注意：tenant_id 为 BIGINT 整数（非 UUID 字符串）
# agent_id、queue_id 同理，均为 BIGINT 整数

im:session:{session_id}              # 会话状态
im:session:{session_id}:messages     # 活跃消息缓存
im:session:{session_id}:unread       # 未读计数
im:customer:{customer_id}:active_session  # 活跃会话索引
im:agent:{agent_id}:sessions         # 坐席会话列表（agent_id 为 BIGINT）
im:customer_history:{customer_id}    # 客户历史
heartbeat:im:{instance_id}           # 实例心跳
```

### 12.2 Error Codes

IM API 错误响应使用统一格式：

```json
{
    "error": {
        "code": "SESSION_NOT_FOUND",
        "message": "会话不存在",
        "details": [],
        "request_id": "req_abc123"
    }
}
```

| Code | Description |
|------|-------------|
| `SESSION_NOT_FOUND` | 会话不存在 |
| `INVALID_STATE_TRANSITION` | 非法状态转换 |
| `CHANNEL_ERROR` | 渠道错误 |
| `CTI_ERROR` | CTI 集成错误 |
| `STORAGE_ERROR` | 存储错误 |
| `MEDIA_UPLOAD_FAILED` | 媒体上传失败 |
| `AI_ERROR` | AI 服务错误 |

### 12.3 Service Communication Matrix

im-server 与其他服务的通信方式：

| 方向 | 目标服务 | 协议 | 用途 |
|------|----------|------|------|
| im-server → | cti-server | gRPC | AcdService（排队/转接）、ImDispatchService（坐席分配）、AgentCapacityService（容量查询） |
| im-server → | config-service | Redis Pub/Sub | 订阅配置变更通知 |
| im-server → | routing-engine | gRPC | RouteInteraction（IM 会话路由） |
| im-server → | auth-service | JWT 验证 | 通过共享密钥或内省端点验证令牌 |
| API Gateway → | im-server | HTTP 代理 | 代理 IM REST API 和 WebSocket 连接 |

### 12.4 References

- CTI Service Design: `docs/superpowers/specs/2026-09-09-cti-service-design.md`
- Platform Security Design: `docs/superpowers/specs/2026-09-09-platform-security-design.md`
- Config & Gateway Design: `docs/superpowers/specs/2026-09-09-config-and-gateway-design.md`

## 变更历史

### v2.0.0 (2026-09-09) — 类型一致性修复

- **tenant_id 类型统一**：im_messages、im_sessions、im_customer_histories 的 tenant_id 从 VARCHAR(36) 改为 BIGINT NOT NULL，与平台全局 tenants.id (BIGINT AUTO_INCREMENT) 保持一致
- **agent_id 类型统一**：im_sessions.agent_id、im_session_stats.agent_id 从 VARCHAR(36) 改为 BIGINT，与 agents.id (BIGINT) 保持一致
- **queue_id 类型统一**：im_sessions.queue_id、im_session_stats.queue_id 从 VARCHAR(36) 改为 BIGINT，与 call_queues.id (BIGINT) 保持一致
- **Protobuf 消息类型修正**：所有 gRPC 消息定义中的 tenant_id、agent_id、queue_id 从 string 改为 int64，与数据库类型对应
- **监控 API 路径修正**：从 `/monitor/` 前缀改为 `/api/v1/monitoring/im/` 前缀，与其他服务保持一致
- **WebSocket 认证说明**：增加注释说明 IM WebSocket 采用连接后 JSON-RPC 认证的原因（区别于信令服务器的 URL 参数认证）
- **错误响应格式统一**：添加统一错误响应格式示例（包含 code、message、details、request_id）
- **配置管理关系澄清**：说明 IM 特有配置表自主管理的设计理由（访问模式和更新频率与语音配置不同）
- **端口分配**：新增 im-server 端口分配表（HTTP: 8084, Metrics/Health: 9097, gRPC: 50051）
- **健康检查端点**：新增 GET /health 端点定义（端口 9097）
- **Redis Key 类型标注**：在 Redis key 命名空间中明确标注 tenant_id、agent_id 为 BIGINT 整数
- **服务通信矩阵**：新增 im-server 与其他服务的通信关系表
