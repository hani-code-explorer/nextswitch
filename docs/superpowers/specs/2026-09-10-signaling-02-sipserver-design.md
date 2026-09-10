# NextSWITCH 信令服务器 — SIP服务设计

> 本文档是 [信令服务器细化设计索引](2026-09-10-signaling-00-index.md) 的第 2 部分。

---

## 1. Transport 层详细设计

### 1.1 多协议监听

```rust
pub struct TransportLayer {
    listeners: Vec<Arc<dyn Transport>>,
    message_tx: mpsc::Sender<SipMessage>,
}

pub enum TransportProtocol {
    Udp,    // 默认，端口 5060
    Tcp,    // 端口 5060
    Tls,    // 端口 5061
    Wss,    // 端口 5443（WebSocket over TLS）
}

/// UDP 传输（高性能，无连接状态）
pub struct UdpTransport {
    socket: Arc<UdpSocket>,
    /// 多个 workers 共享 socket（SO_REUSEPORT）
    workers: Vec<JoinHandle<()>>,
}

/// TCP/TLS 传输（连接池管理）
pub struct TcpTransport {
    listener: TcpListener,
    connections: DashMap<SocketAddr, Arc<TcpConnection>>,
    max_connections: usize,
    idle_timeout: Duration,
}

impl TransportLayer {
    pub async fn start(&mut self, config: &TransportConfig) -> Result<()> {
        for bind in &config.binds {
            match bind.protocol {
                TransportProtocol::Udp => {
                    let udp = UdpTransport::bind(bind.addr, bind.port, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(udp));
                }
                TransportProtocol::Tcp => {
                    let tcp = TcpTransport::bind(bind.addr, bind.port, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(tcp));
                }
                TransportProtocol::Tls => {
                    let tls = TlsTransport::bind(bind.addr, bind.port, &bind.tls_config, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(tls));
                }
                TransportProtocol::Wss => {
                    let wss = WssTransport::bind(bind.addr, bind.port, &bind.tls_config, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(wss));
                }
            }
        }
        Ok(())
    }
}
```

### 1.2 UDP Worker 模型

```
                    ┌──────────────────┐
                    │   UdpSocket      │
                    │  (SO_REUSEPORT)  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Worker 0 │  │ Worker 1 │  │ Worker N │
        │ (Tokio  │  │ (Tokio  │  │ (Tokio  │
        │  Task)  │  │  Task)  │  │  Task)  │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │              │              │
             └──────────────┼──────────────┘
                            │
                            ▼
                    ┌──────────────────┐
                    │  message_tx      │
                    │  (mpsc channel)  │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  SIP Pipeline    │
                    │  (Pre-Route →    │
                    │   Method Router  │
                    │   → Proxy)       │
                    └──────────────────┘
```

**Worker 数量**：默认 `num_cpus`，可通过配置调整。

---

## 2. Pre-Route 管线

所有入站 SIP 消息在路由决策之前必须通过 Pre-Route 管线处理。管线按顺序执行以下阶段：

```
入站 SIP 消息
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① 消息解析与校验                                          │
│    ├─ SIP 语法解析（RFC 3261）                              │
│    ├─ 必选头检查（Via, From, To, Call-ID, CSeq）            │
│    ├─ Content-Length 校验                                   │
│    └─ 解析失败 → 返回 400 Bad Request                       │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② SIP 防火墙                                              │
│    ├─ 消息大小限制（默认 8KB）                               │
│    ├─ 方法白名单校验                                        │
│    ├─ URI 注入检测（CRLF、括号注入）                         │
│    ├─ Max-Forwards 检查（防循环）                            │
│    └─ 拦截 → 静默丢弃 + 记录安全指标                         │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 速率限制                                                │
│    ├─ 全局 CPS（Calls Per Second）限制                     │
│    ├─ 每 IP CPS 限制                                       │
│    ├─ 每租户 CPS 限制                                       │
│    └─ 超限 → 返回 503 Service Unavailable（带 Retry-After） │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ 呼叫准入控制（CAC）                                       │
│    ├─ 系统级并发呼叫上限                                     │
│    ├─ 租户级并发呼叫上限                                     │
│    ├─ 分机级并发呼叫上限                                     │
│    └─ 超限 → 返回 503 Service Unavailable                   │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
                   路由决策
```

### 2.1 Pre-Route 管线实现

```rust
pub struct PreRoutePipeline {
    parser: SipParser,
    firewall: Arc<SipFirewall>,
    rate_limiter: Arc<RateLimiter>,
    cac: Arc<CallAdmissionControl>,
}

impl PreRoutePipeline {
    pub async fn process(&self, msg: RawSipMessage) -> Result<SipMessage, PreRouteError> {
        let start = Instant::now();
        let source_ip = msg.source_ip;
        
        // ① 消息解析与校验
        let parsed = self.parser.parse(&msg.data).map_err(|e| {
            metrics::counter!("sip_parse_errors_total", "reason" => e.to_string()).increment(1);
            PreRouteError::BadRequest(e)
        })?;
        
        // ② SIP 防火墙
        self.firewall.inspect(&parsed, source_ip).map_err(|e| {
            metrics::counter!("sip_firewall_blocked_total", "reason" => e.to_string()).increment(1);
            PreRouteError::FirewallBlocked(e)
        })?;
        
        // ③ 速率限制
        if let Err(e) = self.rate_limiter.check(&parsed, source_ip).await {
            metrics::counter!("cps_rate_limited_total", "level" => e.level()).increment(1);
            return Err(PreRouteError::RateLimited(e));
        }
        
        // ④ 呼叫准入控制（仅 INVITE）
        if parsed.method() == Method::INVITE {
            if let Err(e) = self.cac.check(&parsed).await {
                metrics::counter!("cac_rejected_total", "level" => e.level()).increment(1);
                return Err(PreRouteError::CacRejected(e));
            }
        }
        
        let elapsed = start.elapsed();
        metrics::histogram!("pre_route_pipeline_duration_us")
            .record(elapsed.as_micros() as f64);
        
        Ok(parsed)
    }
}
```

### 2.2 速率限制器

```rust
pub struct RateLimiter {
    /// 全局 CPS 限制
    global_cps: TokenBucket,
    /// 每 IP CPS 限制
    per_ip_cps: DashMap<IpAddr, TokenBucket>,
    /// 每租户 CPS 限制
    per_tenant_cps: DashMap<i64, TokenBucket>,
    /// 配置
    config: RateLimitConfig,
}

pub struct RateLimitConfig {
    pub global_max_cps: u32,           // 默认 1000
    pub per_ip_max_cps: u32,           // 默认 10
    pub per_tenant_max_cps: u32,       // 默认 100
    pub burst_multiplier: f64,         // 默认 2.0
}

impl RateLimiter {
    pub async fn check(&self, msg: &SipMessage, source_ip: IpAddr) -> Result<(), RateLimitError> {
        // 仅对 INVITE 和 REGISTER 进行 CPS 限制
        if msg.method() != Method::INVITE && msg.method() != Method::REGISTER {
            return Ok(());
        }
        
        // ① 全局 CPS 检查
        if !self.global_cps.consume(1) {
            return Err(RateLimitError::GlobalExceeded);
        }
        
        // ② 每 IP CPS 检查
        let ip_bucket = self.per_ip_cps.entry(source_ip)
            .or_insert_with(|| TokenBucket::new(self.config.per_ip_max_cps, self.config.burst_multiplier));
        if !ip_bucket.consume(1) {
            return Err(RateLimitError::IpExceeded(source_ip));
        }
        
        // ③ 每租户 CPS 检查（从 From 头提取租户）
        if let Some(tenant_id) = self.extract_tenant_id(msg) {
            let tenant_bucket = self.per_tenant_cps.entry(tenant_id)
                .or_insert_with(|| TokenBucket::new(self.config.per_tenant_max_cps, self.config.burst_multiplier));
            if !tenant_bucket.consume(1) {
                return Err(RateLimitError::TenantExceeded(tenant_id));
            }
        }
        
        Ok(())
    }
}
```

### 2.3 呼叫准入控制（CAC）

```rust
pub struct CallAdmissionControl {
    /// 系统级并发计数
    system_calls: AtomicU32,
    /// 租户级并发计数
    tenant_calls: DashMap<i64, AtomicU32>,
    /// 分机级并发计数
    extension_calls: DashMap<(i64, String), AtomicU32>,
    /// 配置
    config: CacConfig,
}

pub struct CacConfig {
    pub max_system_calls: u32,          // 默认 10000
    pub max_tenant_calls_default: u32,  // 默认 500
    pub max_extension_calls_default: u32, // 默认 5
}

impl CallAdmissionControl {
    pub async fn check(&self, msg: &SipMessage) -> Result<(), CacError> {
        let tenant_id = self.extract_tenant_id(msg)?;
        let caller = self.extract_caller(msg)?;
        
        // ① 系统级检查
        let system_count = self.system_calls.load(Ordering::Relaxed);
        if system_count >= self.config.max_system_calls {
            return Err(CacError::SystemLimitExceeded);
        }
        
        // ② 租户级检查
        let tenant_count = self.tenant_calls.entry(tenant_id)
            .or_insert_with(|| AtomicU32::new(0))
            .load(Ordering::Relaxed);
        let tenant_limit = self.get_tenant_limit(tenant_id);
        if tenant_count >= tenant_limit {
            return Err(CacError::TenantLimitExceeded(tenant_id));
        }
        
        // ③ 分机级检查
        let ext_key = (tenant_id, caller.clone());
        let ext_count = self.extension_calls.entry(ext_key)
            .or_insert_with(|| AtomicU32::new(0))
            .load(Ordering::Relaxed);
        let ext_limit = self.get_extension_limit(tenant_id, &caller);
        if ext_count >= ext_limit {
            return Err(CacError::ExtensionLimitExceeded(caller));
        }
        
        Ok(())
    }
    
    /// 呼叫建立时递增计数
    pub fn acquire(&self, tenant_id: i64, caller: &str) {
        self.system_calls.fetch_add(1, Ordering::Relaxed);
        self.tenant_calls.entry(tenant_id)
            .or_insert_with(|| AtomicU32::new(0))
            .fetch_add(1, Ordering::Relaxed);
        self.extension_calls.entry((tenant_id, caller.to_string()))
            .or_insert_with(|| AtomicU32::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }
    
    /// 呼叫结束时递减计数
    pub fn release(&self, tenant_id: i64, caller: &str) {
        self.system_calls.fetch_sub(1, Ordering::Relaxed);
        if let Some(count) = self.tenant_calls.get(&tenant_id) {
            count.fetch_sub(1, Ordering::Relaxed);
        }
        if let Some(count) = self.extension_calls.get(&(tenant_id, caller.to_string())) {
            count.fetch_sub(1, Ordering::Relaxed);
        }
    }
}
```

---

## 3. SIP 方法处理

### 3.1 方法路由

```rust
pub struct MethodRouter {
    invite_handler: Arc<InviteHandler>,
    register_handler: Arc<RegisterHandler>,
    options_handler: Arc<OptionsHandler>,
    info_handler: Arc<InfoHandler>,
    refer_handler: Arc<ReferHandler>,
    notify_handler: Arc<NotifyHandler>,
    bye_handler: Arc<ByeHandler>,
    cancel_handler: Arc<CancelHandler>,
}

impl MethodRouter {
    pub async fn route(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        match msg.method() {
            Method::INVITE => self.invite_handler.handle(msg, ctx).await,
            Method::ACK => self.handle_ack(msg, ctx).await,
            Method::REGISTER => self.register_handler.handle(msg, ctx).await,
            Method::OPTIONS => self.options_handler.handle(msg, ctx).await,
            Method::INFO => self.info_handler.handle(msg, ctx).await,
            Method::REFER => self.refer_handler.handle(msg, ctx).await,
            Method::NOTIFY => self.notify_handler.handle(msg, ctx).await,
            Method::BYE => self.bye_handler.handle(msg, ctx).await,
            Method::CANCEL => self.cancel_handler.handle(msg, ctx).await,
            _ => {
                // 不支持的方法
                self.send_response(msg, StatusCode::METHOD_NOT_ALLOWED).await
            }
        }
    }
}
```

### 3.2 OPTIONS 处理（心跳探测）

OPTIONS 请求用于检测分机是否在线（心跳探测），以及获取对端能力信息。

```rust
pub struct OptionsHandler {
    registry: Arc<RedisRegistry>,
}

impl OptionsHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 检查目标是否在本地注册表
        let to_uri = msg.to().uri();
        let aor = format!("{}@{}", to_uri.user(), to_uri.host());
        
        match self.registry.lookup(&aor).await? {
            Some(reg) if reg.instance_id == ctx.instance_id => {
                // 目标在本实例，直接返回 200 OK
                let response = self.build_options_response(&msg, StatusCode::OK);
                self.send(response).await?;
                
                metrics::counter!("sip_options_total", "result" => "local_hit").increment(1);
            }
            Some(reg) => {
                // 目标在其他实例，转发 OPTIONS
                self.forward_to_instance(msg, &reg).await?;
                
                metrics::counter!("sip_options_total", "result" => "forwarded").increment(1);
            }
            None => {
                // 目标未注册，返回 404
                let response = self.build_options_response(&msg, StatusCode::NOT_FOUND);
                self.send(response).await?;
                
                metrics::counter!("sip_options_total", "result" => "not_found").increment(1);
            }
        }
        
        Ok(())
    }
    
    fn build_options_response(&self, request: &SipMessage, status: StatusCode) -> SipResponse {
        let mut response = SipResponse::new(status);
        
        // 复制必要头
        response.set_via(request.via());
        response.set_from(request.from());
        response.set_to(request.to());
        response.set_call_id(request.call_id());
        response.set_cseq(request.cseq());
        
        // 添加能力声明
        response.add_header("Allow", "INVITE, ACK, BYE, CANCEL, OPTIONS, INFO, REFER, NOTIFY, REGISTER");
        response.add_header("Accept", "application/sdp");
        response.add_header("Accept-Encoding", "gzip");
        response.add_header("Supported", "replaces, timer, path");
        
        // 添加 User-Agent
        response.add_header("User-Agent", "NextSWITCH/1.0");
        
        response
    }
}
```

### 3.3 INFO 处理（DTMF 中继）

INFO 请求用于在通话中传递 DTMF 信号（RFC 2976）。

```rust
pub struct InfoHandler {
    dialog_manager: Arc<DialogManager>,
}

impl InfoHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 提取 DTMF 信息
        let content_type = msg.content_type().ok_or(InfoError::NoContentType)?;
        
        if content_type == "application/dtmf-relay" {
            // RFC 2833 DTMF 中继
            let body = msg.body().ok_or(InfoError::NoBody)?;
            let dtmf = self.parse_dtmf_relay(body)?;
            
            // ② 查找关联的呼叫
            let call_id = msg.call_id();
            let dialog = self.dialog_manager.find_by_call_id(call_id).await;
            
            match dialog {
                Some(d) if d.state == DialogState::Confirmed => {
                    // ③ 转发 DTMF 到对端
                    // 如果是 B2BUA 模式，通过 medserver 转发
                    if let Some(media_session_id) = &d.media_session_id {
                        self.forward_dtmf_to_media(media_session_id, &dtmf).await?;
                    } else {
                        // 纯代理模式，转发 INFO 到对端
                        self.forward_info_to_peer(msg, &d).await?;
                    }
                    
                    // ④ 返回 200 OK
                    let response = self.build_info_response(&msg, StatusCode::OK);
                    self.send(response).await?;
                    
                    // ⑤ 通知 cti-server（如有监听）
                    self.notify_cti_dtmf(call_id, &dtmf).await;
                    
                    metrics::counter!("sip_info_dtmf_total").increment(1);
                }
                _ => {
                    // 找不到活跃呼叫，返回 481
                    let response = self.build_info_response(&msg, StatusCode::CALL_LEG_DOES_NOT_EXIST);
                    self.send(response).await?;
                }
            }
        } else {
            // 不支持的内容类型
            let response = self.build_info_response(&msg, StatusCode::UNSUPPORTED_MEDIA_TYPE);
            self.send(response).await?;
        }
        
        Ok(())
    }
    
    fn parse_dtmf_relay(&self, body: &str) -> Result<DtmfEvent, InfoError> {
        let mut signal = None;
        let mut duration = None;
        
        for line in body.lines() {
            if let Some((key, value)) = line.split_once('=') {
                match key.trim() {
                    "Signal" => signal = Some(value.trim().parse::<char>().map_err(|_| InfoError::InvalidSignal)?),
                    "Duration" => duration = Some(value.trim().parse::<u32>().map_err(|_| InfoError::InvalidDuration)?),
                    _ => {}
                }
            }
        }
        
        Ok(DtmfEvent {
            digit: signal.ok_or(InfoError::MissingSignal)?,
            duration_ms: duration.unwrap_or(160),
        })
    }
}

pub struct DtmfEvent {
    pub digit: char,
    pub duration_ms: u32,
}
```

### 3.4 REFER 处理（呼叫转接）

REFER 请求用于发起呼叫转接（盲转或咨询转）。

```rust
pub struct ReferHandler {
    proxy: Arc<ProxyModule>,
    dialog_manager: Arc<DialogManager>,
}

impl ReferHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 提取 Refer-To 头
        let refer_to = msg.get_header("Refer-To").ok_or(ReferError::MissingReferTo)?;
        let target_uri = self.parse_refer_to(refer_to)?;
        
        // ② 检查转接权限
        let from_ext = self.extract_extension(msg.from())?;
        if !self.check_transfer_permission(&from_ext).await? {
            let response = self.build_refer_response(&msg, StatusCode::FORBIDDEN);
            self.send(response).await?;
            return Ok(());
        }
        
        // ③ 返回 202 Accepted（表示已接受转接请求）
        let response = self.build_refer_response(&msg, StatusCode::ACCEPTED);
        self.send(response).await?;
        
        // ④ 向目标发起新 INVITE
        let call_id = msg.call_id();
        let dialog = self.dialog_manager.find_by_call_id(call_id).await
            .ok_or(ReferError::DialogNotFound)?;
        
        // 创建新的呼叫上下文
        let new_ctx = CallContext {
            call_id: generate_call_id(),
            tenant_id: dialog.tenant_id,
            caller: from_ext.clone(),
            callee: target_uri.user().to_string(),
            ..Default::default()
        };
        
        // 发起新 INVITE
        let invite_result = self.proxy.handle_invite(new_ctx).await;
        
        // ⑤ 通过 NOTIFY 报告转接进度
        self.send_notify_progress(&dialog, StatusCode::TRYING).await;
        
        match invite_result {
            Ok(()) => {
                // 等待新呼叫应答
                // 应答后发送 BYE 给原主叫，完成盲转
                self.wait_and_complete_transfer(dialog, target_uri).await?;
            }
            Err(e) => {
                // 转接失败，通知转接方
                self.send_notify_progress(&dialog, StatusCode::SERVICE_UNAVAILABLE).await;
                metrics::counter!("sip_refer_failed_total").increment(1);
            }
        }
        
        Ok(())
    }
    
    async fn send_notify_progress(&self, dialog: &B2buaDialog, status: StatusCode) {
        let notify = self.build_notify(&dialog, status);
        self.send(notify).await.ok();
    }
    
    fn parse_refer_to(&self, header: &str) -> Result<SipUri, ReferError> {
        // 解析 Refer-To: <sip:1002@domain> 或 Refer-To: sip:1002@domain
        let uri_str = header.trim_start_matches('<').trim_end_matches('>');
        SipUri::parse(uri_str).map_err(|_| ReferError::InvalidUri)
    }
    
    async fn check_transfer_permission(&self, extension: &str) -> Result<bool> {
        // 从配置中检查分机是否有转接权限
        // 默认允许
        Ok(true)
    }
}
```

---

## 4. Proxy 模块详细设计

### 4.1 代理决策流程

```rust
pub struct ProxyModule {
    router: Arc<LocalRouter>,
    registry: Arc<RedisRegistry>,
    /// 服务发现缓存（从 Redis 服务注册表获取对端端点）
    discovery: Arc<ServiceDiscoveryCache>,
    dialog_manager: Arc<DialogManager>,
}

impl ProxyModule {
    pub async fn handle_invite(&self, msg: SipMessage, ctx: CallContext) -> Result<()> {
        // Step 1: 本地快速路径匹配
        let local_result = self.router.match_route(&ctx);
        
        match local_result {
            Some(RouteAction::Direct { extension }) => {
                // 分机直拨：查注册表转发
                self.proxy_to_extension(msg, ctx, &extension).await
            }
            Some(RouteAction::Trunk { trunk_group }) => {
                // 中继路由：转发到 trunk
                self.proxy_to_trunk(msg, ctx, &trunk_group).await
            }
            _ => {
                // Step 2: 委托 router-server（从服务发现缓存获取端点）
                let response = self.route_via_router_server(&ctx).await?;
                
                match RouteDecision::try_from(response.decision)? {
                    RouteDecision::Direct => {
                        self.proxy_to_extension(msg, ctx, &response.target).await
                    }
                    RouteDecision::Trunk => {
                        self.proxy_to_trunk(msg, ctx, &response.target).await
                    }
                    RouteDecision::Ivr | RouteDecision::CallFlow | RouteDecision::Conference => {
                        // 需要 B2BUA 降级
                        self.b2bua_downgrade(msg, ctx, response).await
                    }
                    RouteDecision::Queue => {
                        // ACD 排队
                        self.enqueue_to_cti(msg, ctx, response).await
                    }
                    RouteDecision::Deny => {
                        self.send_response(msg, StatusCode::FORBIDDEN).await
                    }
                    RouteDecision::NoMatch => {
                        // 播放提示音后挂断
                        self.play_announcement_and_hangup(msg, ctx, "number_not_found").await
                    }
                }
            }
        }
    }
    
    /// 通过服务发现缓存调用 router-server
    async fn route_via_router_server(
        &self,
        ctx: &CallContext,
    ) -> Result<RouteResponse, RoutingError> {
        let endpoint = self.discovery
            .get_healthy_endpoint("router-server")
            .await
            .map_err(|_| RoutingError::ServiceUnavailable("router-server".into()))?;
        
        let channel = Channel::from_shared(endpoint)
            .map_err(|e| RoutingError::ConnectionFailed(e.to_string()))?
            .connect_timeout(Duration::from_millis(2000))
            .connect()
            .await
            .map_err(|e| RoutingError::ConnectionFailed(e.to_string()))?;
        
        let mut client = RoutingServiceClient::new(channel);
        // ... 构建请求并调用 ...
        todo!()
    }
}
```

### 4.2 注册表查询优化

```rust
pub struct RedisRegistry {
    redis: RedisPool,
    /// 本地 LRU 缓存（减少 Redis 往返）
    local_cache: Arc<Mutex<LruCache<String, Registration>>>,
    /// 缓存 TTL（默认 30s）
    cache_ttl: Duration,
}

impl RedisRegistry {
    pub async fn lookup(&self, aor: &str) -> Result<Option<Registration>> {
        // Step 1: 查本地 LRU 缓存
        if let Some(reg) = self.local_cache.lock().get(aor) {
            if !reg.is_expired() {
                return Ok(Some(reg.clone()));
            }
        }
        
        // Step 2: Redis HGET
        let key = format!("reg:sip:{}", aor);
        let result: Option<Registration> = self.redis.hgetall(&key).await?;
        
        match result {
            Some(reg) => {
                // Step 3: 检查 expires
                if reg.is_expired() {
                    // 惰性清理
                    self.redis.del(&key).await.ok();
                    return Ok(None);
                }
                
                // Step 4: 检查实例心跳
                let heartbeat_key = format!("heartbeat:sipserver:{}", reg.instance_id);
                let alive: bool = self.redis.exists(&heartbeat_key).await?;
                if !alive {
                    // 实例已下线，清理注册
                    self.redis.del(&key).await.ok();
                    return Ok(None);
                }
                
                // 写入本地缓存
                self.local_cache.lock().put(aor.to_string(), reg.clone());
                
                Ok(Some(reg))
            }
            None => Ok(None),
        }
    }
}
```

---

## 5. Registrar 模块详细设计

### 5.1 REGISTER 处理流程

```
REGISTER 请求
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① 提取 Authorization 头                                   │
│    ├─ 无 Authorization → 返回 401 + Nonce                  │
│    └─ 有 Authorization → 继续                              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② 验证 DIGEST 响应                                        │
│    ├─ 从 extensions 表获取 password_hash                    │
│    ├─ 计算 expected response                               │
│    ├─ 比对 → 不匹配 → 返回 403 + 计数失败                    │
│    └─ 匹配 → 继续                                          │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 检查注册策略                                             │
│    ├─ 检查 login_failed_count → 超过阈值 → 返回 403          │
│    ├─ 检查 max_contacts 限制                                │
│    └─ 检查 expires 范围（min_expires ≤ expires ≤ max_expires）│
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ 写入 Redis 注册表                                        │
│    HSET reg:sip:{aor} contact expires instance_id ...      │
│    EXPIRE reg:sip:{aor} expires                            │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ⑤ 返回 200 OK                                             │
│    Contact: <sip:{ext}@{host}:{port}>                     │
│    Expires: {granted_expires}                              │
│    通知 cti-server 分机在线状态变更                           │
└──────────────────────────────────────────────────────────┘
```

### 5.2 注册数据结构

```rust
/// Redis 注册表条目
pub struct Registration {
    /// 注册 contact 地址
    pub contact: String,
    /// 过期时间（Unix 时间戳）
    pub expires: i64,
    /// 注册所在实例
    pub instance_id: String,
    /// 传输协议
    pub transport: String,
    /// SIP Call-ID（用于注册去重）
    pub call_id: String,
    /// CSeq 序号
    pub cseq: u32,
    /// 注册时间
    pub registered_at: i64,
    /// User-Agent
    pub user_agent: Option<String>,
}
```

---

## 6. Dialog 模块（B2BUA）详细设计

### 6.1 B2BUA 会话管理

```rust
pub struct DialogManager {
    /// 活跃的 B2BUA 会话
    dialogs: DashMap<String, Arc<B2buaDialog>>,
    /// 呼叫 ID → Dialog ID 索引
    call_id_index: DashMap<String, String>,
}

pub struct B2buaDialog {
    pub id: String,
    pub call_id: String,
    pub tenant_id: i64,
    
    /// Leg A（主叫侧）
    pub leg_a: DialogLeg,
    /// Leg B（被叫侧）
    pub leg_b: Option<DialogLeg>,
    
    /// 降级原因
    pub downgrade_reason: B2buaReason,
    
    /// 关联的媒体会话 ID
    pub media_session_id: Option<String>,
    
    /// 状态
    pub state: AtomicEnum<DialogState>,
    
    pub created_at: Instant,
}

pub struct DialogLeg {
    pub call_id: String,
    pub from_tag: String,
    pub to_tag: String,
    pub cseq: u32,
    pub remote_target: String,
    pub route_set: Vec<String>,
    pub local_sdp: Option<String>,
    pub remote_sdp: Option<String>,
}

pub enum B2buaReason {
    Recording,        // 通话录音
    Conference,       // 会议桥
    Ivr,              // IVR 导航
    Transcode,        // 协议转换（SIP↔WebRTC）
    CallFlow,         // 呼叫流程编排
}

pub enum DialogState {
    Trying,           // Leg A 已建立，正在建立 Leg B
    Early,            // Leg B 已收到 1xx
    Confirmed,        // 双方都已应答
    Terminated,       // 通话结束
}
```

### 6.2 B2BUA 消息转发

```
主叫 (Leg A)              sipserver (B2BUA)              medserver              被叫 (Leg B)
    │                          │                             │                        │
    │ INVITE (SDP-A)           │                             │                        │
    │ ────────────────────────►│                             │                        │
    │                          │ create_session(transcode)   │                        │
    │                          │ ──────────────────────────► │                        │
    │                          │ { media_endpoint: rtp://... }                        │
    │                          │ ◄────────────────────────── │                        │
    │                          │                             │                        │
    │ 100 Trying               │                             │                        │
    │ ◄────────────────────────│                             │                        │
    │                          │ INVITE (SDP-Media)          │                        │
    │                          │ ───────────────────────────────────────────────────►│
    │                          │                             │                        │
    │                          │ 200 OK (SDP-B)              │                        │
    │                          │ ◄───────────────────────────────────────────────────│
    │                          │ update_session(link_leg_b)  │                        │
    │                          │ ──────────────────────────► │                        │
    │                          │                             │                        │
    │ 200 OK (SDP-Media)       │                             │                        │
    │ ◄────────────────────────│                             │                        │
    │                          │                             │                        │
    │ ACK                      │                             │                        │
    │ ────────────────────────►│                             │                        │
    │                          │ ACK                         │                        │
    │                          │ ───────────────────────────────────────────────────►│
    │                          │                             │                        │
    │ ════ 媒体流 ═════════════│ ════ RTP ══════════════════ │ ════ RTP ════════════ │
    │      SDP-A ↔ Media       │      Media ↔ Media          │      Media ↔ SDP-B     │
```

---

## 7. CDR 生成

### 7.1 CDR 数据流

```
呼叫建立
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① CDR 记录创建                                            │
│    ├─ 分配 cdr_id (UUID)                                   │
│    ├─ 记录初始字段（caller, callee, tenant_id, start_time） │
│    └─ 写入内存 CDR 缓存                                    │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② 实时更新                                                │
│    ├─ 被叫应答 → 更新 answer_time                          │
│    ├─ 录音开始 → 更新 recorded=true, recording_url         │
│    ├─ 通话质量 → 更新 mos, packet_loss, jitter             │
│    └─ 原子更新内存缓存                                     │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 呼叫结束                                                │
│    ├─ 更新 end_time, duration, hangup_cause, hangup_by     │
│    ├─ 写入 WAL（Write-Ahead Log）                          │
│    └─ 标记为待刷盘                                         │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ 批量刷盘                                                │
│    ├─ 后台协程定期刷新（默认 100ms 或 10000 条）              │
│    ├─ 批量写入 Redis Stream（cdr:records）                  │
│    └─ 异步持久化到数据库                                    │
└──────────────────────────────────────────────────────────┘
```

### 7.2 CDR 数据结构

```rust
pub struct CdrRecord {
    /// CDR 唯一标识
    pub cdr_id: String,
    /// 关联的 SIP Call-ID
    pub call_id: String,
    /// 租户 ID
    pub tenant_id: i64,
    /// 站点 ID
    pub site_id: String,
    
    /// 主叫号码
    pub caller: String,
    /// 被叫号码
    pub callee: String,
    /// 主叫显示名
    pub caller_name: Option<String>,
    
    /// 呼叫方向
    pub direction: CallDirection,
    
    /// 时间戳
    pub start_time: DateTime<Utc>,
    pub answer_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    
    /// 时长（秒）
    pub duration_secs: u32,
    pub ring_duration_secs: u32,
    
    /// 挂断原因
    pub hangup_cause: HangupCause,
    pub hangup_by: HangupBy,
    
    /// SIP 信息
    pub sip_call_id: String,
    pub from_instance: String,
    pub to_instance: Option<String>,
    
    /// 媒体信息
    pub media_session_id: Option<String>,
    pub recorded: bool,
    pub recording_url: Option<String>,
    
    /// 通话质量
    pub quality: Option<CallQuality>,
}

pub struct CallQuality {
    /// MOS 分数（1.0 ~ 5.0）
    pub mos: f32,
    /// 丢包率（百分比）
    pub packet_loss_pct: f32,
    /// 抖动（毫秒）
    pub jitter_ms: u32,
    /// 往返延迟（毫秒）
    pub rtt_ms: Option<u32>,
}

pub enum HangupCause {
    NormalClearing,
    UserBusy,
    NoAnswer,
    CallRejected,
    UnallocatedNumber,
    ServiceUnavailable,
    InvalidNumber,
    // ... 更多原因
}

pub enum HangupBy {
    Caller,
    Callee,
    System,
}
```

### 7.3 CDR 写入实现

```rust
pub struct CdrWriter {
    /// 内存 CDR 缓存
    cache: Arc<DashMap<String, CdrRecord>>,
    /// WAL 缓冲区
    wal_buffer: Arc<Mutex<Vec<CdrRecord>>>,
    /// Redis 客户端
    redis: Arc<RedisPool>,
    /// 刷盘配置
    config: CdrConfig,
    /// 刷盘触发器
    flush_tx: mpsc::Sender<()>,
}

pub struct CdrConfig {
    /// WAL 目录
    pub wal_dir: PathBuf,
    /// 刷盘间隔（毫秒）
    pub flush_interval_ms: u64,     // 默认 100
    /// 批量大小
    pub max_buffer_size: usize,     // 默认 10000
}

impl CdrWriter {
    /// 创建新 CDR 记录
    pub async fn create(&self, call_ctx: &CallContext) -> String {
        let cdr_id = Uuid::new_v4().to_string();
        
        let cdr = CdrRecord {
            cdr_id: cdr_id.clone(),
            call_id: call_ctx.call_id.clone(),
            tenant_id: call_ctx.tenant_id,
            site_id: call_ctx.site_id.clone(),
            caller: call_ctx.caller.clone(),
            callee: call_ctx.callee.clone(),
            caller_name: call_ctx.caller_name.clone(),
            direction: call_ctx.direction.clone(),
            start_time: Utc::now(),
            answer_time: None,
            end_time: None,
            duration_secs: 0,
            ring_duration_secs: 0,
            hangup_cause: HangupCause::NormalClearing,
            hangup_by: HangupBy::System,
            sip_call_id: call_ctx.sip_call_id.clone(),
            from_instance: INSTANCE_ID.clone(),
            to_instance: None,
            media_session_id: None,
            recorded: false,
            recording_url: None,
            quality: None,
        };
        
        // 写入内存缓存
        self.cache.insert(cdr_id.clone(), cdr);
        
        cdr_id
    }
    
    /// 更新 CDR 字段
    pub async fn update<F>(&self, cdr_id: &str, updater: F)
    where
        F: FnOnce(&mut CdrRecord),
    {
        if let Some(mut cdr) = self.cache.get_mut(cdr_id) {
            updater(&mut cdr);
        }
    }
    
    /// 呼叫结束时写入 WAL
    pub async fn finalize(&self, cdr_id: &str, cause: HangupCause, hangup_by: HangupBy) {
        if let Some(mut cdr) = self.cache.get_mut(cdr_id) {
            cdr.end_time = Some(Utc::now());
            cdr.hangup_cause = cause;
            cdr.hangup_by = hangup_by;
            
            // 计算时长
            if let (Some(answer), Some(end)) = (cdr.answer_time, cdr.end_time) {
                cdr.duration_secs = (end - answer).num_seconds() as u32;
            }
            if let Some(answer) = cdr.answer_time {
                cdr.ring_duration_secs = (answer - cdr.start_time).num_seconds() as u32;
            }
            
            // 写入 WAL 缓冲
            self.wal_buffer.lock().push(cdr.clone());
            
            // 触发刷盘（如达到阈值）
            if self.wal_buffer.lock().len() >= self.config.max_buffer_size {
                let _ = self.flush_tx.send(()).await;
            }
        }
    }
    
    /// 后台刷盘协程
    pub async fn flush_loop(&self) {
        let mut interval = tokio::time::interval(
            Duration::from_millis(self.config.flush_interval_ms)
        );
        
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    self.flush_to_redis().await;
                }
                _ = self.flush_tx.recv() => {
                    self.flush_to_redis().await;
                }
            }
        }
    }
    
    async fn flush_to_redis(&self) {
        let records: Vec<CdrRecord> = {
            let mut buffer = self.wal_buffer.lock();
            if buffer.is_empty() {
                return;
            }
            std::mem::take(&mut *buffer)
        };
        
        // 批量写入 Redis Stream
        let mut pipe = redis::pipe();
        for cdr in &records {
            let key = format!("cdr:records:{}", cdr.tenant_id);
            let value = serde_json::to_string(cdr).unwrap();
            pipe.xadd(&key, "*", &[("data", &value)]);
        }
        
        if let Err(e) = pipe.query_async(&mut *self.redis).await {
            error!(error = %e, "failed to flush CDR to Redis");
            // 失败时回写到 WAL 缓冲
            self.wal_buffer.lock().extend(records);
        } else {
            metrics::counter!("cdr_flushed_total").increment(records.len() as u64);
        }
    }
}
```

---

## 8. 心跳机制

### 8.1 实例心跳

每个 sipserver 实例定期向 Redis 写入心跳和服务注册信息，用于：
- 服务发现（哪些实例在线，端点地址是什么）
- 健康检查（实例是否存活）
- 注册表清理（实例下线时清理其注册的分机）

```rust
pub struct HeartbeatManager {
    instance_id: String,
    service_name: String,
    redis: Arc<RedisPool>,
    /// 心跳间隔
    interval: Duration,          // 默认 10s
    /// 心跳 TTL（过期时间）
    ttl: Duration,               // 默认 30s
    /// 本实例的端点信息
    endpoints: ServiceEndpointsInfo,
    /// 站点/可用区信息
    site_id: String,
    az_id: String,
}

impl HeartbeatManager {
    /// 启动心跳协程
    pub async fn start(&self) -> JoinHandle<()> {
        let instance_id = self.instance_id.clone();
        let service_name = self.service_name.clone();
        let redis = self.redis.clone();
        let interval = self.interval;
        let ttl = self.ttl;
        let endpoints = self.endpoints.clone();
        let site_id = self.site_id.clone();
        let az_id = self.az_id.clone();
        
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            
            loop {
                ticker.tick().await;
                
                // 写入服务注册表（包含端点信息）
                let registry_key = format!("svc:{}:{}", service_name, instance_id);
                let registry_value = serde_json::json!({
                    "instance_id": instance_id,
                    "service": service_name,
                    "endpoints": {
                        "grpc": endpoints.grpc,
                        "health": endpoints.health,
                    },
                    "site_id": site_id,
                    "az_id": az_id,
                    "started_at": Utc::now().timestamp_millis(),
                    "load": {
                        "active_calls": get_active_calls(),
                        "registered_endpoints": get_registered_count(),
                        "cpu_percent": get_cpu_percent(),
                    }
                });
                
                // 写入心跳（存活检测）
                let heartbeat_key = format!("heartbeat:{}:{}", service_name, instance_id);
                let heartbeat_value = serde_json::json!({
                    "instance_id": instance_id,
                    "timestamp": Utc::now().timestamp_millis(),
                    "load": {
                        "active_calls": get_active_calls(),
                        "registered_endpoints": get_registered_count(),
                        "cpu_percent": get_cpu_percent(),
                    }
                });
                
                // 批量写入两个 key（同一 pipeline）
                let mut pipe = redis::pipe();
                pipe.set_ex(&registry_key, registry_value.to_string(), ttl.as_secs())
                    .set_ex(&heartbeat_key, heartbeat_value.to_string(), ttl.as_secs());
                
                let result: RedisResult<()> = pipe.query_async(&mut *redis).await;
                
                match result {
                    Ok(()) => {
                        metrics::counter!("heartbeat_sent_total").increment(1);
                    }
                    Err(e) => {
                        error!(error = %e, "failed to send heartbeat");
                        metrics::counter!("heartbeat_failed_total").increment(1);
                    }
                }
            }
        })
    }
}
```

### 8.2 心跳数据结构

```rust
/// Redis 服务注册表 key 格式：svc:{service}:{instance_id}
/// Redis 心跳 key 格式：heartbeat:{service}:{instance_id}
/// TTL：30s（默认）
/// 两个 key 由同一心跳协程通过 Redis pipeline 批量写入

/// 服务注册表值格式（svc: key）
pub struct ServiceRegistryPayload {
    pub instance_id: String,
    pub service: String,
    pub endpoints: ServiceEndpointsInfo,
    pub site_id: String,
    pub az_id: String,
    pub started_at: i64,
    pub load: InstanceLoad,
}

pub struct ServiceEndpointsInfo {
    pub grpc: String,
    pub health: String,
}

/// 心跳值格式（heartbeat: key）
pub struct HeartbeatPayload {
    pub instance_id: String,
    pub timestamp: i64,           // Unix 毫秒时间戳
    pub load: InstanceLoad,
}

pub struct InstanceLoad {
    pub active_calls: u32,
    pub registered_endpoints: u32,
    pub cpu_percent: f32,
}
```

### 8.3 心跳检查

查询注册表时，需要检查对应实例的心跳是否有效：

```rust
impl RedisRegistry {
    pub async fn lookup(&self, aor: &str) -> Result<Option<Registration>> {
        // ... 省略缓存检查 ...
        
        let reg = self.redis.hgetall(&key).await?;
        
        if let Some(reg) = reg {
            // 检查实例心跳
            let heartbeat_key = format!("heartbeat:sipserver:{}", reg.instance_id);
            let alive: bool = self.redis.exists(&heartbeat_key).await?;
            
            if !alive {
                // 实例已下线，清理该实例的所有注册
                warn!(
                    instance_id = %reg.instance_id,
                    aor = %aor,
                    "instance heartbeat expired, cleaning up registration"
                );
                self.redis.del(&key).await.ok();
                
                // 清理该实例的所有注册（批量）
                self.cleanup_instance(&reg.instance_id).await;
                
                return Ok(None);
            }
            
            Ok(Some(reg))
        } else {
            Ok(None)
        }
    }
    
    /// 清理指定实例的所有注册
    async fn cleanup_instance(&self, instance_id: &str) {
        // 扫描所有 reg:sip:* 键，删除 instance_id 匹配的
        // 实际实现可使用 Redis SCAN 或维护反向索引
        let pattern = "reg:sip:*";
        let mut cursor = "0";
        
        loop {
            let (next_cursor, keys): (String, Vec<String>) = self.redis
                .scan(cursor, pattern, 100)
                .await?;
            
            for key in keys {
                if let Ok(Some(reg)) = self.redis.hgetall::<_, Registration>(&key).await {
                    if reg.instance_id == instance_id {
                        self.redis.del(&key).await.ok();
                    }
                }
            }
            
            cursor = next_cursor;
            if cursor == "0" {
                break;
            }
        }
    }
}
```

### 8.4 心跳监控指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `heartbeat_sent_total` | Counter | 成功发送的心跳数 |
| `heartbeat_failed_total` | Counter | 发送失败的心跳数 |
| `heartbeat_missed_total` | Counter | 错过的心跳周期数 |
| `instance_heartbeat_latency_seconds` | Histogram | 心跳写入 Redis 延迟 |

---

## 9. 端口与协议配置

sipserver 遵循统一端口分配表（详见 `config-and-gateway-design.md` Appendix B）：

| 协议 | 端口 | 说明 |
|------|------|------|
| SIP UDP | 5060 | 默认 SIP 传输 |
| SIP TCP | 5060 | 大消息/可靠传输 |
| SIP TLS | 5061 | 加密 SIP |
| SIP WSS | 5443 | WebSocket SIP（与 sigserver 共享端口） |
| Metrics/Health | 5080 | Prometheus 指标 + 健康检查 |
| gRPC | 50051 | 作为 gRPC 客户端连接 medserver/router-server |
