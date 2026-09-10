# nextswitch-api

> API 基础库

---

## 概述

nextswitch-api 提供 API 相关功能，包括 gRPC 服务定义、HTTP 路由、认证中间件等。被所有提供或消费 API 的应用依赖。

## 功能模块

### gRPC 服务定义

```rust
// 生成的 gRPC 客户端/服务端
pub mod grpc {
    pub use routing_service::*;
    pub use media_service::*;
    pub use cti_service::*;
    pub use config_service::*;
}

// 路由服务
pub mod routing_service {
    pub struct RoutingServiceClient<T> { ... }
    pub struct RoutingServiceServer<T> { ... }
    
    pub struct RouteRequest {
        pub tenant_id: i64,
        pub caller: String,
        pub callee: String,
    }
    
    pub struct RouteResponse {
        pub decision: RouteDecision,
        pub target: String,
    }
}

// 媒体服务
pub mod media_service {
    pub struct MediaServiceClient<T> { ... }
    pub struct MediaServiceServer<T> { ... }
    
    pub struct CreateSessionRequest { ... }
    pub struct CreateSessionResponse { ... }
}
```

- 服务间 gRPC 接口定义
- 客户端/服务端代码生成
- 请求/响应类型

### 认证中间件

```rust
pub struct JwtValidator {
    secret: Arc<RsaPublicKey>,
    issuer: String,
}

impl JwtValidator {
    pub fn validate(&self, token: &str) -> Result<TokenInfo>;
}

pub struct TokenInfo {
    pub tenant_id: i64,
    pub user_id: Option<i64>,
    pub extension: Option<String>,
    pub permissions: Vec<String>,
}

pub struct GrpcAuthInterceptor {
    validator: Arc<JwtValidator>,
}

impl GrpcAuthInterceptor {
    pub fn call(&self, req: Request) -> Result<Request>;
}
```

- JWT Token 验证
- 权限提取
- gRPC 拦截器

### 服务发现

```rust
pub struct ServiceDiscovery {
    redis: Arc<RedisPool>,
    cache: Arc<Mutex<LruCache<String, Vec<Endpoint>>>>,
}

impl ServiceDiscovery {
    pub async fn get_endpoints(&self, service: &str) -> Result<Vec<Endpoint>>;
    pub async fn get_healthy_endpoint(&self, service: &str) -> Result<String>;
}

pub struct Endpoint {
    pub address: String,
    pub weight: u32,
    pub healthy: bool,
}
```

- 从 Redis 获取服务端点
- 健康检查
- 负载均衡

### HTTP 路由（API 网关）

```rust
pub struct Router {
    routes: Vec<Route>,
}

impl Router {
    pub fn get(&mut self, path: &str, handler: Handler) -> &mut Self;
    pub fn post(&mut self, path: &str, handler: Handler) -> &mut Self;
    pub fn serve(&self, req: Request) -> Result<Response>;
}

pub struct Route {
    pub method: Method,
    pub path: String,
    pub handler: Arc<Handler>,
    pub middlewares: Vec<Arc<Middleware>>,
}
```

- HTTP 路由匹配
- 中间件链
- 请求处理

### WebSocket 支持

```rust
pub struct WsServer {
    connections: DashMap<ConnectionId, Arc<WsConnection>>,
}

impl WsServer {
    pub async fn accept(&self, stream: TcpStream) -> Result<WsConnection>;
    pub async fn broadcast(&self, msg: WsMessage) -> Result<()>;
    pub async fn send_to(&self, conn_id: ConnectionId, msg: WsMessage) -> Result<()>;
}

pub struct WsConnection {
    pub id: ConnectionId,
    pub sender: mpsc::Sender<WsMessage>,
}
```

- WebSocket 连接管理
- 消息广播
- 点对点推送

### CTI API 类型

```rust
pub mod cti {
    pub struct MakeCallRequest {
        pub caller: String,
        pub callee: String,
        pub caller_id: Option<String>,
    }
    
    pub struct AgentLoginRequest {
        pub agent_id: String,
        pub skills: Vec<String>,
    }
    
    pub enum CtiEvent {
        CallStarted(CallInfo),
        CallAnswered(CallInfo),
        CallEnded(CallInfo),
        AgentStateChanged(AgentState),
        QueuePositionChanged(QueueInfo),
    }
}
```

- 呼叫控制请求类型
- 坐席管理类型
- 事件推送类型

### IM API 类型

```rust
pub mod im {
    pub struct SendMessageRequest {
        pub session_id: String,
        pub content: MessageContent,
        pub msg_type: MessageType,
    }
    
    pub enum MessageContent {
        Text(String),
        Image(ImageInfo),
        File(FileInfo),
    }
    
    pub struct PresenceUpdate {
        pub user_id: String,
        pub status: PresenceStatus,
    }
}
```

- 消息类型定义
- 会话管理类型
- 在线状态类型

## 被依赖方

| 应用 | 用途 |
|------|------|
| sipserver | gRPC 客户端（调用 medserver） |
| sigserver | gRPC 客户端（调用 medserver） |
| medserver | gRPC 服务端（提供媒体服务） |
| cti-server | gRPC 服务端 + WebSocket 推送 |
| im-server | WebSocket 服务端 |
| config-server | gRPC 服务端（提供配置服务） |
| api-gateway | HTTP 路由 + 认证中间件 |
