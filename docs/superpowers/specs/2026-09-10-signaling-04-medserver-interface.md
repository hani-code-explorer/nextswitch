# NextSWITCH 信令服务器 — medserver 接口设计

> 本文档是 [信令服务器细化设计索引](2026-09-10-signaling-00-index.md) 的第 4 部分。

---

## 1. 接口总览

sipserver 和 sigserver 通过 medserver 的 gRPC API 控制媒体会话。本节定义信令服务器侧的调用模式。

### 1.1 使用的 gRPC 接口

| RPC 方法 | 调用方 | 触发场景 | 说明 |
|---------|--------|---------|------|
| `CreateSession` | sipserver, sigserver | B2BUA 降级、WebRTC 媒体桥接 | 创建媒体会话 |
| `ModifySession` | sipserver | 通话中修改媒体参数（如启用录音） | 修改媒体会话 |
| `DeleteSession` | sipserver, sigserver | 通话结束 | 销毁媒体会话 |
| `StartRecording` | sipserver | 通话录音触发 | 开始录音 |
| `StopRecording` | sipserver | 通话录音停止 | 停止录音 |
| `JoinConference` | sipserver | 会议邀请 | 加入会议 |
| `LeaveConference` | sipserver | 会议离开 | 离开会议 |
| `PlayIvr` | sipserver | IVR 播放提示音 | 播放 IVR 提示 |
| `StopIvr` | sipserver | IVR 停止 | 停止 IVR |
| `SubscribeEvents` | sipserver, sigserver | 启动时 | 订阅媒体事件流 |

---

## 2. CreateSession 调用模式

### 2.1 B2BUA 录音场景

```rust
/// sipserver 发起录音的 CreateSession 调用
pub async fn create_recording_session(
    &self,
    call_ctx: &CallContext,
    media_client: &mut MediaServiceClient<Channel>,
) -> Result<CreateSessionResponse> {
    let req = CreateSessionRequest {
        session_id: format!("rec-{}", call_ctx.call_id),
        call_id: call_ctx.call_id.clone(),
        site_id: call_ctx.site_id.clone(),
        local: Some(MediaEndpoint {
            // sipserver 侧的 RTP 端点（主叫 Leg A）
            address: call_ctx.local_rtp_addr.clone(),
            rtp_port: call_ctx.local_rtp_port as u32,
            rtcp_port: call_ctx.local_rtcp_port as u32,
            codecs: vec![
                CodecParam { name: "PCMU".into(), payload_type: 0, clock_rate: 8000 },
                CodecParam { name: "PCMA".into(), payload_type: 8, clock_rate: 8000 },
            ],
            ..Default::default()
        }),
        remote: Some(MediaEndpoint {
            // 被叫侧的 RTP 端点（Leg B）
            address: call_ctx.remote_rtp_addr.clone(),
            rtp_port: call_ctx.remote_rtp_port as u32,
            rtcp_port: call_ctx.remote_rtcp_port as u32,
            codecs: call_ctx.remote_codecs.clone(),
            ..Default::default()
        }),
        codecs: Some(CodecPreference {
            preference: vec!["PCMU".into(), "PCMA".into()],
        }),
        security: Some(SecurityMode {
            mode: SecurityModeType::None.into(), // SIP 侧通常不使用 SRTP
        }),
    };
    
    let resp = media_client.create_session(req).await?;
    Ok(resp)
}
```

### 2.2 WebRTC 媒体桥接场景

```rust
/// sigserver 发起 WebRTC 媒体桥接的 CreateSession 调用
pub async fn create_webrtc_bridge(
    &self,
    call_ctx: &WebRtcCallContext,
    media_client: &mut MediaServiceClient<Channel>,
) -> Result<CreateSessionResponse> {
    let req = CreateSessionRequest {
        session_id: format!("webrtc-{}", call_ctx.call_id),
        call_id: call_ctx.call_id.clone(),
        site_id: call_ctx.site_id.clone(),
        local: Some(MediaEndpoint {
            // WebRTC 侧的端点（ICE + DTLS）
            address: String::new(), // 由 medserver 分配
            rtp_port: 0,
            rtcp_port: 0,
            codecs: vec![
                CodecParam { name: "opus".into(), payload_type: 111, clock_rate: 48000 },
            ],
            ice: Some(IceCredentials {
                ufrag: call_ctx.local_ice_ufrag.clone(),
                pwd: call_ctx.local_ice_pwd.clone(),
            }),
            fingerprint: Some(DtlsFingerprint {
                algorithm: "sha-256".into(),
                value: call_ctx.local_dtls_fingerprint.clone(),
            }),
        }),
        remote: Some(MediaEndpoint {
            // SIP 侧的 RTP 端点（从注册表解析或从 sipserver 获取）
            address: call_ctx.remote_rtp_addr.clone(),
            rtp_port: call_ctx.remote_rtp_port as u32,
            rtcp_port: call_ctx.remote_rtcp_port as u32,
            codecs: call_ctx.remote_codecs.clone(),
            ..Default::default()
        }),
        codecs: Some(CodecPreference {
            preference: vec!["opus".into(), "PCMU".into(), "PCMA".into()],
        }),
        security: Some(SecurityMode {
            mode: SecurityModeType::DtlsSrtp.into(), // WebRTC 必须使用 DTLS-SRTP
        }),
    };
    
    let resp = media_client.create_session(req).await?;
    Ok(resp)
}
```

---

## 3. 媒体事件处理

### 3.1 SubscribeEvents 订阅

```rust
/// 启动时订阅媒体事件流
pub async fn subscribe_media_events(
    media_client: &mut MediaEventsClient<Channel>,
    event_tx: mpsc::Sender<MediaEvent>,
) -> Result<()> {
    let req = SubscribeEventsRequest {
        instance_id: INSTANCE_ID.clone(),
        filter: None, // 订阅所有事件
    };
    
    let mut stream = media_client.subscribe_events(req).await?.into_inner();
    
    // 后台协程处理事件
    tokio::spawn(async move {
        while let Some(event) = stream.message().await.ok().flatten() {
            metrics::counter!("media_events_received_total",
                "event_type" => event.event_type_name(),
            ).increment(1);
            
            if event_tx.send(event).await.is_err() {
                break; // 接收方已关闭
            }
        }
        
        // 连接断开，自动重连
        metrics::counter!("media_events_reconnect_total").increment(1);
    });
    
    Ok(())
}
```

### 3.2 媒体事件处理矩阵

| MediaEvent 类型 | 处理方 | 处理动作 |
|-----------------|--------|---------|
| `SessionStarted` | sipserver/sigserver | 更新呼叫状态，记录媒体会话建立时间 |
| `SessionEnded` | sipserver/sigserver | 清理媒体关联，检查是否需要终结呼叫 |
| `RecordingStarted` | sipserver | 更新 CDR 录音标记 |
| `RecordingStopped` | sipserver | 更新 CDR 录音完成 |
| `DtmfDetected` | sipserver | 转发 DTMF 事件到对端或 IVR 引擎 |
| `IvrFinished` | sipserver | IVR 流程完成，执行下一步路由 |
| `MediaError` | sipserver/sigserver | 记录错误，尝试恢复或终结呼叫 |
| `RtpStats` | sipserver/sigserver | 更新通话质量指标（MOS、丢包率） |

---

## 4. 媒体会话生命周期

```
呼叫开始
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ 判断是否需要 B2BUA 降级                                    │
│ ├─ 录音 → CreateSession(recording)                        │
│ ├─ 会议 → CreateSession + JoinConference                  │
│ ├─ IVR  → CreateSession(ivr) + PlayIvr                   │
│ ├─ WebRTC → CreateSession(transcode)                      │
│ └─ 纯代理 → 不创建媒体会话                                  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ 媒体会话活跃                                               │
│ ├─ 通话中修改 → ModifySession（如动态启用录音）                │
│ ├─ DTMF 事件 → MediaEvent(DtmfDetected)                   │
│ ├─ RTP 统计 → MediaEvent(RtpStats)                        │
│ └─ 媒体错误 → MediaEvent(MediaError)                       │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ 通话结束                                                   │
│ ├─ DeleteSession（释放媒体资源）                              │
│ ├─ StopRecording（如正在录音）                                │
│ ├─ LeaveConference（如在会议中）                              │
│ └─ 清理本地关联                                              │
└──────────────────────────────────────────────────────────┘
```

---

## 5. gRPC 连接池管理

```rust
pub struct MediaConnectionPool {
    /// 服务发现缓存（端点来源）
    discovery: Arc<ServiceDiscoveryCache>,
    /// 活跃连接（instance_id → Channel）
    channels: DashMap<String, Channel>,
    /// 健康检查
    health: DashMap<String, ChannelHealth>,
    /// 连接配置
    config: PoolConfig,
}

pub struct PoolConfig {
    /// 每个端点的最大并发请求
    pub max_concurrent_per_endpoint: usize,
    /// 连接超时
    pub connect_timeout: Duration,
    /// 请求超时
    pub request_timeout: Duration,
    /// 重试次数
    pub max_retries: u32,
}

impl MediaConnectionPool {
    /// 获取可用 channel（从服务发现缓存解析端点 + 健康检查）
    pub async fn get_channel(&self) -> Result<Channel> {
        // Step 1: 从服务发现缓存获取 medserver 实例列表
        let endpoints = self.discovery.get_endpoints("medserver").await?;
        
        // Step 2: 按负载排序，选择健康实例
        for instance in &endpoints.instances {
            let heartbeat_key = format!("heartbeat:medserver:{}", instance.instance_id);
            let alive: bool = self.discovery.redis().exists(&heartbeat_key).await?;
            if !alive {
                continue;
            }
            
            // Step 3: 获取或创建连接
            if let Some(channel) = self.channels.get(&instance.instance_id) {
                if self.health.get(&instance.instance_id).map_or(false, |h| h.is_healthy()) {
                    return Ok(channel.clone());
                }
            }
            
            // 创建新连接
            let channel = Channel::from_shared(instance.grpc_endpoint.clone())?
                .connect_timeout(self.config.connect_timeout)
                .timeout(self.config.request_timeout)
                .connect()
                .await?;
            
            self.channels.insert(instance.instance_id.clone(), channel.clone());
            self.health.insert(instance.instance_id.clone(), ChannelHealth::healthy());
            return Ok(channel);
        }
        
        Err(Error::NoHealthyEndpoint)
    }
    
    /// 后台同步连接池状态（清理已下线实例的连接）
    pub async fn reconcile_loop(&self) {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            
            if let Ok(endpoints) = self.discovery.get_endpoints("medserver").await {
                let active_ids: HashSet<String> = endpoints.instances
                    .iter()
                    .map(|i| i.instance_id.clone())
                    .collect();
                
                // 清理已下线实例的连接
                let stale_ids: Vec<String> = self.channels.iter()
                    .filter(|entry| !active_ids.contains(entry.key()))
                    .map(|entry| entry.key().clone())
                    .collect();
                
                for id in stale_ids {
                    self.channels.remove(&id);
                    self.health.remove(&id);
                    info!(instance_id = %id, "removed stale connection");
                }
            }
        }
    }
}
```

---

## 6. 错误处理与超时

| 操作 | 超时 | 重试 | 错误处理 |
|------|------|------|---------|
| `CreateSession` | 500ms | 1 次（不同端点） | 返回 503 Service Unavailable |
| `ModifySession` | 500ms | 1 次 | 记录错误，不中断通话 |
| `DeleteSession` | 500ms | 不重试 | 记录错误，依赖 medserver 超时清理 |
| `StartRecording` | 500ms | 1 次 | 记录错误，通知用户录音不可用 |
| `PlayIvr` | 1000ms | 1 次 | 播放备用提示音或返回错误 |
| `SubscribeEvents` | - | 自动重连（指数退避） | 事件丢失可容忍 |
