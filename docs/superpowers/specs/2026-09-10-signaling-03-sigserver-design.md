# NextSWITCH WS/WSS 信令 — WS/WSS 服务设计

> 本文档是 [信令服务器细化设计索引](2026-09-10-signaling-00-index.md) 的第 3 部分。

---

## 1. sigserver 模块详细设计

### 1.1 WebSocket 传输层

```rust
pub struct WebSocketTransport {
    /// TLS 监听器
    tls_acceptor: TlsAcceptor,
    /// 活跃连接管理
    connections: DashMap<ConnectionId, Arc<WsConnection>>,
    /// 连接数限制
    max_connections: usize,
    /// 新连接通道
    new_conn_tx: mpsc::Sender<Arc<WsConnection>>,
}

pub struct WsConnection {
    pub id: ConnectionId,
    pub remote_addr: SocketAddr,
    pub state: AtomicEnum<ConnectionState>,
    
    /// 认证后的客户端信息
    pub client_info: RwLock<Option<ClientInfo>>,
    
    /// 消息发送通道
    pub msg_tx: mpsc::Sender<WsMessage>,
    
    /// 心跳管理
    pub last_ping: AtomicInstant,
    pub ping_interval: Duration,     // 默认 30s
    pub pong_timeout: Duration,      // 默认 10s
    
    pub created_at: Instant,
}

pub struct ClientInfo {
    pub tenant_id: i64,
    pub extension: String,
    pub user_id: Option<i64>,
    pub session_id: String,
    pub authenticated_at: Instant,
}

pub enum ConnectionState {
    Connecting,       // WebSocket 握手完成
    Authenticating,   // 等待 JWT 验证
    Connected,        // 已认证，活跃
    Disconnecting,    // 正在关闭
    Disconnected,     // 已断开
}
```

### 1.2 连接生命周期

```
WebSocket 握手（URL: wss://host/ws?token=<jwt>）
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① JWT 验证                                                │
│    ├─ 解析 JWT Token（从 URL query param 提取）              │
│    ├─ 验证签名（RS256/ES256）                               │
│    ├─ 检查 claims：exp, iss, sub, tenant_id                │
│    ├─ 检查 Redis 黑名单（token 是否已撤销）                   │
│    └─ 验证失败 → 关闭 WebSocket（code=4001）                 │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② 注册连接                                                │
│    ├─ 分配 ConnectionId                                    │
│    ├─ 写入 connections DashMap                              │
│    ├─ 更新 Redis 注册表（endpoint → sigserver 映射）       │
│    └─ 启动心跳协程                                          │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 消息循环                                                │
│    ├─ 接收 JSON-RPC 消息                                    │
│    ├─ 解析 method + params                                  │
│    ├─ 路由到对应处理器                                       │
│    └─ 发送响应/通知                                          │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ 断开清理                                                │
│    ├─ 从 connections 移除                                   │
│    ├─ 清理 Redis 注册记录                                    │
│    ├─ 终结活跃呼叫（发送 BYE）                                │
│    └─ 通知 cti-server 坐席离线                               │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 呼叫状态机

### 2.1 WebRTC 呼叫状态机

```
                    ┌─────────┐
                    │  Idle   │
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │                     │
         invite (主叫)         incoming_call (被叫)
              │                     │
              ▼                     ▼
        ┌──────────┐         ┌──────────┐
        │ Trying   │         │ Alerting │
        └────┬─────┘         └────┬─────┘
             │                    │
      ┌──────┼──────┐      ┌─────┼──────┐
      │             │      │            │
  call_progress  call_ended answer      bye
  (ringing)      (取消)    │            │
      │             │      │            │
      ▼             ▼      ▼            ▼
 ┌──────────┐  ┌──────┐ ┌──────────┐ ┌──────────┐
 │ Ringing  │  │Ended │ │Answered  │ │Ended     │
 └────┬─────┘  └──────┘ └────┬─────┘ └──────────┘
      │                       │
 ┌────┼────┐             ┌────┼────┐
 │    │    │             │    │    │
answer bye  bye      bye hold  transfer
 │    │    │             │    │    │
 ▼    ▼    ▼             ▼    ▼    ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│Answered│ │Ended│ │Ended│ │ Held │
└──────┘ └──────┘ └──────┘ └──┬───┘
                               │
                          resume/bye
                               │
                               ▼
                         ┌──────────┐
                         │Answered/ │
                         │ Ended    │
                         └──────────┘
```

### 2.2 呼叫上下文

```rust
pub struct CallSession {
    pub call_id: String,
    pub tenant_id: i64,
    pub direction: CallDirection,
    pub state: AtomicEnum<CallState>,
    
    /// 主叫信息
    pub caller: EndpointInfo,
    /// 被叫信息
    pub callee: EndpointInfo,
    
    /// WebRTC PeerConnection 管理
    pub peer_connection: Arc<PeerConnection>,
    
    /// 关联的媒体会话
    pub media_session_id: Option<String>,
    
    /// CDR 数据（实时更新）
    pub cdr: RwLock<CdrRecord>,
    
    /// 呼叫开始时间
    pub started_at: Instant,
    /// 应答时间
    pub answered_at: Option<Instant>,
    /// 结束时间
    pub ended_at: Option<Instant>,
}

pub enum CallDirection {
    Inbound,    // 来自 WebRTC 客户端
    Outbound,   // 发往 WebRTC 客户端
}

pub struct EndpointInfo {
    pub extension: String,
    pub connection_id: ConnectionId,
    pub display_name: Option<String>,
}
```

---

## 3. WebRTC 媒体协商

### 3.1 SDP 协商流程

```
WebRTC 客户端                sigserver                  medserver
     │                           │                            │
     │ invite (SDP offer)        │                            │
     │ ─────────────────────────►│                            │
     │                           │                            │
     │                           │ create_session(webRTC)     │
     │                           │ ──────────────────────────►│
     │                           │ {                          │
     │                           │   media_endpoint:          │
     │                           │     rtp://medserver:10000  │
     │                           │   ice_credentials: {...}   │
     │                           │   dtls_fingerprint: {...}  │
     │                           │ }                          │
     │                           │ ◄──────────────────────────│
     │                           │                            │
     │ invite response           │                            │
     │ { sdp_answer: ... }       │                            │
     │ ◄────────────────────────│                            │
     │                           │                            │
     │ ice_candidate             │                            │
     │ ─────────────────────────►│                            │
     │                           │ (透传到 medserver)          │
     │                           │ ──────────────────────────►│
     │                           │                            │
     │ ice_candidate             │                            │
     │ ◄────────────────────────│                            │
     │                           │ ◄──────────────────────────│
     │                           │                            │
     │ ═══ WebRTC 媒体流 ═══════ │ ═══ RTP ═══════════════════│
     │      ↔ medserver          │      ↔ 对端                 │
```

### 3.2 ICE 候选交换

```rust
pub struct MediaNegotiation {
    /// 本地 ICE 候选
    local_candidates: Vec<IceCandidate>,
    /// 远端 ICE 候选
    remote_candidates: Vec<IceCandidate>,
    /// ICE 连接状态
    ice_state: AtomicEnum<IceConnectionState>,
    /// DTLS 指纹
    dtls_fingerprint: Option<String>,
}

pub enum IceConnectionState {
    New,
    Checking,
    Connected,
    Completed,
    Failed,
    Disconnected,
    Closed,
}
```

---

## 4. sigserver 端口配置

| 协议 | 端口 | 说明 |
|------|------|------|
| WebSocket (WSS) | 5443 | WebRTC 信令（与 SIP WSS 共享端口，通过路径区分） |
| Metrics/Health | 9094 | Prometheus 指标 + 健康检查 |
| gRPC | 50052 | 作为 gRPC 客户端连接 medserver |
