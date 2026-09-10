# 信令服务器配置管理设计

> 本文档是 [信令服务器细化设计索引](2026-09-10-signaling-00-index.md) 的第 6 部分。

---

## 1. 配置来源与优先级

sipserver/sigserver 的配置来自多个来源，按优先级从高到低：

| 优先级 | 来源 | 说明 | 更新方式 |
|--------|------|------|---------|
| 1（最高） | 运行时配置变更 | Redis Pub/Sub 增量通知 | 实时推送 |
| 2 | 服务注册表缓存 | Redis `svc:{service}` 键，本地 LRU 缓存 | 定时刷新 + 惰性更新 |
| 3 | 启动时全量快照 | config-service gRPC `GetSnapshot()` | 启动时拉取 |
| 4 | 本地配置文件 | TOML 文件（服务配置、超时/重试参数） | 重启生效 |
| 5（最低） | 代码默认值 | Rust 代码中的默认常量 | 重新编译 |

> **分层原则**：本地配置文件（TOML）仅包含与基础设施相关的静态参数（端口、地址、超时、证书路径等）以及 gRPC 调用的超时/重试策略。**服务间 gRPC 对端地址不再静态配置**，而是通过 Redis 服务注册表动态获取（详见 §6）。业务配置（租户、分机、路由规则、中继等）通过 config-service 动态下发，不在本地文件中维护。

---

## 2. 本地配置文件

```toml
# sipserver.toml

[server]
instance_id = "sipserver-01"
site_id = "us-east-1"
az_id = "us-east-1a"

[transport]
[[transport.binds]]
protocol = "udp"
addr = "0.0.0.0"
port = 5060
workers = 8

[[transport.binds]]
protocol = "tcp"
addr = "0.0.0.0"
port = 5060

[[transport.binds]]
protocol = "tls"
addr = "0.0.0.0"
port = 5061
cert_file = "/etc/nextswitch/certs/sip.pem"
key_file = "/etc/nextswitch/certs/sip.key"
ca_file = "/etc/nextswitch/certs/ca.pem"

[redis]
urls = ["redis://redis-01:6379", "redis://redis-02:6379", "redis://redis-03:6379"]
cluster_mode = true
tls_enabled = true
password_vault_path = "secret/data/redis/password"
connect_timeout_ms = 1000
operation_timeout_ms = 100
max_retries = 2

[service_discovery]
registry_prefix = "svc"
cache_ttl_secs = 15
refresh_interval_secs = 5
connect_timeout_ms = 2000

[grpc.router_server]
request_timeout_ms = 1000
max_retries = 1

[grpc.medserver]
request_timeout_ms = 500
max_retries = 1

[grpc.config_service]
request_timeout_ms = 5000
max_retries = 3

[cache]
registration_cache_size = 100000
registration_cache_ttl_secs = 30
route_rule_cache_size = 10000

[cac]
max_system_calls = 10000
max_tenant_calls_default = 500
max_extension_calls_default = 5
invite_cps_per_ip = 10

[health]
port = 5080

[metrics]
port = 5080
path = "/metrics"

[tracing]
exporter = "otlp"
endpoint = "http://otel-collector:4317"
service_name = "sipserver"
sample_rate = 0.1

[cdr]
wal_dir = "/data/cdr/wal"
flush_interval_ms = 100
max_buffer_size = 10000
```

> **sigserver 端口差异**：上述配置为 sipserver 示例。sigserver 使用不同端口：
> - `[health]` 和 `[metrics]`：`port = 9094`
> - gRPC 客户端端口：`50052`（sipserver 为 `50051`）
> - WebSocket (WSS)：`5443`（与 SIP WSS 共享端口，通过路径区分）

---

## 3. 配置热更新流程

```
config-service (DB 写入)
    │
    ▼
Redis Pub/Sub: config:{tid}:{entity}
    │
    ├─► sipserver 订阅
    │     │
    │     ▼
    │   ConfigWatcher 接收变更事件
    │     │
    │     ├─ 单条更新 → 增量更新 HashMap
    │     │
    │     └─ 批量/规则变更 → 构建新快照 → Arc 原子替换
    │           │
    │           ▼
    │         新请求使用新配置（无锁、无中断）
    │
    └─► sigserver 订阅（同上流程）
```

### 3.1 ConfigWatcher 实现

```rust
pub struct ConfigWatcher {
    /// 本地配置缓存（Arc 原子替换，读无锁）
    config: Arc<RwLock<LocalConfigCache>>,
    /// Redis Pub/Sub 订阅
    redis_pubsub: PubSub,
    /// config-service gRPC 客户端（用于全量加载和单条实体拉取）
    config_client: ConfigServiceClient,
    /// 当前配置版本号
    version: AtomicU64,
}

impl ConfigWatcher {
    /// 启动时全量加载
    pub async fn initial_load(&self) -> Result<()> {
        let snapshot = self.config_client.get_snapshot(GetSnapshotRequest {
            entity_types: vec![
                "tenants".into(), "extensions".into(), "trunks".into(),
                "dids".into(), "route_points".into(), "routing_rules".into(),
                "dial_plans".into(), "time_conditions".into(), "call_flows".into(),
                "ivr_flows".into(), "ivr_prompts".into(), "skill_groups".into(),
                "call_queues".into(),
            ],
            include_deleted: false,
        }).await?;

        let cache = LocalConfigCache::from_snapshot(&snapshot);
        *self.config.write() = cache;
        self.version.store(snapshot.version, Ordering::Release);

        info!(version = snapshot.version, "config initial load complete");
        Ok(())
    }

    /// 运行时增量更新循环
    pub async fn watch(&mut self) -> Result<()> {
        // 订阅所有租户的配置变更频道
        self.redis_pubsub.psubscribe("config:*:*").await?;

        while let Some(msg) = self.redis_pubsub.next().await {
            let event: ConfigChangeEvent = serde_json::from_slice(&msg.payload)?;

            match event.action {
                ConfigAction::Create | ConfigAction::Update => {
                    // 从 config-service 拉取最新实体
                    let entity = self.config_client.get_entity(GetEntityRequest {
                        entity_type: event.entity_type.clone(),
                        entity_id: event.entity_id,
                    }).await?;

                    // 更新本地缓存
                    self.config.write().update_entity(event.entity_type, entity);
                }
                ConfigAction::Delete => {
                    self.config.write().remove_entity(
                        &event.entity_type,
                        event.entity_id,
                    );
                }
            }

            self.version.store(event.version, Ordering::Release);

            // 更新 metrics
            metrics::counter!("config_updates_total",
                "entity_type" => event.entity_type.clone(),
                "action" => event.action.as_str(),
            ).increment(1);
        }

        Ok(())
    }
}
```

### 3.2 LocalConfigCache 结构

```rust
/// 信令服务器本地配置缓存（编译后的运行时结构）
pub struct LocalConfigCache {
    /// 租户配置：tenant_id → TenantConfig
    tenants: HashMap<i64, TenantConfig>,
    
    /// 分机配置：(tenant_id, extension) → ExtensionConfig
    extensions: HashMap<(i64, String), ExtensionConfig>,
    
    /// 中继配置：trunk_id → TrunkConfig
    trunks: HashMap<i64, TrunkConfig>,
    
    /// 中继 IP 索引：source_ip → trunk_id（快速入站匹配）
    trunk_ip_index: HashMap<IpAddr, i64>,
    
    /// DID 配置：(tenant_id, phone_number) → DidConfig
    dids: HashMap<(i64, String), DidConfig>,
    
    /// 路由点：(tenant_id, extension) → RoutePointEntry
    route_points: HashMap<(i64, String), RoutePointEntry>,
    
    /// 路由规则：tenant_id → Vec<RoutingRuleEntry>（按 priority DESC 排序）
    routing_rules: HashMap<i64, Vec<RoutingRuleEntry>>,
    
    /// 拨号计划：tenant_id → Vec<DialPlanEntry>（按 priority DESC 排序，正则预编译）
    dial_plans: HashMap<i64, Vec<DialPlanEntry>>,
    
    /// 时间条件：tenant_id → HashMap<String, TimeConditionEntry>
    time_conditions: HashMap<i64, HashMap<String, TimeConditionEntry>>,
    
    /// 呼叫流程：tenant_id → HashMap<i64, CallFlowGraph>
    call_flows: HashMap<i64, HashMap<i64, CallFlowGraph>>,
    
    /// IVR 流程：tenant_id → HashMap<i64, IvrFlowDef>
    ivr_flows: HashMap<i64, HashMap<i64, IvrFlowDef>>,
    
    /// 队列配置：tenant_id → HashMap<i64, QueueConfig>
    call_queues: HashMap<i64, HashMap<i64, QueueConfig>>,
    
    /// 最后同步时间
    last_synced_at: Instant,
    
    /// 配置版本号（每次更新 +1）
    version: u64,
}
```

---

## 4. 配置一致性保障

| 机制 | 说明 |
|------|------|
| 版本号校验 | 每次 Pub/Sub 消息携带 `version`，本地版本落后时触发全量重新加载 |
| 定时对账 | 每 5 分钟向 config-service 请求当前版本号，与本地比对 |
| 全量兜底 | 增量更新累积 100 次后自动触发全量重新加载 |
| 启动校验 | 启动时全量加载后校验关键实体（tenants、extensions）非空 |

### 4.1 定时对账实现

```rust
pub async fn reconcile_loop(
    config_client: &mut ConfigServiceClient,
    version: &AtomicU64,
    trigger_reload: tokio::sync::mpsc::Sender<()>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(300));

    loop {
        interval.tick().await;

        match config_client.get_current_version(GetVersionRequest {}).await {
            Ok(remote_ver) => {
                let local_ver = version.load(Ordering::Acquire);
                if remote_ver.version > local_ver {
                    warn!(
                        local = local_ver,
                        remote = remote_ver.version,
                        "config version mismatch detected, triggering full reload"
                    );
                    let _ = trigger_reload.send(()).await;
                }
            }
            Err(e) => {
                warn!(error = %e, "failed to fetch remote config version");
            }
        }
    }
}
```

---

## 5. 配置降级

| 场景 | 降级行为 |
|------|---------|
| config-service 不可达（启动时） | 重试 3 次后使用本地缓存的上次快照（如有） |
| config-service 不可达（运行时） | 使用本地缓存，无法接收增量更新 |
| Redis Pub/Sub 断开 | 自动重连，重连期间使用本地缓存 |
| 配置数据损坏 | 校验失败时保留旧版本，记录告警 |

### 5.1 启动降级流程

```
启动
  │
  ▼
连接 config-service
  │
  ├─ 成功 → GetSnapshot() → 加载全量配置 → 启动服务
  │
  └─ 失败 → 重试（最多 3 次，间隔 2s/4s/8s）
              │
              ├─ 重试成功 → 加载全量配置 → 启动服务
              │
              └─ 重试失败 → 检查本地快照缓存
                            │
                            ├─ 存在 → 加载上次快照 → 启动服务（标记为 degraded）
                            │
                            └─ 不存在 → 使用代码默认值 → 启动服务（标记为 degraded）
                                        → 仅支持 OPTIONS 响应，拒绝所有 INVITE/REGISTER
```

### 5.2 本地快照缓存

```rust
pub struct SnapshotCache {
    cache_dir: PathBuf,    // /data/nextswitch/config-cache/
    instance_id: String,
}

impl SnapshotCache {
    /// 保存快照到本地磁盘
    pub fn save(&self, snapshot: &ConfigSnapshot) -> Result<()> {
        let path = self.cache_dir.join(format!("{}.json", self.instance_id));
        let json = serde_json::to_vec(snapshot)?;
        // 原子写入：先写临时文件，再 rename
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, &json)?;
        fs::rename(&tmp_path, &path)?;
        Ok(())
    }

    /// 加载上次保存的快照
    pub fn load(&self) -> Result<Option<ConfigSnapshot>> {
        let path = self.cache_dir.join(format!("{}.json", self.instance_id));
        if !path.exists() {
            return Ok(None);
        }
        let json = fs::read(&path)?;
        let snapshot: ConfigSnapshot = serde_json::from_slice(&json)?;
        Ok(Some(snapshot))
    }
}
```

---

## 6. 服务发现与端点缓存

gRPC 对端地址**不再通过 TOML 静态配置**，而是通过 Redis 服务注册表动态获取，并在本地内存缓存。

### 6.1 服务注册表（Redis）

每个服务实例启动时向 Redis 写入注册信息，并通过心跳持续刷新：

```
Redis Key: svc:{service_name}:{instance_id}
TTL: 30s（与心跳共用）
Value (JSON):
{
    "instance_id": "medserver-01",
    "service": "medserver",
    "endpoints": {
        "grpc": "http://10.0.1.5:50051",
        "health": "http://10.0.1.5:9092/health"
    },
    "site_id": "us-east-1",
    "az_id": "us-east-1a",
    "started_at": 1699999999000,
    "load": {
        "active_sessions": 120,
        "cpu_percent": 35.2
    }
}
```

**注册表频道清单**：

| Redis Key 模式 | 写入方 | 读取方 | 用途 |
|---------------|--------|--------|------|
| `svc:{service}:{instance_id}` | 所有服务实例 | 所有需要调用该服务的客户端 | 端点发现与负载均衡 |
| `heartbeat:{service}:{instance_id}` | 所有服务实例 | 信令层（注册表清理） | 实例存活检测 |

> 服务注册表 key 与心跳 key 共用 TTL（30s），由同一心跳协程刷新。注册表 key 包含端点信息，心跳 key 仅用于存活判断，两者职责分离。

### 6.2 ServiceDiscoveryCache 实现

```rust
/// 本地服务发现缓存（从 Redis 服务注册表同步）
pub struct ServiceDiscoveryCache {
    /// 服务名 → 实例列表（本地 LRU 缓存）
    services: DashMap<String, Arc<ServiceEndpoints>>,
    /// Redis 客户端
    redis: Arc<RedisPool>,
    /// 注册表 key 前缀
    prefix: String,
    /// 缓存 TTL
    cache_ttl: Duration,
    /// 定时刷新间隔
    refresh_interval: Duration,
}

pub struct ServiceEndpoints {
    pub service: String,
    pub instances: Vec<ServiceInstance>,
    pub fetched_at: Instant,
}

pub struct ServiceInstance {
    pub instance_id: String,
    pub grpc_endpoint: String,
    pub health_endpoint: String,
    pub site_id: String,
    pub az_id: String,
    pub load: InstanceLoad,
}

impl ServiceDiscoveryCache {
    /// 获取指定服务的所有健康实例
    pub async fn get_endpoints(&self, service: &str) -> Result<Arc<ServiceEndpoints>> {
        // Step 1: 查本地缓存
        if let Some(cached) = self.services.get(service) {
            if cached.fetched_at.elapsed() < self.cache_ttl {
                return Ok(cached.clone());
            }
        }

        // Step 2: 从 Redis 刷新
        let pattern = format!("{}:{}:*", self.prefix, service);
        let instances = self.refresh_from_redis(service, &pattern).await?;

        let endpoints = Arc::new(ServiceEndpoints {
            service: service.to_string(),
            instances,
            fetched_at: Instant::now(),
        });

        self.services.insert(service.to_string(), endpoints.clone());
        Ok(endpoints)
    }

    /// 获取单个健康实例端点（用于 gRPC 连接）
    pub async fn get_healthy_endpoint(&self, service: &str) -> Result<String> {
        let endpoints = self.get_endpoints(service).await?;

        // 轮询选择健康实例（按负载排序）
        for instance in &endpoints.instances {
            let heartbeat_key = format!("heartbeat:{}:{}", service, instance.instance_id);
            let alive: bool = self.redis.exists(&heartbeat_key).await?;
            if alive {
                return Ok(instance.grpc_endpoint.clone());
            }
        }

        Err(Error::NoHealthyEndpoint(service.to_string()))
    }

    /// 从 Redis 扫描服务实例
    async fn refresh_from_redis(
        &self,
        service: &str,
        pattern: &str,
    ) -> Result<Vec<ServiceInstance>> {
        let mut instances = Vec::new();
        let mut cursor = "0";

        loop {
            let (next_cursor, keys): (String, Vec<String>) =
                self.redis.scan(cursor, pattern, 100).await?;

            for key in &keys {
                if let Ok(json) = self.redis.get::<_, String>(key).await {
                    if let Ok(info) = serde_json::from_str::<ServiceRegistryInfo>(&json) {
                        instances.push(ServiceInstance {
                            instance_id: info.instance_id,
                            grpc_endpoint: info.endpoints.grpc,
                            health_endpoint: info.endpoints.health,
                            site_id: info.site_id,
                            az_id: info.az_id,
                            load: info.load,
                        });
                    }
                }
            }

            cursor = next_cursor;
            if cursor == "0" {
                break;
            }
        }

        // 按负载排序（active_sessions 升序）
        instances.sort_by_key(|i| i.load.active_sessions);
        Ok(instances)
    }

    /// 后台定时刷新协程
    pub async fn refresh_loop(&self) {
        let mut interval = tokio::time::interval(self.refresh_interval);
        loop {
            interval.tick().await;
            // 刷新所有已缓存的服务
            for entry in self.services.iter() {
                let service = entry.key().clone();
                let pattern = format!("{}:{}:*", self.prefix, service);
                match self.refresh_from_redis(&service, &pattern).await {
                    Ok(instances) => {
                        let endpoints = Arc::new(ServiceEndpoints {
                            service: service.clone(),
                            instances,
                            fetched_at: Instant::now(),
                        });
                        self.services.insert(service, endpoints);
                    }
                    Err(e) => {
                        warn!(service = %service, error = %e, "failed to refresh service endpoints");
                    }
                }
            }
        }
    }
}

/// Redis 服务注册表值格式
pub struct ServiceRegistryInfo {
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
```

### 6.3 端点解析流程

```
sipserver 需要调用 medserver
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① 查 ServiceDiscoveryCache 本地缓存                       │
│    ├─ 缓存命中且未过期 → 返回实例列表                        │
│    └─ 缓存未命中或已过期 → 继续                              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② Redis SCAN svc:medserver:*                              │
│    ├─ 获取所有 medserver 实例注册信息                        │
│    └─ 按负载排序                                           │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 更新本地缓存                                            │
│    └─ 返回健康实例端点                                      │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ④ gRPC 连接（tonic Channel）                               │
│    └─ 连接池管理（详见 medserver 接口设计 §5）                │
└──────────────────────────────────────────────────────────┘
```

### 6.4 服务发现降级

| 场景 | 降级行为 |
|------|---------|
| Redis 不可达（启动时） | 无法获取任何服务端点，服务启动失败 |
| Redis 不可达（运行时） | 使用本地缓存中的上次端点列表，缓存过期后标记所有服务不可用 |
| 目标服务全部下线 | 返回 `NoHealthyEndpoint` 错误，调用方执行降级逻辑 |
| 部分实例下线 | 心跳检测排除不健康实例，仅返回存活实例 |

### 6.5 与心跳机制的关系

服务注册表与心跳共用同一 Redis TTL 机制，但职责分离：

| 机制 | Redis Key | 用途 | 消费方 |
|------|-----------|------|--------|
| 服务注册表 | `svc:{service}:{instance_id}` | 端点发现（IP、端口） | gRPC 客户端 |
| 心跳 | `heartbeat:{service}:{instance_id}` | 存活检测 | 注册表查询时的校验 |

两者由同一心跳协程刷新，TTL 均为 30s，间隔均为 10s。
