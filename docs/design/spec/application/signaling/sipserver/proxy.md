# Proxy 模块

---

## 1. 代理决策流程

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
                // Step 2: 信令服务器本地完成路由决策后，委托 medserver 处理呼叫
                let response = self.local_route_and_process_call(&ctx).await?;
                
                match RouteDecision::try_from(response.decision)? {
                    RouteDecision::Direct => {
                        self.proxy_to_extension(msg, ctx, &response.target).await
                    }
                    RouteDecision::Trunk => {
                        self.proxy_to_trunk(msg, ctx, &response.target).await
                    }
                    RouteDecision::Ivr | RouteDecision::CallFlow | RouteDecision::Conference => {
                        // 需要 B2BUA 降级，通过 ProcessCall 委托 medserver
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
    
    /// 本地路由决策 + 委托 medserver 处理呼叫
    async fn local_route_and_process_call(
        &self,
        ctx: &CallContext,
    ) -> Result<RouteResponse, RoutingError> {
        // 路由规则已在信令服务器本地执行（两层路由：快速规则 + 图引擎）
        // 决策完成后，通过 gRPC ProcessCall 委托 medserver 执行呼叫处理
        let endpoint = self.discovery
            .get_healthy_endpoint("medserver")
            .await
            .map_err(|_| RoutingError::ServiceUnavailable("medserver".into()))?;
        
        let channel = Channel::from_shared(endpoint)
            .map_err(|e| RoutingError::ConnectionFailed(e.to_string()))?
            .connect_timeout(Duration::from_millis(2000))
            .connect()
            .await
            .map_err(|e| RoutingError::ConnectionFailed(e.to_string()))?;
        
        let mut client = MediaServiceClient::new(channel);
        // ... 构建 ProcessCall 请求并调用 ...
        todo!()
    }
}
```

---

## 2. 注册表查询优化

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
