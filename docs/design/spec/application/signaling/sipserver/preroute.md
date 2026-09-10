# Pre-Route 管线

---

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

---

## 1. Pre-Route 管线实现

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

---

## 2. 速率限制器

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

---

## 3. 呼叫准入控制（CAC）

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
