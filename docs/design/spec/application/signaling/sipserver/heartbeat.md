# 心跳机制

---

## 1. 实例心跳

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

---

## 2. 心跳数据结构

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

---

## 3. 心跳检查

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

---

## 4. 心跳监控指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `heartbeat_sent_total` | Counter | 成功发送的心跳数 |
| `heartbeat_failed_total` | Counter | 发送失败的心跳数 |
| `heartbeat_missed_total` | Counter | 错过的心跳周期数 |
| `instance_heartbeat_latency_seconds` | Histogram | 心跳写入 Redis 延迟 |
