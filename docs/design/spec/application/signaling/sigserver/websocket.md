# WebSocket 传输层

---

## 1. WebSocket 传输层

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

---

## 2. 连接生命周期

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
