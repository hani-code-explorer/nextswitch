# NextSWITCH 信令服务器 — 服务交互设计

> 本文档是 [信令服务器细化设计索引](./) 的第 1 部分。

---

## 1. 交互总览

sipserver 和 sigserver 作为信令层，与平台内 7 个服务存在直接交互关系。以下按交互对象逐一展开。

### 1.1 交互矩阵（详细版）

| 调用方 | 被调用方 | 协议 | 接口/频道 | 数据格式 | 超时 | 重试 | 降级策略 |
|--------|---------|------|----------|---------|------|------|---------|
| sipserver | config-service | gRPC | `ConfigService.GetSnapshot()` | Protobuf | 5s | 3 次 | 使用本地缓存 |
| sipserver | config-service | Redis Pub/Sub | `config:{tid}:{entity}` | JSON | - | 自动重连 | 本地缓存兜底 |
| sipserver | medserver | gRPC | `MediaService.*` | Protobuf | 500ms | 1 次 | 返回 503，不降级媒体 |
| sipserver | medserver | gRPC 流 | `MediaEvents.SubscribeEvents()` | Protobuf 流 | - | 自动重连 | 事件丢失可容忍 |
| sipserver | Redis | redis-rs | 注册表/心跳/CDR | RESP3 | 100ms | 2 次 | 本地 LRU 缓存 |
| sipserver | sigserver | Redis Pub/Sub | `call:command:{id}` / `call:event:{id}` | JSON | - | 不重试 | 呼叫失败 |
| sigserver | config-service | gRPC | `ConfigService.GetSnapshot()` | Protobuf | 5s | 3 次 | 使用本地缓存 |
| sigserver | config-service | Redis Pub/Sub | `config:{tid}:{entity}` | JSON | - | 自动重连 | 本地缓存兜底 |
| sigserver | medserver | gRPC | `MediaService.*` | Protobuf | 500ms | 1 次 | 返回错误给客户端 |
| sigserver | medserver | gRPC 流 | `MediaEvents.SubscribeEvents()` | Protobuf 流 | - | 自动重连 | 事件丢失可容忍 |
| sigserver | cti-server | Redis Pub/Sub | `cti:agent:{agent_id}:status` | JSON | - | 不重试 | 状态不同步 |
| sigserver | sipserver | Redis Pub/Sub | `call:command:{id}` / `call:event:{id}` | JSON | - | 不重试 | 呼叫失败 |
| nextswitch-api | sipserver/sigserver | HTTP | `GET /health/*` | JSON | 3s | 不重试 | 标记不健康 |
| 所有 gRPC 客户端 | 任意目标服务 | Redis | `svc:{service}:{instance_id}` | JSON | 100ms | 2 次 | 使用本地缓存端点 |

> **端点来源**：所有 gRPC 调用的目标端点地址通过 Redis 服务注册表（`svc:{service}:{instance_id}`）动态获取，由本地 `ServiceDiscoveryCache` 缓存。本地缓存 TTL 15s，后台每 5s 刷新。详见 [配置管理设计](../../config/signaling-config.md) §6。

---

## 2. 与 config-service 交互

### 2.0 服务发现交互

所有服务实例启动后向 Redis 注册自身端点信息，客户端通过 `ServiceDiscoveryCache` 获取目标服务端点：

```
服务实例启动
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ ① 写入 Redis 服务注册表                                     │
│    SET svc:{service}:{instance_id} {endpoints, load, ...} │
│    EXPIRE 30s                                             │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ② 每 10s 心跳刷新                                          │
│    同时刷新 svc: 和 heartbeat: 两个 key（pipeline 批量写入）  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ gRPC 客户端定时刷新本地缓存                                 │
│    每 5s 从 Redis SCAN svc:{target_service}:* 更新本地缓存   │
│    缓存 TTL 15s                                            │
└──────────────────────────────────────────────────────────┘
```

**客户端解析端点流程**：

```rust
/// gRPC 调用前解析目标端点
async fn resolve_grpc_endpoint(
    discovery: &ServiceDiscoveryCache,
    service: &str,
) -> Result<String> {
    // 从本地缓存获取（缓存未命中时自动从 Redis 刷新）
    discovery.get_healthy_endpoint(service).await
}
```

**服务注册表与 gRPC 调用的关系**：

| 步骤 | 动作 | 延迟 |
|------|------|------|
| 1 | 查本地 `ServiceDiscoveryCache` | < 1μs（内存） |
| 2 | 缓存未命中 → Redis SCAN | ~100μs（网络） |
| 3 | 心跳校验实例存活 | ~100μs（网络） |
| 4 | 建立 gRPC 连接 | ~2ms（首次） |

> 正常情况下（缓存命中），端点解析延迟 < 1μs，不影响 gRPC 调用性能。

### 2.1 启动时全量加载

sipserver/sigserver 启动时通过 gRPC 从 config-service 拉取全量配置快照：

```rust
/// 启动时配置加载
pub struct ConfigLoader {
    /// 服务发现缓存（用于获取 config-service 端点）
    discovery: Arc<ServiceDiscoveryCache>,
    local_cache: Arc<RwLock<LocalConfigCache>>,
}

impl ConfigLoader {
    /// 启动时全量加载
    pub async fn load_full_snapshot(&self) -> Result<ConfigSnapshot> {
        // 从服务发现缓存获取 config-service 端点
        let endpoint = self.discovery
            .get_healthy_endpoint("config-service")
            .await?;
        
        let channel = Channel::from_shared(endpoint)?
            .connect_timeout(Duration::from_millis(5000))
            .connect()
            .await?;
        let mut config_client = ConfigServiceClient::new(channel);
        
        let req = GetSnapshotRequest {
            entity_types: vec![
                "tenants".into(),
                "extensions".into(),
                "trunks".into(),
                "dids".into(),
                "route_points".into(),
                "routing_rules".into(),
                "dial_plans".into(),
                "time_conditions".into(),
                "call_flows".into(),
                "ivr_flows".into(),
                "ivr_prompts".into(),
                "skill_groups".into(),
                "call_queues".into(),
            ],
            include_deleted: false,
        };
        
        let resp = self.config_client.get_snapshot(req).await?;
        
        // 编译运行时结构（正则预编译、索引构建）
        let compiled = ConfigCompiler::compile(&resp.entities)?;
        
        // 原子替换本地缓存
        *self.local_cache.write() = compiled;
        
        Ok(resp)
    }
}
```

### 2.2 运行时增量更新

通过 Redis Pub/Sub 接收配置变更通知，增量更新本地缓存：

```
config-service 写入 DB
    │
    ▼
config-service 发布 Redis Pub/Sub
    频道：config:{tenant_id}:{entity_type}
    消息：{ "action": "update", "entity_id": 123, "version": 456 }
    │
    ▼
sipserver/sigserver 订阅频道接收消息
    │
    ├─ action=create/update → gRPC 拉取单条实体最新值 → 更新本地缓存
    └─ action=delete → 从本地缓存移除
```

**增量更新流程**：

```rust
pub struct ConfigWatcher {
    redis_pubsub: PubSub,
    /// 服务发现缓存（用于获取 config-service 端点）
    discovery: Arc<ServiceDiscoveryCache>,
    local_cache: Arc<RwLock<LocalConfigCache>>,
}

impl ConfigWatcher {
    /// 监听配置变更
    pub async fn watch(&mut self) -> Result<()> {
        // 订阅所有租户的配置变更频道
        self.redis_pubsub.psubscribe("config:*:*").await?;
        
        while let Some(msg) = self.redis_pubsub.next().await {
            let event: ConfigChangeEvent = serde_json::from_slice(&msg.payload)?;
            
            match event.action {
                ConfigAction::Create | ConfigAction::Update => {
                    // 从服务发现缓存获取 config-service 端点，拉取最新实体
                    let endpoint = self.discovery
                        .get_healthy_endpoint("config-service")
                        .await?;
                    let channel = Channel::from_shared(endpoint)?
                        .connect()
                        .await?;
                    let mut config_client = ConfigServiceClient::new(channel);
                    
                    let entity = config_client.get_entity(GetEntityRequest {
                        entity_type: event.entity_type.clone(),
                        entity_id: event.entity_id,
                    }).await?;
                    
                    // 更新本地缓存
                    self.local_cache.write().update_entity(event.entity_type, entity);
                }
                ConfigAction::Delete => {
                    self.local_cache.write().remove_entity(
                        &event.entity_type,
                        event.entity_id,
                    );
                }
            }
            
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

**配置变更频道与实体类型映射**：

| 频道模式 | 实体类型 | 消费方 | 缓存更新动作 |
|---------|---------|--------|------------|
| `config:{tid}:tenants` | tenants | sipserver, sigserver | 更新租户状态/设置 |
| `config:{tid}:extensions` | extensions | sipserver, sigserver | 更新分机配置、密码哈希 |
| `config:{tid}:trunks` | trunks | sipserver | 更新中继配置、IP 白名单 |
| `config:{tid}:dids` | dids | sipserver | 更新 DID 映射、call_flow 绑定 |
| `config:{tid}:route_points` | route_points | sipserver | 更新路由点查找表 |
| `config:{tid}:routing_rules` | routing_rules | sipserver | 重建规则匹配器（Arc 原子替换） |
| `config:{tid}:dial_plans` | dial_plans | sipserver | 重建拨号计划（正则预编译） |
| `config:{tid}:time_conditions` | time_conditions | sipserver | 更新时间条件评估器 |
| `config:{tid}:call_flows` | call_flows | sipserver | 重建呼叫流程图（Arc 原子替换） |
| `config:{tid}:ivr_flows` | ivr_flows | sipserver | 更新 IVR 流程定义 |
| `config:{tid}:ivr_prompts` | ivr_prompts | sipserver | 更新提示音资源映射 |
| `config:{tid}:call_queues` | call_queues | sipserver, sigserver | 更新队列配置 |
| `config:{tid}:skill_groups` | skill_groups | sipserver | 更新技能组配置 |

### 2.3 本地缓存结构

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

**缓存更新策略**：

- **不可变快照 + Arc 原子替换**：路由规则、拨号计划、呼叫流程等高频读数据结构编译为不可变快照，更新时构建新快照后通过 `Arc::swap` 原子替换，读操作无锁。
- **增量更新**：单条实体变更（如分机配置修改）直接更新 HashMap 条目。
- **全量重建**：当增量更新累积超过阈值（如 100 次变更）或检测到数据不一致时，触发全量重新加载。

---

## 3. 路由决策（信令服务器本地执行）

### 3.1 路由执行模式

路由决策逻辑已在信令服务器（sipserver/sigserver）本地执行，不再调用独立的 router-server 服务。sipserver 直接在本地完成两层路由（快速规则 + 图引擎）：

| 场景 | 触发条件 | 路由执行方式 |
|------|---------|------------|
| DID 绑定呼叫流程 | DID 的 `call_flow_id` 非 NULL | 本地加载 call_flow 配置，执行流程实例 |
| 路由规则匹配 | 本地路由规则命中 | 本地快速规则匹配 |
| 时间条件路由 | 路由规则引用了 `time_condition_id` | 本地评估时间条件 |
| IVR 流程入口 | 路由点 `route_type=ivr` | 本地决策后通过 gRPC ProcessCall 委托 medserver |
| ACD 排队 | 路由点 `route_type=queue` | 本地决策后通过 Redis Pub/Sub 通知 cti-server |

```rust
/// 信令服务器本地路由决策流程
pub async fn local_route_decision(
    &self,
    ctx: &CallContext,
) -> Result<RouteResponse, RoutingError> {
    let start = Instant::now();
    let cache = self.config_cache.read();
    
    // Step 1: 号码标准化（本地 dial_plans）
    let normalized = self.normalize_number(&cache.dial_plans, &ctx.callee, ctx.tenant_id);
    
    // Step 2: 路由点查找
    if let Some(rp) = cache.route_points.get(&(ctx.tenant_id, normalized.clone())) {
        return Ok(self.build_response_from_route_point(rp, ctx));
    }
    
    // Step 3: 规则匹配（本地 routing_rules，按优先级排序）
    if let Some(rules) = cache.routing_rules.get(&ctx.tenant_id) {
        for rule in rules {
            if self.evaluate_condition(&rule.condition, ctx) {
                let elapsed = start.elapsed();
                metrics::histogram!("routing_decision_duration_us",
                    "source" => "local",
                ).record(elapsed.as_micros() as f64);
                return Ok(self.build_response_from_action(&rule.action));
            }
        }
    }
    
    Err(RoutingError::NoMatch)
}
```

### 3.2 RouteResponse 处理

本地路由决策返回的 `RouteDecision` 决定 sipserver 的后续行为：

| RouteDecision | sipserver 动作 |
|---------------|---------------|
| `DIRECT` | 查注册表，转发 INVITE 到目标分机 |
| `QUEUE` | 通过 Redis Pub/Sub 通知 cti-server 执行 ACD 排队 |
| `IVR` | B2BUA 降级，通过 gRPC ProcessCall 委托 medserver 创建 IVR 媒体会话 |
| `TRUNK` | 转发 INVITE 到目标中继 |
| `CALL_FLOW` | B2BUA 降级，通过 gRPC ProcessCall 委托 medserver 启动图引擎流程实例 |
| `CONFERENCE` | B2BUA 降级，通过 gRPC ProcessCall 委托 medserver 创建会议会话 |
| `EXTERNAL` | 转发到外部路由目标 |
| `DENY` | 回复 403 Forbidden |
| `NO_MATCH` | 播放"号码不存在"提示后挂断 |

---

## 4. 与 medserver 交互

> 详见 [medserver 接口设计](../media/interface.md)

---

## 5. 与 cti-server 交互

### 5.1 交互模式

sipserver/sigserver 与 cti-server 的交互主要通过 Redis Pub/Sub 实现，用于坐席状态同步和呼叫事件传递。

```
sipserver/sigserver                    cti-server
       │                                     │
       │  call:command:{cti-instance-id}     │
       │ ──────────────────────────────────► │  呼叫事件通知
       │  {                                  │
       │    "event": "call_started",         │
       │    "call_id": "abc123",             │
       │    "caller": "1001",                │
       │    "callee": "1002",                │
       │    "tenant_id": 1                   │
       │  }                                  │
       │                                     │
       │  cti:agent:{agent_id}:status        │
       │ ◄────────────────────────────────── │  坐席状态变更
       │  {                                  │
       │    "agent_id": "A001",              │
       │    "status": "ready",               │
       │    "available": true                │
       │  }                                  │
       │                                     │
       │  call:command:{sip-instance-id}     │
       │ ◄────────────────────────────────── │  呼叫控制指令
       │  {                                  │
       │    "command": "bridge",             │
       │    "call_id": "abc123",             │
       │    "target_agent": "A001"           │
       │  }                                  │
```

### 5.2 呼叫事件类型

| 事件 | 方向 | 触发时机 | 数据 |
|------|------|---------|------|
| `call_started` | sip→cti | INVITE 被处理 | call_id, caller, callee, tenant_id |
| `call_answered` | sip→cti | 被叫应答 | call_id, answer_time |
| `call_ended` | sip→cti | 通话结束 | call_id, duration, hangup_cause |
| `call_held` | sip→cti | 通话保持 | call_id |
| `call_resumed` | sip→cti | 通话恢复 | call_id |
| `agent_status` | cti→sip | 坐席状态变更 | agent_id, status, available |
| `bridge_request` | cti→sip | 坐席分配完成 | call_id, target_agent |
| `monitor_request` | cti→sip | 监听/插话/强拆 | call_id, monitor_type, monitor_agent |

### 5.3 ACD 排队集成

当本地路由决策返回 `QUEUE` 决策时，sipserver 与 cti-server 的协作流程：

```
sipserver                           cti-server                    medserver
    │                                   │                            │
    │  call:command:{cti-id}            │                            │
    │  { "command": "enqueue",          │                            │
    │    "call_id": "abc",              │                            │
    │    "queue_id": 10,                │                            │
    │    "priority": 0 }                │                            │
    │ ────────────────────────────────► │                            │
    │                                   │                            │
    │                                   │  执行 ACD 策略              │
    │                                   │  ├─ 检查队列容量             │
    │                                   │  ├─ 查找可用坐席             │
    │                                   │  └─ 坐席分配                │
    │                                   │                            │
    │  call:command:{sip-id}            │                            │
    │  { "command": "play_moh",         │                            │
    │    "call_id": "abc",              │                            │
    │    "moh_uri": "sales_moh" }       │                            │
    │ ◄──────────────────────────────── │                            │
    │                                   │                            │
    │  请求 medserver 播放等待音乐        │                            │
    │ ─────────────────────────────────────────────────────────────► │
    │                                   │                            │
    │  ... 等待坐席 ...                  │                            │
    │                                   │                            │
    │  call:command:{sip-id}            │                            │
    │  { "command": "bridge",           │                            │
    │    "call_id": "abc",              │                            │
    │    "target_agent": "A001" }       │                            │
    │ ◄──────────────────────────────── │                            │
    │                                   │                            │
    │  桥接呼叫到坐席 A001               │                            │
```

---

## 6. sipserver ↔ sigserver 跨协议协作

### 6.1 Redis Pub/Sub 协调协议

sipserver 和 sigserver 通过 Redis Pub/Sub 实现跨协议呼叫协调。

**频道命名**：

| 频道 | 订阅方 | 发布方 | 用途 |
|------|--------|--------|------|
| `call:command:{sipserver-id}` | sipserver | sigserver | 向 sipserver 发送指令（如发起 SIP INVITE） |
| `call:event:{sipserver-id}` | sigserver | sipserver | 向 sigserver 推送 SIP 事件（如 180 Ringing） |
| `call:command:{sigserver-id}` | sigserver | sipserver | 向 sigserver 发送指令（如推送来电通知） |
| `call:event:{sigserver-id}` | sipserver | sigserver | 向 sipserver 推送 WebRTC 事件（如 answer SDP） |

**消息信封格式**：

```json
{
    "message_id": "uuid-v4",
    "timestamp": 1699999999000,
    "source_instance": "sigserver-01",
    "target_instance": "sipserver-02",
    "call_id": "abc123",
    "command": "invite",
    "payload": { ... }
}
```

**跨协议命令清单**：

| 命令/事件 | 方向 | 触发场景 | payload 关键字段 |
|----------|------|---------|-----------------|
| `command: invite` | sigserver → sipserver | WebRTC 发起呼叫到 SIP 分机 | `caller`, `callee`, `sdp_offer`, `headers` |
| `command: bye` | sigserver → sipserver | WebRTC 客户端挂断 | `call_id`, `reason` |
| `command: dtmf` | sigserver → sipserver | WebRTC 客户端发送 DTMF | `call_id`, `digit`, `duration_ms` |
| `command: hold` | sigserver → sipserver | WebRTC 客户端保持通话 | `call_id` |
| `command: resume` | sigserver → sipserver | WebRTC 客户端恢复通话 | `call_id` |
| `command: transfer` | sigserver → sipserver | WebRTC 客户端发起转接 | `call_id`, `target_extension` |
| `event: ringing` | sipserver → sigserver | SIP 被叫振铃 | `call_id`, `sip_status: 180` |
| `event: answered` | sipserver → sigserver | SIP 被叫应答 | `call_id`, `sip_status: 200`, `sdp_answer` |
| `event: call_ended` | sipserver → sigserver | SIP 侧通话结束 | `call_id`, `hangup_cause`, `duration_secs` |
| `event: dtmf` | sipserver → sigserver | SIP 侧收到 DTMF | `call_id`, `digit`, `duration_ms` |
| `event: call_progress` | sipserver → sigserver | SIP 进度音（如 183 Session Progress） | `call_id`, `sip_status`, `reason` |

---

### 6.2 呼叫流程场景总览

| 场景编号 | 场景名称 | 主叫类型 | 被叫类型 | 处理模式 |
|---------|---------|---------|---------|---------|
| CF-01 | WebRTC → SIP | sigserver | sipserver | 跨协议协调 |
| CF-02 | SIP → WebRTC | sipserver | sigserver | 跨协议协调 |
| CF-03 | SIP → SIP（同实例） | sipserver | sipserver | 本地代理 |
| CF-04 | SIP → SIP（跨实例） | sipserver | sipserver | Redis 注册表路由 |
| CF-05 | WebRTC → WebRTC | sigserver | sigserver | 跨实例协调 |
| CF-06 | 外部来电 → SIP | Trunk | sipserver | DID/入站路由 |
| CF-07 | 外部来电 → WebRTC | Trunk | sigserver | DID/入站路由 |
| CF-08 | 呼叫转接（盲转） | 任意 | 任意 | REFER 处理 |
| CF-09 | 呼叫转接（咨询转） | 任意 | 任意 | B2BUA 桥接 |
| CF-10 | 呼叫保持/恢复 | 任意 | 任意 | INVITE HOLD/RESUME |
| CF-11 | IVR 交互 | 任意 | medserver | B2BUA + 媒体播放 |
| CF-12 | 通话录音激活 | 任意 | medserver | ModifySession |

---

### 6.3 CF-01: WebRTC (1001) → SIP (1002) 呼叫流程

```
1001 (WebRTC)      sigserver-01        Redis           sipserver-02       1002 (SIP)
     │                   │                  │                  │                │
     │ invite (SDP)      │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │ 查询注册表        │                  │                │
     │                   │ 1002→sipserver-02│                  │                │
     │                   │ ────────────────►│                  │                │
     │                   │                  │                  │                │
     │                   │ call:command:    │                  │                │
     │                   │   sipserver-02   │                  │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │ { command: "invite",               │                │
     │                   │   caller: "1001",                  │                │
     │                   │   callee: "1002",                  │                │
     │                   │   sdp_offer: "..." }               │                │
     │                   │                  │                  │                │
     │                   │                  │                  │ SIP INVITE     │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │                   │                  │                  │ 180 Ringing    │
     │                   │                  │                  │ ◄──────────────│
     │                   │                  │                  │                │
     │                   │ call:event:      │                  │                │
     │                   │   sigserver-01│                  │                │
     │                   │ ◄──────────────────────────────────│                │
     │                   │ { event: "ringing" }                │                │
     │                   │                  │                  │                │
     │ call_progress     │                  │                  │                │
     │ (ringing)         │                  │                  │                │
     │ ◄────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │                   │                  │                  │ 200 OK (SDP)   │
     │                   │                  │                  │ ◄──────────────│
     │                   │ call:event:      │                  │                │
     │                   │ ◄──────────────────────────────────│                │
     │ call_progress     │                  │                  │                │
     │ (answered, SDP)   │                  │                  │                │
     │ ◄────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │ 媒体流：1001 ↔ medserver (WebRTC) ↔ medserver (RTP) ↔ 1002             │
```

**关键点**：
- sigserver 从 Redis 注册表查询被叫所在 sipserver 实例
- sigserver 作为 gRPC 客户端调用 medserver 创建 WebRTC 媒体桥接会话
- sipserver 收到 `call:command` 后发起标准 SIP INVITE
- 媒体路径：WebRTC ↔ medserver（DTLS-SRTP）↔ medserver（RTP）↔ SIP

---

### 6.4 CF-02: SIP (1001) → WebRTC (1002) 呼叫流程

```
1001 (SIP)         sipserver-01           Redis           sigserver-02    1002 (WebRTC)
     │                   │                  │                  │                │
     │ SIP INVITE        │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │ 查询注册表        │                  │                │
     │                   │ 1002→sigserver-02                │                │
     │                   │ ────────────────►│                  │                │
     │                   │                  │                  │                │
     │                   │ call:command:    │                  │                │
     │                   │   sigserver-02│                  │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │ { command: "incoming_call",        │                │
     │                   │   caller: "1001",                  │                │
     │                   │   callee: "1002",                  │                │
     │                   │   caller_name: "张三" }             │                │
     │                   │                  │                  │                │
     │                   │                  │                  │ incoming_call  │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │                   │                  │                  │ invite (SDP)   │
     │ 100 Trying        │                  │                  │ ◄──────────────│
     │ ◄─────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │                   │ call:event:      │                  │                │
     │                   │   sipserver-01   │                  │                │
     │                   │ ◄──────────────────────────────────│                │
     │                   │ { event: "ringing" }                │                │
     │                   │                  │                  │                │
     │ 180 Ringing       │                  │                  │                │
     │ ◄─────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │                   │ call:event:      │                  │                │
     │                   │   sipserver-01   │                  │                │
     │                   │ ◄──────────────────────────────────│                │
     │                   │ { event: "answered",               │                │
     │                   │   sdp_answer: "..." }              │                │
     │                   │                  │                  │                │
     │ 200 OK (SDP)      │                  │                  │                │
     │ ◄─────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │ ACK               │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │                  │                  │                │
     │ 媒体流：1001 ↔ sipserver (RTP) ↔ medserver (RTP) ↔ medserver (WebRTC) ↔ 1002 │
```

**关键点**：
- sipserver 从 Redis 注册表查询被叫所在 sigserver 实例
- sipserver 通过 `call:command` 通知 sigserver 有来电
- sigserver 向 WebRTC 客户端推送 `incoming_call` 通知
- WebRTC 客户端应答后，sigserver 将 SDP answer 通过 `call:event` 回传给 sipserver
- sipserver 作为 gRPC 客户端调用 medserver 创建 B2BUA 媒体会话（协议转换）

---

### 6.5 CF-03: SIP → SIP（同实例本地代理）

```
1001 (SIP)         sipserver-01                          1002 (SIP)
     │                   │                                    │
     │ SIP INVITE        │                                    │
     │ ─────────────────►│                                    │
     │                   │                                    │
     │                   │ ① Pre-Route 管线                    │
     │                   │   ├─ 防火墙检查                     │
     │                   │   ├─ 速率限制                       │
     │                   │   └─ 呼叫准入控制（CAC）              │
     │                   │                                    │
     │                   │ ② 路由决策                          │
     │                   │   ├─ 本地路由规则匹配                 │
     │                   │   └─ 查本地注册表 → 1002 在本实例      │
     │                   │                                    │
     │                   │ ③ 转发 INVITE                       │
     │                   │ ──────────────────────────────────►│
     │                   │                                    │
     │                   │              180 Ringing           │
     │                   │ ◄──────────────────────────────────│
     │ 180 Ringing       │                                    │
     │ ◄─────────────────│                                    │
     │                   │                                    │
     │                   │              200 OK (SDP)          │
     │                   │ ◄──────────────────────────────────│
     │ 200 OK (SDP)      │                                    │
     │ ◄─────────────────│                                    │
     │                   │                                    │
     │ ACK               │                                    │
     │ ─────────────────►│              ACK                   │
     │                   │ ──────────────────────────────────►│
     │                   │                                    │
     │ ══════════════════ RTP 媒体流（端到端，不经过 medserver）══════════════════
```

**关键点**：
- 纯代理模式，不创建媒体会话
- SDP 透传（可选 SDP 重写用于 NAT 穿越）
- 媒体路径：1001 ↔ 1002 直连（端到端 RTP）
- 仅在需要录音、会议、IVR 时才降级为 B2BUA

---

### 6.6 CF-04: SIP → SIP（跨实例代理）

```
1001 (SIP)         sipserver-01           Redis           sipserver-02       1002 (SIP)
     │                   │                  │                  │                │
     │ SIP INVITE        │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │                  │                  │                │
     │                   │ ① 查本地注册表    │                  │                │
     │                   │   → 1002 不在本实例                  │                │
     │                   │                  │                  │                │
     │                   │ ② 查 Redis 注册表│                  │                │
     │                   │   HGET reg:sip:1001@tenant1        │                │
     │                   │ ────────────────►│                  │                │
     │                   │                  │                  │                │
     │                   │ { instance_id: "sipserver-02",     │                │
     │                   │   contact: "sip:1002@10.0.2.5:5060" }               │
     │                   │ ◄────────────────│                  │                │
     │                   │                  │                  │                │
     │                   │ ③ 转发 INVITE（添加 Record-Route）   │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │                                    │                │
     │                   │              180 Ringing           │                │
     │                   │ ◄──────────────────────────────────│                │
     │ 180 Ringing       │                                    │                │
     │ ◄─────────────────│                                    │                │
     │                   │                                    │                │
     │                   │              200 OK (SDP)          │                │
     │                   │ ◄──────────────────────────────────│                │
     │ 200 OK (SDP)      │                                    │                │
     │ ◄─────────────────│                                    │                │
     │                   │                                    │                │
     │ ACK               │                                    │                │
     │ ─────────────────►│              ACK                   │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │                                    │                │
     │ ══════════════════ RTP 媒体流（端到端，sipserver 仅信令中转）═════════════════
```

**关键点**：
- sipserver 通过 Redis 注册表定位被叫所在实例
- 使用 Record-Route 确保后续请求（BYE、re-INVITE）经过同一路径
- 媒体仍为端到端直连（除非触发 B2BUA 降级）
- 跨实例通信依赖 Redis 注册表的实时性（TTL = 注册过期时间）

---

### 6.7 CF-05: WebRTC → WebRTC 呼叫流程

```
1001 (WebRTC)      sigserver-01        Redis           sigserver-02    1002 (WebRTC)
     │                   │                  │                  │                │
     │ invite (SDP)      │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │                  │                  │                │
     │                   │ ① 查 Redis 注册表│                  │                │
     │                   │   1002→sigserver-02              │                │
     │                   │ ────────────────►│                  │                │
     │                   │ ◄────────────────│                  │                │
     │                   │                  │                  │                │
     │                   │ ② 调用 medserver 创建会议会话         │                │
     │                   │   CreateSession(conference)         │                │
     │                   │ ──────────────────────────────────────────────────────
     │                   │ { media_endpoint: rtp://medserver:10000,             │
     │                   │   conference_id: "conf-abc" }       │                │
     │                   │ ◄──────────────────────────────────────────────────────
     │                   │                  │                  │                │
     │                   │ ③ call:command:  │                  │                │
     │                   │   sigserver-02│                  │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │ { command: "incoming_call",        │                │
     │                   │   caller: "1001",                  │                │
     │                   │   callee: "1002",                  │                │
     │                   │   conference_id: "conf-abc",       │                │
     │                   │   medserver_endpoint: "rtp://..." }│                │
     │                   │                  │                  │                │
     │                   │                  │                  │ incoming_call  │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │                   │                  │                  │ invite (SDP)   │
     │                   │                  │                  │ (指向 medserver)│
     │                   │                  │                  │ ◄──────────────│
     │                   │                  │                  │                │
     │ invite_response   │                  │                  │                │
     │ (SDP answer)      │                  │                  │                │
     │ ◄────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │                   │                  │                  │ answer         │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │ ═══ WebRTC ═══════ │ ═══ RTP ══════════ medserver ═══════ RTP ════════════ │ ═══ WebRTC ═══
     │   1001 ↔ medserver  │   medserver ↔ conference bridge ↔ medserver  │   medserver ↔ 1002
```

**关键点**：
- WebRTC 端到端呼叫通过 medserver 的会议桥接实现（无法直连 ICE）
- 两个 WebRTC 客户端分别连接到 medserver 的会议端口
- medserver 负责混音和媒体转发
- sigserver 之间通过 Redis Pub/Sub 协调

---

### 6.8 CF-06: 外部来电（Trunk）→ SIP 分机

```
PSTN/SIP Trunk       sipserver-01           Redis           1002 (SIP)
     │                   │                  │                  │
     │ SIP INVITE        │                  │                  │
     │ (From: +1234567890)                  │                  │
     │ (To: DID 号码)    │                  │                  │
     │ ─────────────────►│                  │                  │
     │                   │                  │                  │
     │                   │ ① 入站 Trunk 识别│                  │
     │                   │   ├─ 源 IP 匹配 trunk_ip_index      │
     │                   │   └─ 或 DID 号码匹配 dids 表         │
     │                   │                  │                  │
     │                   │ ② 路由决策        │                  │
     │                   │   ├─ DID 绑定 call_flow → 执行呼叫流程│
     │                   │   ├─ DID 绑定分机 → 直接路由          │
     │                   │   └─ 无匹配 → 路由规则或拒绝          │
     │                   │                  │                  │
     │                   │ ③ 查 Redis 注册表│                  │
     │                   │   1002→sipserver-01 (本实例)         │
     │                   │ ────────────────►│                  │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ④ 转发 INVITE（重写主叫号码）          │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │              180 Ringing           │
     │ 180 Ringing       │ ◄──────────────────────────────────│
     │ ◄─────────────────│                  │                  │
     │                   │                  │                  │
     │                   │              200 OK (SDP)          │
     │ 200 OK (SDP)      │ ◄──────────────────────────────────│
     │ ◄─────────────────│                  │                  │
     │                   │                  │                  │
     │ ACK               │                  │                  │
     │ ─────────────────►│              ACK                   │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │ ══════════════════ RTP 媒体流 ═══════════════════════════════════════
```

**关键点**：
- 入站 Trunk 识别：源 IP 白名单或 DID 号码匹配
- 主叫号码重写：外部号码 → 内部号码（可选）
- 如 DID 绑定了 `call_flow_id`，触发呼叫流程（IVR、排队等）
- 媒体路径取决于是否需要 B2BUA（录音、会议等）

---

### 6.9 CF-07: 外部来电（Trunk）→ WebRTC 分机

```
PSTN/SIP Trunk       sipserver-01           Redis           sigserver-02    1002 (WebRTC)
     │                   │                  │                  │                │
     │ SIP INVITE        │                  │                  │                │
     │ (To: DID 号码)    │                  │                  │                │
     │ ─────────────────►│                  │                  │                │
     │                   │                  │                  │                │
     │                   │ ① DID 识别       │                  │                │
     │                   │   → 绑定分机 1002 │                  │                │
     │                   │                  │                  │                │
     │                   │ ② 查 Redis 注册表│                  │                │
     │                   │   1002→sigserver-02              │                │
     │                   │ ────────────────►│                  │                │
     │                   │ ◄────────────────│                  │                │
     │                   │                  │                  │                │
     │                   │ ③ call:command:  │                  │                │
     │                   │   sigserver-02│                  │                │
     │                   │ ──────────────────────────────────►│                │
     │                   │ { command: "incoming_call",        │                │
     │                   │   caller: "+1234567890",           │                │
     │                   │   callee: "1002",                  │                │
     │                   │   caller_name: "外部来电" }          │                │
     │                   │                  │                  │                │
     │                   │                  │                  │ incoming_call  │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │                   │                  │                  │ invite (SDP)   │
     │                   │                  │                  │ ◄──────────────│
     │                   │                  │                  │                │
     │                   │ ④ B2BUA 降级     │                  │                │
     │                   │   CreateSession(transcode)         │                │
     │                   │ ──────────────────────────────────────────────────────
     │                   │                  │                  │                │
     │                   │                  │                  │ answer (SDP)   │
     │                   │                  │                  │ ──────────────►│
     │                   │                  │                  │                │
     │ 200 OK (SDP)      │                  │                  │                │
     │ ◄─────────────────│                  │                  │                │
     │                   │                  │                  │                │
     │ ═══ RTP ═══════════ sipserver ════════ RTP ══════════════ medserver ═══════ WebRTC ═══
     │   Trunk ↔ medserver ↔ sipserver (B2BUA) ↔ medserver ↔ sigserver ↔ 1002
```

**关键点**：
- 外部来电到 WebRTC 分机必须经过 B2BUA（协议转换：RTP ↔ WebRTC）
- sipserver 调用 medserver 创建 transcode 会话
- 主叫号码保留原始外部号码（显示来电显示）
- 可能触发呼叫流程（IVR 欢迎语、排队等）

---

### 6.10 CF-08: 呼叫转接（盲转 REFER）

```
1001 (主叫)        1002 (转接方)          1003 (目标)
     │                   │                  │
     │ ═══ 通话中 ═══════ │                  │
     │                   │                  │
     │                   │ REFER            │
     │                   │ Refer-To: 1003   │
     │                   │ ────────────────►│
     │                   │                  │
     │                   │ 202 Accepted     │
     │                   │ ◄────────────────│
     │                   │                  │
     │                   │ ① 向 1003 发起新 INVITE               │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │                  │              180 Ringing
     │                   │  NOTIFY          │ ◄────────────────│
     │                   │ ◄────────────────│                  │
     │                   │ (SIP 180)        │                  │
     │                   │                  │                  │
     │                   │                  │              200 OK
     │                   │                  │ ◄────────────────│
     │                   │  NOTIFY          │                  │
     │                   │ ◄────────────────│                  │
     │                   │ (SIP 200)        │                  │
     │                   │                  │                  │
     │                   │ BYE              │                  │
     │                   │ ────────────────►│                  │
     │                   │                  │                  │
     │ ════════════════════════════════════ RTP ════════════════════════════
     │   1001 ↔ 1003（直接媒体，1002 已退出）
```

**关键点**：
- 盲转使用 SIP REFER 方法
- 转接方（1002）在 1003 应答后发送 BYE 退出
- 最终 1001 和 1003 直接通话
- 如 REFER 失败（1003 无应答），1002 可恢复与 1001 的通话

---

### 6.11 CF-09: 呼叫转接（咨询转 B2BUA）

```
1001 (主叫)        sipserver (B2BUA)      1002 (转接方)      1003 (目标)
     │                   │                  │                  │
     │ ═══ 通话中 ═══════ │                  │                  │
     │                   │                  │                  │
     │                   │ ① 1002 发起咨询转 │                  │
     │                   │   (INVITE 1003)  │                  │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ② 创建 B2BUA 会话│                  │
     │                   │   Leg A: 1001    │                  │
     │                   │   Leg B: 1003    │                  │
     │                   │                  │                  │
     │                   │ INVITE (Leg B)   │                  │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │                  │              180 Ringing
     │  保持（MOH）       │ ◄────────────────│                  │
     │ ◄─────────────────│                  │                  │
     │                   │                  │                  │
     │                   │                  │              200 OK
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ③ 1002 确认转接  │                  │
     │                   │   (BYE Leg A)    │                  │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ④ 桥接 Leg A ↔ Leg B               │
     │                   │                  │                  │
     │ ════════════════════════════════════ RTP ════════════════════════════
     │   1001 ↔ medserver (混音) ↔ 1003
```

**关键点**：
- 咨询转需要 B2BUA 降级（medserver 参与媒体桥接）
- 转接方（1002）先与目标（1003）通话确认后再桥接
- 主叫（1001）在等待期间听保持音乐（MOH）
- 最终 1001 和 1003 通过 medserver 桥接通话

---

### 6.12 CF-10: 呼叫保持/恢复

```
1001 (主叫)        1002 (被叫/保持方)      medserver
     │                   │                  │
     │ ═══ 通话中 ═══════ │                  │
     │                   │                  │
     │                   │ ① re-INVITE (a=sendonly)           │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │ 保持音乐 (MOH)     │ ② 启动 MOH 播放  │                  │
     │ ◄══════════════════════════════════════════════════════
     │                   │                  │                  │
     │                   │ 200 OK           │                  │
     │ ◄─────────────────│                  │                  │
     │                   │                  │                  │
     │ ... 1002 处理其他事务 ...             │                  │
     │                   │                  │                  │
     │                   │ ③ re-INVITE (a=sendrecv)           │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │ ④ 停止 MOH 播放  │                  │
     │ ═══ 通话恢复 ═══════════════════════════════════════════
     │                   │                  │                  │
     │                   │ 200 OK           │                  │
     │ ◄─────────────────│                  │                  │
```

**关键点**：
- 保持：发送 re-INVITE 将媒体方向改为 `a=sendonly`
- medserver 检测到保持状态后向主叫播放 MOH
- 恢复：发送 re-INVITE 将媒体方向改回 `a=sendrecv`
- MOH 资源从配置中读取（`moh_uri`）

---

### 6.13 CF-11: IVR 交互流程

```
1001 (主叫)        sipserver (B2BUA)      medserver (IVR)
     │                   │                  │
     │ SIP INVITE        │                  │
     │ ─────────────────►│                  │
     │                   │                  │
     │                   │ ① 路由决策: IVR  │                  │
     │                   │   CreateSession(ivr)                │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │ { session_id: "ivr-abc",           │
     │                   │   ivr_flow_id: 10,                 │
     │                   │   variables: { "caller": "1001" } }│
     │                   │                  │                  │
     │ 100 Trying        │                  │                  │
     │ ◄─────────────────│                  │                  │
     │                   │                  │                  │
     │                   │ ② IVR 流程启动   │                  │
     │                   │                  │                  │
     │ 播放欢迎语         │  PlayIvr(prompt_1)                 │
     │ ◄══════════════════════════════════════════════════════
     │                   │                  │                  │
     │ DTMF: 按 1        │                  │                  │
     │ ═══════════════════════════════════════════════════════►│
     │                   │                  │                  │
     │                   │ MediaEvent(DtmfDetected, "1")      │
     │                   │ ◄──────────────────────────────────│
     │                   │                  │                  │
     │                   │ ③ IVR 流程节点跳转                  │
     │                   │   PlayIvr(prompt_2)                 │
     │ 播放第二层菜单     │                  │                  │
     │ ◄══════════════════════════════════════════════════════
     │                   │                  │                  │
     │ ... 继续交互 ...   │                  │                  │
     │                   │                  │                  │
     │                   │ ④ IVR 流程完成   │                  │
     │                   │   MediaEvent(IvrFinished, {        │
     │                   │     action: "bridge",              │
     │                   │     target: "1002" })              │
     │                   │ ◄──────────────────────────────────│
     │                   │                  │                  │
     │                   │ ⑤ 根据 IVR 结果路由                 │
     │                   │   → 转发到 1002  │                  │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │ ═══ 通话建立 ═══════════════════════════════════════════
```

**关键点**：
- IVR 流程定义存储在 `ivr_flows` 配置表中
- medserver 负责播放提示音和收集 DTMF
- IVR 流程节点：播放、收集输入、条件判断、转接、挂断
- IVR 完成后根据结果执行下一步路由（转分机、排队、挂断等）

---

### 6.14 CF-12: 通话录音激活

```
1001 (主叫)        sipserver              medserver          1002 (被叫)
     │                   │                  │                  │
     │ ═══ 通话中（未录音）═══════════════════════════════════════════
     │                   │                  │                  │
     │                   │ ① 管理员触发录音  │                  │
     │                   │   (通过 cti-server 或 API)          │
     │                   │                  │                  │
     │                   │ ModifySession    │                  │
     │                   │ { action: "start_recording",       │
     │                   │   recording_id: "rec-xyz" }        │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │ 200 OK           │                  │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ② 开始录音       │                  │
     │                   │   媒体流复制      │                  │
     │                   │ ═══════════════════════════════════════════════►│
     │                   │                  │                  │
     │                   │ MediaEvent(RecordingStarted)       │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ③ 更新 CDR 录音标记                 │
     │                   │                  │                  │
     │ ═══ 通话继续（录音中）═══════════════════════════════════════════
     │                   │                  │                  │
     │                   │ ④ 通话结束       │                  │
     │                   │ StopRecording    │                  │
     │                   │ ──────────────────────────────────►│
     │                   │                  │                  │
     │                   │ MediaEvent(RecordingStopped, {     │
     │                   │   recording_url: "/recordings/..." })              │
     │                   │ ◄────────────────│                  │
     │                   │                  │                  │
     │                   │ ⑤ 更新 CDR 录音完成                 │
```

**关键点**：
- 录音可在通话中动态激活（无需提前创建媒体会话）
- medserver 负责媒体流复制和录音文件生成
- 录音文件存储到对象存储（S3/MinIO），URL 记录到 CDR
- 录音触发来源：管理员手动、路由规则自动、合规要求

---

### 6.15 呼叫流程错误处理

| 错误场景 | 检测方式 | 处理动作 | 用户感知 |
|---------|---------|---------|---------|
| 被叫无应答 | INVITE 超时（默认 30s） | 发送 CANCEL，播放语音提示 | 主叫听到"无人接听" |
| 被叫忙 | 收到 486 Busy Here | 播放忙音或转语音信箱 | 主叫听到忙音 |
| 被叫不可达 | 注册表查询失败 | 播放"分机不存在"或转语音信箱 | 主叫听到提示音 |
| 跨协议协调失败 | Redis Pub/Sub 超时 | 向主叫发送 503 Service Unavailable | 主叫听到"网络忙" |
| medserver 不可用 | gRPC 调用失败 | B2BUA 降级失败，返回 503 | 主叫听到"服务不可用" |
| 媒体协商失败 | ICE/DTLS 失败 | 终结呼叫，发送 BYE | 通话断开 |
| 路由决策失败 | 无匹配规则 | 播放"号码无效"提示 | 主叫听到提示音 |

---

### 6.16 呼叫流程数据结构

```rust
/// 呼叫上下文（贯穿整个呼叫生命周期）
pub struct CallContext {
    pub call_id: String,
    pub tenant_id: i64,
    pub site_id: String,
    
    /// 主叫信息
    pub caller: String,
    pub caller_name: Option<String>,
    pub caller_connection_id: Option<ConnectionId>,
    
    /// 被叫信息
    pub callee: String,
    pub callee_connection_id: Option<ConnectionId>,
    
    /// 路由信息
    pub route_point_id: Option<i64>,
    pub trunk_id: Option<i64>,
    pub call_flow_id: Option<i64>,
    
    /// 媒体信息
    pub media_session_id: Option<String>,
    pub local_rtp_addr: Option<String>,
    pub local_rtp_port: Option<u16>,
    
    /// SIP 头（用于路由决策）
    pub sip_headers: HashMap<String, String>,
    
    /// 变量（IVR、呼叫流程传递）
    pub variables: HashMap<String, String>,
    
    /// 时间戳
    pub started_at: Instant,
    pub answered_at: Option<Instant>,
    pub ended_at: Option<Instant>,
    
    /// CDR 关联
    pub cdr_id: String,
}

/// 呼叫状态机
pub enum CallState {
    /// 初始状态
    New,
    /// 正在路由决策
    Routing,
    /// 正在呼叫被叫
    Trying,
    /// 被叫振铃
    Ringing,
    /// 通话已建立
    Answered,
    /// 通话保持
    Held,
    /// 通话结束
    Ended,
    /// 呼叫失败
    Failed,
}
```

---

## 7. 与 nextswitch-api 交互

### 7.1 健康检查

nextswitch-api 定期轮询 sipserver/sigserver 的健康检查端点，聚合后提供给前端 Dashboard：

```
nextswitch-api                        sipserver/sigserver
     │                                        │
     │  GET /health                           │
     │ ──────────────────────────────────────►│
     │                                        │
     │  200 OK                                │
     │  {                                     │
     │    "status": "healthy",                │
     │    "instance_id": "sipserver-01",      │
     │    "version": "1.0.0",                 │
     │    "uptime_secs": 86400,               │
     │    "checks": {                         │
     │      "redis": {                        │
     │        "status": "ok",                 │
     │        "latency_ms": 2                 │
     │      },                                │
     │      "transport": {                    │
     │        "status": "ok",                 │
     │        "active_protocols": ["udp"],    │
     │        "active_connections": 1500      │
     │      },                                │
     │      "config_sync": {                  │
     │        "status": "ok",                 │
     │        "version": 12345                │
     │      }                                 │
     │    },                                  │
     │    "stats": {                          │
     │      "active_calls": 150,              │
     │      "registered_endpoints": 5000      │
     │    }                                   │
     │  }                                     │
     │ ◄──────────────────────────────────────│
```

> 完整健康检查规范详见 [监控设计](../../monitoring/monitoring-design.md) §3。

### 7.2 监控数据聚合

nextswitch-api 提供前端监控 API，从 sipserver/sigserver 的 Prometheus 端点聚合数据：

| API 端点 | 数据来源 | 说明 |
|---------|---------|------|
| `GET /api/v1/monitor/overview` | 所有实例 `/metrics` | 系统总览（总呼叫数、并发数、注册数） |
| `GET /api/v1/monitor/instances` | 所有实例 `/health` | 实例状态列表 |
| `GET /api/v1/monitor/calls/active` | Redis `call:*` | 当前活跃呼叫列表 |
| `GET /api/v1/monitor/calls/history` | CDR 数据库 | 历史呼叫记录 |
| `GET /api/v1/monitor/quality` | RTCP-XR / Prometheus | 通话质量指标（MOS、丢包率、抖动） |

---

## 8. 与 auth-service 交互

sipserver/sigserver 不直接调用 auth-service，但存在以下间接交互：

| 场景 | 交互方式 | 说明 |
|------|---------|------|
| SIP DIGEST 认证 | 共享 DB 表 | sipserver 直接读取 `extensions.password_hash` 进行 SIP DIGEST 校验 |
| WebSocket JWT 认证 | 共享 Redis | sigserver 从 Redis 读取 JWT 公钥/密钥进行 Token 校验 |
| API 权限校验 | 通过 API 网关 | 管理操作通过 nextswitch-api 的 JWT 中间件校验，不经过信令层 |
| 安全策略 | 共享 DB 表 | sipserver 读取 `tenant_security_policies` 获取密码策略、锁定策略 |
