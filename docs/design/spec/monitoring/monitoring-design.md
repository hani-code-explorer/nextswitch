# 信令服务器监控设计

> 本文档是 [信令服务器细化设计索引](../application/signaling/) 的第 5 部分。

---

## 1. 指标体系

### 1.1 业务指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `sip_invite_received_total` | Counter | `tenant_id`, `transport` | 收到的 INVITE 总数 |
| `sip_invite_completed_total` | Counter | `tenant_id`, `response_code` | 完成的 INVITE 按响应码分类 |
| `sip_register_total` | Counter | `tenant_id`, `result` | REGISTER 请求数（success/failure） |
| `sip_active_calls` | Gauge | `instance_id` | 当前活跃呼叫数 |
| `sip_registered_endpoints` | Gauge | `instance_id` | 当前注册的分机数 |
| `call_duration_seconds` | Histogram | `tenant_id`, `direction` | 通话时长分布 |
| `call_setup_duration_seconds` | Histogram | `tenant_id`, `direction` | 呼叫建立时长分布 |
| `routing_decision_total` | Counter | `tenant_id`, `decision` | 路由决策分布 |
| `routing_decision_duration_us` | Histogram | `source` | 路由决策耗时（local/remote） |
| `ws_connections_active` | Gauge | `instance_id` | 当前活跃 WebSocket 连接数 |
| `ws_messages_total` | Counter | `method`, `direction` | WebSocket 消息吞吐 |
| `b2bua_downgrade_total` | Counter | `reason` | B2BUA 降级次数（按原因） |

### 1.2 安全指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `auth_failure_total` | Counter | `type`, `source_ip` | 认证失败次数（SIP/WS） |
| `auth_account_locked_total` | Counter | `tenant_id` | 账户锁定次数 |
| `toll_fraud_alert_total` | Counter | `tenant_id`, `type` | 话费欺诈告警 |
| `cac_rejected_total` | Counter | `level`, `tenant_id` | 呼叫准入拒绝（system/tenant/extension） |
| `cps_rate_limited_total` | Counter | `source_ip` | CPS 限流次数 |
| `sip_firewall_blocked_total` | Counter | `reason` | SIP 防火墙拦截次数 |
| `malformed_sip_total` | Counter | `source_ip`, `reason` | 畸形 SIP 消息数 |

### 1.3 基础设施指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `redis_operations_total` | Counter | `operation`, `result` | Redis 操作数（hit/miss/error） |
| `redis_latency_seconds` | Histogram | `operation` | Redis 操作延迟 |
| `grpc_client_duration_seconds` | Histogram | `service`, `method`, `result` | gRPC 客户端调用延迟 |
| `grpc_client_errors_total` | Counter | `service`, `method`, `code` | gRPC 客户端错误数 |
| `config_updates_total` | Counter | `entity_type`, `action` | 配置更新次数 |
| `config_sync_lag_seconds` | Gauge | - | 配置同步延迟 |
| `tokio_worker_threads` | Gauge | - | Tokio worker 线程数 |
| `tokio_queue_depth` | Gauge | - | Tokio 任务队列深度 |
| `process_memory_bytes` | Gauge | `type` | 进程内存（RSS/VSS） |
| `process_cpu_seconds_total` | Counter | - | 进程 CPU 时间 |

---

## 2. OpenTelemetry 追踪

### 2.1 Span 结构

```
SIP INVITE 处理（sipserver）:
├── span: sip.pre_route (Pre-Route 管线)
│   ├── span: sip.firewall_check (防火墙校验)
│   ├── span: sip.rate_limit_check (速率限制)
│   └── span: sip.cac_check (呼叫准入控制)
├── span: sip.method_router (方法路由)
├── span: sip.proxy (代理处理)
│   ├── span: sip.route_lookup (路由查找)
│   │   └── span: sip.local_route_match (信令服务器本地路由决策)
│   ├── span: sip.registry_lookup (注册表查找)
│   │   ├── span: redis.hget (Redis 查询)
│   │   └── span: redis.heartbeat_check (心跳检查)
│   └── span: sip.forward (消息转发)
└── span: sip.post_route (后处理)
    ├── span: sip.topology_hiding (拓扑隐藏)
    └── span: sip.cdr_record (CDR 记录)

B2BUA 降级（sipserver）:
├── span: sip.b2bua (B2BUA 处理)
│   ├── span: grpc.medserver.create_session (创建媒体会话)
│   ├── span: sip.leg_a_setup (Leg A 建立)
│   ├── span: sip.leg_b_setup (Leg B 建立)
│   └── span: sip.bridge (媒体桥接)

WebSocket 消息处理（sigserver）:
├── span: ws.message_receive (消息接收)
│   ├── span: ws.json_rpc_parse (JSON-RPC 解析)
│   └── span: ws.method_dispatch (方法分发)
│       ├── span: signal.call_invite (呼叫邀请)
│       │   ├── span: grpc.medserver.create_session (媒体会话)
│       │   └── span: signal.webrtc_negotiation (WebRTC 协商)
│       └── span: signal.call_answer (呼叫应答)
```

### 2.2 追踪上下文传播

**SIP 协议**：通过自定义 SIP Header 传播追踪上下文：

```
X-Trace-Id: <trace_id>
X-Span-Id: <span_id>
X-Trace-Parent: <parent_span_id>
X-Trace-Flags: <flags>
```

**WebSocket 协议**：通过 JSON-RPC 消息的 `_trace` 字段传播：

```json
{
    "jsonrpc": "2.0",
    "method": "invite",
    "params": { ... },
    "id": 1,
    "_trace": {
        "trace_id": "...",
        "span_id": "...",
        "parent_span_id": "..."
    }
}
```

**gRPC 调用**：通过标准 W3C Trace Context metadata 传播（tonic 中间件自动处理）。

### 2.3 采样策略

```rust
pub struct TraceSampler {
    /// 默认采样率
    default_rate: f64,          // 0.1 (10%)
    /// 高优先级采样规则（错误、慢请求 100% 采样）
    always_sample_rules: Vec<SampleRule>,
}

impl TraceSampler {
    pub fn should_sample(&self, attrs: &SpanAttributes) -> bool {
        // ① 错误响应 100% 采样
        if attrs.status_code >= 400 {
            return true;
        }

        // ② 慢请求 100% 采样（延迟 > 1s）
        if attrs.duration_ms > 1000 {
            return true;
        }

        // ③ B2BUA 降级 100% 采样
        if attrs.is_b2bua {
            return true;
        }

        // ④ 默认按采样率
        rand::random::<f64>() < self.default_rate
    }
}
```

---

## 3. 健康检查

### 3.1 端点定义

遵循统一健康检查规范（参见 `config-and-gateway-design.md` Appendix D）：

| 端点 | sipserver 逻辑 | sigserver 逻辑 |
|------|---------------|-------------------|
| `GET /health` | Redis 可达 + 至少 1 个 transport 活跃 | Redis 可达 + WS 监听器活跃 |
| `GET /health/live` | 进程在响应 HTTP | 进程在响应 HTTP |
| `GET /health/ready` | Redis 可达 + transport 已绑定 + 配置已加载 | Redis 可达 + WS 监听器已绑定 + 配置已加载 |
| `GET /health/startup` | transport 绑定完成 + 全量配置加载完成 | WS 监听器绑定完成 + 全量配置加载完成 |

### 3.2 健康检查响应

```json
{
    "status": "healthy",
    "instance_id": "sipserver-01",
    "site_id": "us-east-1",
    "version": "1.0.0",
    "uptime_secs": 86400,
    "checks": {
        "redis": {
            "status": "ok",
            "latency_ms": 2
        },
        "transport": {
            "status": "ok",
            "active_protocols": ["udp", "tcp", "tls"],
            "active_connections": 1500
        },
        "config_sync": {
            "status": "ok",
            "last_synced_at": "2026-09-10T10:00:00Z",
            "version": 12345
        }
    },
    "stats": {
        "active_calls": 150,
        "registered_endpoints": 5000,
        "calls_per_second": 25.5
    }
}
```

### 3.3 健康检查实现

```rust
pub struct HealthChecker {
    redis: Arc<RedisPool>,
    transport_state: Arc<TransportState>,
    config_state: Arc<ConfigState>,
}

impl HealthChecker {
    pub async fn check_readiness(&self) -> HealthStatus {
        let mut checks = HashMap::new();

        // ① Redis 可达性
        let redis_start = Instant::now();
        let redis_ok = self.redis.ping().await.is_ok();
        checks.insert("redis", CheckResult {
            status: if redis_ok { "ok" } else { "fail" },
            latency_ms: redis_start.elapsed().as_millis() as u64,
        });

        // ② Transport 绑定状态
        let transport_ok = self.transport_state.has_active_transport();
        checks.insert("transport", CheckResult {
            status: if transport_ok { "ok" } else { "fail" },
            ..Default::default()
        });

        // ③ 配置加载状态
        let config_ok = self.config_state.is_loaded();
        checks.insert("config_sync", CheckResult {
            status: if config_ok { "ok" } else { "fail" },
            ..Default::default()
        });

        let overall = if redis_ok && transport_ok && config_ok {
            HealthStatus::Healthy
        } else {
            HealthStatus::Unhealthy
        };

        HealthStatus { overall, checks }
    }
}
```

---

## 4. 告警规则

### 4.1 关键告警

| 告警名称 | 条件 | 严重度 | 动作 |
|---------|------|--------|------|
| `SipHighErrorRate` | `rate(sip_invite_completed_total{response_code=~"5.."}[5m]) / rate(sip_invite_received_total[5m]) > 0.05` | P1 | 立即通知运维 |
| `SipNoHealthyInstance` | `up{job="sipserver"} == 0` 持续 1m | P1 | 立即通知运维 |
| `SipHighCallLoad` | `sip_active_calls / max_calls > 0.8` 持续 5m | P2 | 通知运维 + 自动扩容 |
| `SipRedisUnavailable` | `redis_operations_total{result="error"} > 10` 在 1m 内 | P2 | 通知运维 |
| `SipMedserverDown` | `grpc_client_errors_total{service="medserver"} > 5` 在 1m 内 | P2 | 通知运维 |
| `WsHighConnectionCount` | `ws_connections_active > max_connections * 0.8` | P2 | 通知运维 + 自动扩容 |
| `SipAuthBruteForce` | `rate(auth_failure_total[5m]) > 100` | P1 | 通知安全团队 + 自动封禁 IP |
| `SipTollFraudDetected` | `toll_fraud_alert_total > 0` | P1 | 立即通知安全团队 |
| `ConfigSyncLag` | `config_sync_lag_seconds > 300` | P3 | 通知运维 |

### 4.2 告警路由

```
告警级别     通知渠道                  响应时间
─────────────────────────────────────────────
P1          电话 + 短信 + 即时通讯       5 分钟内
P2          即时通讯 + 邮件             15 分钟内
P3          邮件                       下一工作日
```

---

## 5. Grafana 仪表板

### 5.1 sipserver 仪表板

```
┌─────────────────────────────────────────────────────────────────────┐
│  sipserver Overview                                                  │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │ Active   │ │Registered│ │ CPS      │ │ Error    │              │
│  │ Calls    │ │Endpoints │ │ (呼叫/秒) │ │ Rate     │              │
│  │  150     │ │  5,000   │ │  25.5    │ │  0.2%    │              │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                     │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐   │
│  │ INVITE 处理延迟 (P50/P95/P99)│ │ 呼叫建立时长分布              │   │
│  │ [折线图]                     │ │ [直方图]                      │   │
│  └─────────────────────────────┘ └─────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐   │
│  │ 响应码分布 (2xx/3xx/4xx/5xx)│ │ B2BUA 降级分布               │   │
│  │ [堆叠面积图]                 │ │ [饼图]                        │   │
│  └─────────────────────────────┘ └─────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐   │
│  │ Redis 操作延迟/命中率         │ │ gRPC 调用延迟（medserver）   │   │
│  │ [双轴折线图]                 │ │ [折线图]                      │   │
│  └─────────────────────────────┘ └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 sigserver 仪表板

```
┌─────────────────────────────────────────────────────────────────────┐
│  sigserver Overview                                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │ WS       │ │ Active   │ │ WS Msg   │ │ Auth     │              │
│  │ Connect  │ │ Calls    │ │ Rate     │ │ Failures │              │
│  │  200     │ │  50      │ │  500/s   │ │  0       │              │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                     │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐   │
│  │ WebSocket 连接数趋势          │ │ 消息方法分布                  │   │
│  │ [面积图]                     │ │ [堆叠柱状图]                  │   │
│  └─────────────────────────────┘ └─────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐   │
│  │ WebRTC 协商延迟               │ │ ICE 连接状态分布              │   │
│  │ [直方图]                     │ │ [饼图]                        │   │
│  └─────────────────────────────┘ └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Prometheus Recording Rules

预计算常用查询，降低 Grafana 查询延迟：

```yaml
groups:
  - name: nextswitch_signaling_metrics
    interval: 30s
    rules:
      # SIP 每秒呼叫建立数
      - record: nextswitch:sip_cps:rate5m
        expr: rate(sip_invite_completed_total{response_code="200"}[5m])

      # SIP 呼叫成功率
      - record: nextswitch:sip_success_rate:ratio5m
        expr: |
          rate(sip_invite_completed_total{response_code=~"2.."}[5m])
          / rate(sip_invite_completed_total[5m])

      # WebSocket 消息吞吐
      - record: nextswitch:ws_msg_rate:rate5m
        expr: rate(ws_messages_total[5m])

      # Redis 命中率
      - record: nextswitch:redis_hit_rate:ratio5m
        expr: |
          rate(redis_operations_total{result="hit"}[5m])
          / rate(redis_operations_total[5m])
```
