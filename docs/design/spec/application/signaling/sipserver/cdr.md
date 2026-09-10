# CDR 生成

> **crate**: `nextswitch-signaling-cdr`
> **消费方**: `nextswitch-sip`（sipserver）、`nextswitch-sig`（sigserver，WS:5080 / WSS:5443）

---

## 1. CDR 数据流

```
呼叫建立
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① CDR 记录创建                                            │
│    ├─ 调用方构建 CdrRecord（含 caller, callee, tenant 等）  │
│    ├─ CdrWriter 分配 cdr_id (UUID)、设置 start_time        │
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
│ ③ 呼叫结束（finalize）                                     │
│    ├─ 更新 end_time, hangup_cause, hangup_by              │
│    ├─ 自动计算 duration、ring_duration                     │
│    ├─ 写入 WAL 缓冲区（内存 Vec）                           │
│    └─ 达到阈值时触发刷盘                                    │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ 批量刷盘（通过 CdrSink trait）                           │
│    ├─ 后台协程定期刷新（默认 100ms 或 10000 条）              │
│    ├─ RedisSink → 批量写入 Redis Stream（cdr:records）     │
│    ├─ LogSink → 输出到日志（测试/开发用）                    │
│    └─ 刷盘失败时回写到 WAL 缓冲区                           │
└──────────────────────────────────────────────────────────┘
```

---

## 2. CDR 数据结构

```rust
pub struct CdrRecord {
    /// CDR 唯一标识（由 CdrWriter 分配）
    pub cdr_id: String,
    /// 关联的呼叫 ID
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

pub enum CallDirection {
    Inbound,
    Outbound,
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
```

### 2.1 HangupCause（Q.850 映射）

```rust
pub enum HangupCause {
    // --- 正常 ---
    NormalClearing,
    NormalUnspecified,

    // --- 路由/地址 ---
    NoRouteToDestination,
    UnallocatedNumber,
    InvalidNumberFormat,
    NumberChanged,

    // --- 用户侧 ---
    UserBusy,
    NoAnswer,
    NoUserResponding,
    SubscriberAbsent,
    CallRejected,

    // --- 资源/网络 ---
    ChannelUnacceptable,
    DestinationOutOfOrder,
    NetworkOutOfOrder,
    TemporaryFailure,
    SwitchingEquipmentCongestion,
    CircuitOrChannelNotAvailable,
    Preempted,

    // --- 权限/服务 ---
    ServiceUnavailable,
    FacilityRejected,
    FacilityNotAvailable,
    OutgoingCallsBarred,
    IncomingCallsBarred,
    BearerCapabilityNotAuthorized,

    // --- 协议/消息 ---
    InvalidCallReference,
    IncompatibleDestination,
    ProtocolError,
    RecoveryOnTimerExpire,

    // --- 其他 ---
    InterworkingUnspecified,
}

impl HangupCause {
    /// 从 SIP 响应码映射
    pub fn from_sip_code(code: u16) -> Self {
        match code {
            200         => Self::NormalClearing,
            400         => Self::InvalidNumberFormat,
            403         => Self::BearerCapabilityNotAuthorized,
            404         => Self::UnallocatedNumber,
            408         => Self::RecoveryOnTimerExpire,
            413         => Self::ProtocolError,
            414         => Self::ProtocolError,
            415         => Self::IncompatibleDestination,
            416         => Self::InvalidNumberFormat,
            420         => Self::ProtocolError,
            421         => Self::ProtocolError,
            423         => Self::ProtocolError,
            480         => Self::TemporaryFailure,
            481         => Self::InvalidCallReference,
            482         => Self::ProtocolError,
            483         => Self::ProtocolError,
            484         => Self::InvalidNumberFormat,
            485         => Self::NumberChanged,
            486         => Self::UserBusy,
            487         => Self::NormalClearing,
            488         => Self::IncompatibleDestination,
            493         => Self::ProtocolError,
            500         => Self::InterworkingUnspecified,
            501         => Self::ProtocolError,
            502         => Self::NetworkOutOfOrder,
            503         => Self::ServiceUnavailable,
            504         => Self::RecoveryOnTimerExpire,
            505         => Self::InterworkingUnspecified,
            513         => Self::ProtocolError,
            600         => Self::UserBusy,
            603         => Self::CallRejected,
            604         => Self::NoRouteToDestination,
            606         => Self::IncompatibleDestination,
            _           => Self::NormalUnspecified,
        }
    }
}
```

### 2.2 HangupBy（呼叫中心角色）

```rust
pub enum HangupBy {
    Caller,     // 主叫用户
    Callee,     // 被叫用户
    Agent,      // 座席
    Supervisor, // 班长/主管
    IvR,        // IVR 系统
    Queue,      // 队列系统
    System,     // 系统（超时、故障等）
}
```

---

## 3. CdrSink trait（刷盘后端抽象）

```rust
pub type SinkError = Box<dyn std::error::Error + Send + Sync>;

#[async_trait]
pub trait CdrSink: Send + Sync + 'static {
    async fn flush(&self, records: &[CdrRecord]) -> Result<(), SinkError>;
}
```

### 3.1 RedisSink（`redis` feature，生产环境）

```rust
#[cfg(feature = "redis")]
pub struct RedisSink {
    conn: redis::aio::ConnectionManager,  // 自带断线重连
}

impl RedisSink {
    pub async fn new(redis_url: &str) -> Result<Self, Error>;
}

#[async_trait]
impl CdrSink for RedisSink {
    async fn flush(&self, records: &[CdrRecord]) -> Result<(), SinkError> {
        let mut pipe = redis::pipe();
        for cdr in records {
            let key = format!("cdr:records:{}", cdr.tenant_id);
            let value = serde_json::to_string(cdr)?;
            pipe.xadd(&key, "*", &[("data", &value)]);
        }
        let mut conn = self.conn.clone();
        pipe.query_async::<Vec<String>>(&mut conn).await?;
        Ok(())
    }
}
```

### 3.2 LogSink（测试/开发）

```rust
pub struct LogSink;

#[async_trait]
impl CdrSink for LogSink {
    async fn flush(&self, records: &[CdrRecord]) -> Result<(), SinkError> {
        for cdr in records {
            info!(
                cdr_id = %cdr.cdr_id,
                caller = %cdr.caller,
                callee = %cdr.callee,
                duration_secs = cdr.duration_secs,
                hangup_cause = ?cdr.hangup_cause,
                "CDR record";
            );
        }
        Ok(())
    }
}
```

---

## 4. CdrWriter 实现

```rust
struct CdrWriterInner {
    cache: DashMap<String, CdrRecord>,
    wal_buffer: Mutex<Vec<CdrRecord>>,
    sink: Arc<dyn CdrSink>,
    config: CdrConfig,
    flush_tx: mpsc::Sender<()>,
}

#[derive(Clone)]
pub struct CdrWriter {
    inner: Arc<CdrWriterInner>,
}

pub struct CdrConfig {
    /// Redis URL，Some 则用 RedisSink，None 则用 LogSink
    pub redis_url: Option<String>,
    /// 刷盘间隔（毫秒）
    pub flush_interval_ms: u64,     // 默认 100
    /// 批量大小
    pub max_buffer_size: usize,     // 默认 10000
}

impl Default for CdrConfig {
    fn default() -> Self {
        Self {
            redis_url: None,
            flush_interval_ms: 100,
            max_buffer_size: 10_000,
        }
    }
}
```

### 4.1 核心方法

```rust
impl CdrWriter {
    /// 创建 CdrWriter，根据 config.redis_url 自动选择 sink
    pub async fn new(config: CdrConfig) -> Result<Self, Error> {
        let sink: Arc<dyn CdrSink> = match config.redis_url {
            #[cfg(feature = "redis")]
            Some(ref url) => Arc::new(RedisSink::new(url).await?),
            #[cfg(not(feature = "redis"))]
            Some(_) => return Err(Error::RedisFeatureDisabled),
            None => Arc::new(LogSink),
        };

        let (flush_tx, flush_rx) = mpsc::channel::<()>(1);

        let inner = Arc::new(CdrWriterInner {
            cache: DashMap::new(),
            wal_buffer: Mutex::new(Vec::new()),
            sink,
            config,
            flush_tx,
        });

        let flush_handle = CdrWriter { inner: inner.clone() };
        tokio::spawn(async move {
            flush_handle.flush_loop(flush_rx).await;
        });

        Self { inner }
    }

    /// 创建新 CDR 记录，由调用方构建完整 CdrRecord
    pub async fn create(&self, mut record: CdrRecord) -> String {
        record.cdr_id = Uuid::new_v4().to_string();
        record.start_time = Utc::now();
        self.inner.cache.insert(record.cdr_id.clone(), record);
        record.cdr_id.clone()
    }

    /// 更新 CDR 字段
    pub async fn update<F>(&self, cdr_id: &str, updater: F)
    where
        F: FnOnce(&mut CdrRecord),
    {
        if let Some(mut entry) = self.inner.cache.get_mut(cdr_id) {
            updater(entry.value_mut());
        }
    }

    /// 呼叫结束，计算时长并写入 WAL 缓冲
    pub async fn finalize(&self, cdr_id: &str, cause: HangupCause, hangup_by: HangupBy) {
        let should_flush = if let Some(mut entry) = self.inner.cache.get_mut(cdr_id) {
            let cdr = entry.value_mut();
            cdr.end_time = Some(Utc::now());
            cdr.hangup_cause = cause;
            cdr.hangup_by = hangup_by;
            cdr.compute_duration();
            cdr.compute_ring_duration();

            let mut buffer = self.inner.wal_buffer.lock().await;
            buffer.push(cdr.clone());
            buffer.len() >= self.inner.config.max_buffer_size
        } else {
            false
        };

        if should_flush {
            let _ = self.inner.flush_tx.send(()).await;
        }
    }

    pub fn cache_size(&self) -> usize { self.inner.cache.len() }
    pub fn get_cached(&self, cdr_id: &str) -> Option<CdrRecord> { /* ... */ }
}
```

### 4.2 刷盘循环

```rust
impl CdrWriter {
    async fn flush_loop(self, mut flush_rx: mpsc::Receiver<()>) {
        let mut interval = tokio::time::interval(
            Duration::from_millis(self.inner.config.flush_interval_ms)
        );
        loop {
            tokio::select! {
                _ = interval.tick() => self.flush_sink().await,
                _ = flush_rx.recv() => self.flush_sink().await,
            }
        }
    }

    async fn flush_sink(&self) {
        let records: Vec<CdrRecord> = {
            let mut buffer = self.inner.wal_buffer.lock().await;
            if buffer.is_empty() { return; }
            std::mem::take(&mut *buffer)
        };

        if let Err(e) = self.inner.sink.flush(&records).await {
            error!(error = %e, "CDR sink flush failed");
            self.inner.wal_buffer.lock().await.extend(records);
        } else {
            info!(count = records.len(), "flushed CDR records");
        }
    }
}
```

---

## 5. 依赖

```toml
[features]
default = ["redis"]
redis = ["dep:redis"]

[dependencies]
nextswitch-core = { path = "../nextswitch-core" }
tokio = { workspace = true }
tracing = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
dashmap = "6"
async-trait = "0.1"
redis = { version = "0.27", features = ["tokio-comp", "connection-manager"], optional = true }
```

---

## 6. 设计决策

| 决策 | 理由 |
|------|------|
| `create()` 接受 `CdrRecord` 而非 `CallContext` | sipserver 和 sigserver 的上下文结构不同，由调用方构建 record 更灵活 |
| `CdrSink` trait 抽象刷盘后端 | 测试用 `LogSink`，生产用 `RedisSink`，不强制依赖 Redis |
| `ConnectionManager` 而非 `MultiplexedConnection` | 自带断线重连，CDR 不能因 Redis 断连而丢失 |
| `Arc<Inner>` 结构 | `flush_loop` 作为方法运行在 `tokio::spawn` 中，避免自由函数分散逻辑 |
| 不用 `metrics` crate | 当前阶段用 `tracing` 记录刷盘数量即可，后续按需接入 |
| `redis` 为 optional 依赖，`redis` feature 控制 | redis crate 较重，不用 Redis 的场景无需编译；默认开启 |
| `HangupBy` 含座席/班长/IVR/队列 | 呼叫中心场景需要区分挂断方角色 |
| `HangupCause` 覆盖 Q.850 常见原因 | SIP 响应码通过 `from_sip_code()` 映射，覆盖 4xx/6xx 主要场景 |
