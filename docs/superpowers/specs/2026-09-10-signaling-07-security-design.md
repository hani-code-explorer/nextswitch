# 信令服务器安全设计

> 本文档是 [信令服务器细化设计索引](2026-09-10-signaling-00-index.md) 的第 7 部分。
> 本节与 `signaling-server-design.md` §6 和 `platform-security-design.md` 互补，聚焦信令层的实现细节。

---

## 1. SIP 信令安全

### 1.1 SIP DIGEST 认证

```rust
pub struct SipDigestAuth {
    /// Nonce 生成器
    nonce_generator: NonceGenerator,
    /// Nonce 有效期
    nonce_lifetime: Duration,     // 默认 60s
    /// 最大使用次数
    nonce_max_count: u32,         // 默认 1000
    /// Nonce 存储（Redis）
    nonce_store: Arc<RedisPool>,
}

impl SipDigestAuth {
    /// 生成 401 挑战
    pub fn generate_challenge(&self, realm: &str) -> String {
        let nonce = self.nonce_generator.generate();
        let opaque = self.nonce_generator.generate_opaque();

        // 存储 nonce 到 Redis（用于后续校验）
        let key = format!("sip:nonce:{}", nonce);
        self.nonce_store.set_ex(key, "valid", self.nonce_lifetime.as_secs());

        format!(
            r#"Digest realm="{}", nonce="{}", opaque="{}", algorithm=MD5, qop="auth""#,
            realm, nonce, opaque
        )
    }

    /// 验证 DIGEST 响应
    pub async fn verify_response(
        &self,
        auth_header: &str,
        method: &str,
        uri: &str,
        extension: &ExtensionConfig,
    ) -> Result<bool> {
        let parsed = DigestAuth::parse(auth_header)?;

        // 检查 nonce 有效性
        let nonce_key = format!("sip:nonce:{}", parsed.nonce);
        let valid: bool = self.nonce_store.exists(&nonce_key).await?;
        if !valid {
            return Ok(false); // nonce 过期或无效
        }

        // 计算期望的 response
        let ha1 = Self::compute_ha1(&extension.username, &parsed.realm, &extension.password_hash);
        let ha2 = Self::compute_ha2(method, uri);
        let expected = Self::compute_response(&ha1, &parsed.nonce, &parsed.nc, &parsed.cnonce, &parsed.qop, &ha2);

        Ok(expected == parsed.response)
    }
}
```

**认证流程**：

```
SIP 话机                              sipserver
  │                                      │
  │  REGISTER                            │
  │  Authorization: (空)                  │
  │ ────────────────────────────────────►│
  │                                      │
  │  401 Unauthorized                    │
  │  WWW-Authenticate: Digest            │
  │    realm="nextswitch",               │
  │    nonce="随机生成的64位hex",          │
  │    algorithm=MD5,                    │
  │    qop="auth"                        │
  ◄────────────────────────────────────│
  │                                      │
  │  REGISTER                            │
  │  Authorization: Digest               │
  │    username="1001",                  │
  │    realm="nextswitch",               │
  │    nonce="...",                      │
  │    uri="sip:nextswitch.com",         │
  │    response="MD5计算结果",             │
  │    qop=auth,                         │
  │    nc=00000001,                      │
  │    cnonce="客户端随机数"               │
  │ ────────────────────────────────────►│
  │                                      │
  │  ① 从 extensions 表获取 password_hash │
  │  ② 用相同参数计算期望 response         │
  │  ③ 比对 response                     │
  │                                      │
  │  200 OK                              │
  │  (认证通过，写入 Redis 注册表)          │
  ◄────────────────────────────────────│
```

> **与平台 JWT 认证的关系**：SIP DIGEST 认证（RFC 2617）与平台的 JWT 认证体系完全独立。SIP 话机注册使用 DIGEST 认证，凭证基于 `extensions.auth_secret` 字段。WebSocket 信令端点使用 JWT（通过 `?token=<jwt>` 传递），由平台 Auth Service 签发。两套认证机制互不影响。

### 1.2 反欺骗注册

```rust
pub struct AntiSpoofing {
    /// 注册速率检测（per IP）
    register_rate: RateLimiter,
    /// 用户名枚举检测（per IP）
    username_enumeration: RateLimiter,
    /// 最大关联数（一个 IP 最多注册多少个不同分机）
    max_extensions_per_ip: usize,
    /// IP → 已注册分机集合
    ip_extension_map: DashMap<IpAddr, HashSet<String>>,
}

impl AntiSpoofing {
    pub fn check_registration(
        &self,
        source_ip: IpAddr,
        extension: &str,
        tenant_id: i64,
    ) -> SpoofingResult {
        // ① 注册速率限制：同一 IP 每秒最多 5 次 REGISTER
        if !self.register_rate.check(&source_ip, 5, Duration::from_secs(1)) {
            return SpoofingResult::RateLimited;
        }

        // ② 用户名枚举防护：同一 IP 对不同用户名注册失败 ≥ 10 次 → 临时封禁
        if !self.username_enumeration.check(&source_ip, 10, Duration::from_secs(60)) {
            return SpoofingResult::UsernameEnumeration;
        }

        // ③ 批量注册检测
        let mut entry = self.ip_extension_map.entry(source_ip).or_insert_with(HashSet::new);
        if !entry.contains(extension) && entry.len() >= self.max_extensions_per_ip {
            metrics::counter!("anti_spoofing_alert_total", "type" => "mass_registration").increment(1);
            return SpoofingResult::Alert;
        }

        entry.insert(extension.to_string());
        SpoofingResult::Allow
    }
}
```

**安全响应策略**：

| 场景 | 响应 | 理由 |
|------|------|------|
| 用户名不存在 | 403 Forbidden | 不暴露分机是否存在（防枚举） |
| 密码错误 | 401 Unauthorized | 正常认证失败 |
| 分机已禁用 | 403 Forbidden | 与"不存在"相同响应 |
| 分机已锁定 | 403 Forbidden | 与"不存在"相同响应 |
| Contact 不匹配 | 403 Forbidden + 告警 | 可能的劫持尝试 |

### 1.3 话费欺诈检测

```rust
pub struct TollFraudDetector {
    /// 分机维度：短时间内大量外呼检测
    per_extension: DashMap<i64, CallWindow>,
    /// 租户维度：异常费用模式检测
    per_tenant: DashMap<i64, CallWindow>,
    /// 全局：国际号码突增检测
    international_spike: DashMap<i64, CallWindow>,
}

struct CallWindow {
    calls: VecDeque<Instant>,
    international_count: u32,
    total_duration_secs: u64,
    window: Duration,                 // 检测窗口，默认 10 分钟
}

impl TollFraudDetector {
    pub fn record_call(&self, call: &CallRecord) -> Option<SecurityEvent> {
        // ① 分机维度：10 分钟内外呼 > 20 次 → 告警
        // ② 分机维度：10 分钟内国际呼叫 > 5 次 → 告警
        // ③ 分机维度：10 分钟内总通话时长 > 600 秒 → 告警
        // ④ 租户维度：1 小时内国际呼叫费用突增 3 倍 → 告警
        // ⑤ 非工作时间（23:00-06:00）的国际呼叫 → 告警
        // 自动响应：暂停该分机外呼权限（需管理员手动恢复）
        todo!()
    }
}
```

**自动响应动作**：

| 检测规则 | 阈值 | 自动动作 |
|---------|------|---------|
| 分机短时间大量外呼 | 10 分钟 > 20 次 | 暂停外呼权限 + 告警 |
| 分机国际呼叫突增 | 10 分钟 > 5 次 | 暂停外呼权限 + 告警 |
| 非工作时间国际呼叫 | 任何 | 告警（不自动暂停，可能有合法场景） |
| 租户费用突增 | 1 小时 > 3x 基线 | 告警管理员 |

---

## 2. 服务间认证

### 2.1 gRPC mTLS

所有 gRPC 通信使用 mTLS 双向认证：

```
sipserver/sigserver                    medserver/router-server
       │                                        │
       │  TLS 握手                               │
       │  ├─ 服务端证书验证（CA 签发）               │
       │  ├─ 客户端证书验证（CA 签发）               │
       │  └─ TLS 1.3 加密通道建立                  │
       │                                        │
       │  gRPC 调用                              │
       │  Metadata:                              │
       │    x-service-id: sipserver-01           │
       │    x-site-id: us-east-1                 │
       │    x-hmac-signature: <HMAC-SHA256>      │
       │    x-hmac-timestamp: 1699999999          │
       │    x-hmac-nonce: uuid-v4                │
       │ ──────────────────────────────────────► │
```

### 2.2 HMAC-SHA256 签名信封

遵循 `platform-security-design.md` §3 的服务间认证规范：

```rust
pub struct HmacSigner {
    /// 服务密钥（从 Vault 加载）
    service_key: [u8; 32],
    /// 时间戳窗口
    timestamp_window: Duration,  // 30s
}

impl HmacSigner {
    /// 为 gRPC metadata 生成签名
    pub fn sign(&self, metadata: &Metadata) -> HmacEnvelope {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let nonce = Uuid::new_v4().to_string();

        // 构造签名字符串
        let sign_string = format!(
            "{}\n{}\n{}\n{}",
            metadata.get("x-service-id").unwrap(),
            timestamp,
            nonce,
            metadata.get("x-request-path").unwrap(),
        );

        // HMAC-SHA256 签名
        let signature = hmac_sha256(&self.service_key, sign_string.as_bytes());

        HmacEnvelope {
            signature: base64::encode(signature),
            timestamp,
            nonce,
        }
    }

    /// 验证签名
    pub fn verify(&self, envelope: &HmacEnvelope, metadata: &Metadata) -> Result<bool> {
        // 检查时间戳窗口
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        if (now as i64 - envelope.timestamp as i64).abs() > self.timestamp_window.as_secs() as i64 {
            return Ok(false); // 时间戳过期，可能的重放攻击
        }

        // 重新计算签名并比对
        let sign_string = format!(
            "{}\n{}\n{}\n{}",
            metadata.get("x-service-id").unwrap(),
            envelope.timestamp,
            envelope.nonce,
            metadata.get("x-request-path").unwrap(),
        );
        let expected = hmac_sha256(&self.service_key, sign_string.as_bytes());
        let expected_b64 = base64::encode(expected);

        Ok(constant_time_eq(&expected_b64.as_bytes(), &envelope.signature.as_bytes()))
    }
}
```

### 2.3 Redis Pub/Sub 消息签名

为防止 Redis Pub/Sub 消息被伪造（例如 Redis 被入侵后注入虚假配置变更），所有配置变更消息携带 HMAC 签名：

```rust
pub struct PubSubMessageSigner {
    signing_key: [u8; 32],
}

impl PubSubMessageSigner {
    /// 发送端签名
    pub fn sign(&self, payload: &[u8]) -> String {
        let sig = hmac_sha256(&self.signing_key, payload);
        hex::encode(sig)
    }

    /// 接收端验签
    pub fn verify(&self, payload: &[u8], signature: &str) -> bool {
        let expected = self.sign(payload);
        constant_time_eq(expected.as_bytes(), signature.as_bytes())
    }
}
```

消息格式扩展（在索引文档 Appendix A.1 的基础上增加 `_signature` 字段）：

```json
{
    "action": "update",
    "entity_type": "extensions",
    "entity_id": 12345,
    "tenant_id": 1,
    "version": 456,
    "timestamp": 1699999999000,
    "changed_by": "admin-user",
    "_signature": "a1b2c3d4e5f6..."
}
```

---

## 3. 通信加密矩阵

| 通信路径 | 协议 | 加密方式 | 认证方式 |
|---------|------|---------|---------|
| SIP 话机 → sipserver | UDP/TCP | 无（SRTP 加密媒体） | SIP DIGEST |
| SIP 话机 → sipserver | TLS | TLS 1.2+ | SIP DIGEST + 服务端证书 |
| WebRTC 客户端 → sigserver | WSS | TLS 1.3 | JWT + 服务端证书 |
| sipserver → Redis | TCP | TLS 1.2+（可选） | 密码认证 |
| sigserver → Redis | TCP | TLS 1.2+（可选） | 密码认证 |
| sipserver → router-server | gRPC | mTLS 1.3 | 客户端/服务端证书 + HMAC |
| sipserver → medserver | gRPC | mTLS 1.3 | 客户端/服务端证书 + HMAC |
| sigserver → medserver | gRPC | mTLS 1.3 | 客户端/服务端证书 + HMAC |
| sipserver → config-service | gRPC | mTLS 1.3 | 客户端/服务端证书 + HMAC |
| sipserver ↔ sigserver | Redis Pub/Sub | TLS 1.2+（Redis 连接层） | HMAC 消息签名 |

---

## 4. SIP 防火墙

### 4.1 消息深度校验

```rust
pub struct SipFirewall {
    validator: SipMessageValidator,
    topology_hider: TopologyHider,
    sdp_security: SdpSecurityProcessor,
}

impl SipFirewall {
    pub fn inspect(&self, msg: &mut SipMessage, source_ip: IpAddr) -> Result<(), SipFirewallError> {
        // ① 消息格式合法性
        self.validator.validate(msg)?;

        // ② 消息大小限制
        if msg.raw_len() > MAX_SIP_MESSAGE_SIZE {     // 默认 8KB
            return Err(SipFirewallError::MessageTooLarge);
        }

        // ③ 方法白名单
        const ALLOWED_METHODS: &[&str] = &[
            "INVITE", "ACK", "BYE", "CANCEL", "REGISTER", "OPTIONS", "REFER", "NOTIFY", "INFO",
        ];
        if !ALLOWED_METHODS.contains(&msg.method()) {
            return Err(SipFirewallError::MethodNotAllowed);
        }

        // ④ 必选头检查
        self.validator.require_headers(msg, &[
            "Via", "From", "To", "Call-ID", "CSeq", "Max-Forwards",
        ])?;

        // ⑤ Max-Forwards 检查（防循环）
        if msg.max_forwards() == 0 {
            return Err(SipFirewallError::MaxForwardsExceeded);
        }

        // ⑥ Via 头检查（防路由循环和注入）
        self.validator.check_via_integrity(msg)?;

        // ⑦ SDP 安全处理（INVITE/200 OK 时）
        if msg.has_sdp() {
            self.sdp_security.process(msg)?;
        }

        // ⑧ 拓扑隐藏（出站消息）
        self.topology_hider.hide(msg);

        Ok(())
    }
}
```

### 4.2 SIP 注入防护

```rust
impl SipMessageValidator {
    pub fn validate(&self, msg: &SipMessage) -> Result<(), ValidationError> {
        // ① SIP 版本检查：仅允许 SIP/2.0
        if msg.version() != "SIP/2.0" {
            return Err(ValidationError::InvalidVersion);
        }

        // ② URI 注入检测（CRLF 注入、括号注入）
        self.check_uri_injection(msg.from())?;
        self.check_uri_injection(msg.to())?;
        self.check_uri_injection(msg.request_uri())?;

        // ③ Call-ID 长度限制
        if msg.call_id().len() > 256 {
            return Err(ValidationError::CallIdTooLong);
        }

        // ④ CSeq 方法一致性
        if msg.cseq_method() != msg.method() {
            return Err(ValidationError::CseqMethodMismatch);
        }

        // ⑤ 自定义头数量限制（防头部泛洪）
        if msg.header_count() > 64 {
            return Err(ValidationError::TooManyHeaders);
        }

        // ⑥ 单个头部大小限制
        for header in msg.headers() {
            if header.value_len() > 4096 {
                return Err(ValidationError::HeaderTooLarge);
            }
        }

        Ok(())
    }

    fn check_uri_injection(&self, uri: &SipUri) -> Result<(), ValidationError> {
        let raw = uri.to_string();
        // 禁止 \r\n（CRLF 注入）
        if raw.contains('\r') || raw.contains('\n') {
            return Err(ValidationError::CrlfInjection);
        }
        // 禁止 <> 嵌套（防止伪造额外头）
        if raw.matches('<').count() > 1 || raw.matches('>').count() > 1 {
            return Err(ValidationError::BracketInjection);
        }
        Ok(())
    }
}
```

---

## 5. 拓扑隐藏

防止外部实体获取内部网络拓扑信息：

```rust
pub struct TopologyHider;

impl TopologyHider {
    /// 处理出站 SIP 消息（发往外部）
    pub fn hide(&self, msg: &mut SipMessage) {
        // ① 移除内部 Via 头
        //    保留最外层的 Via（指向 sipserver 公网地址），
        //    移除内部实例的 Via 头
        self.strip_internal_vias(msg);

        // ② 移除 Record-Route 中的内部地址
        //    仅保留 sipserver 公网地址的 Record-Route
        self.strip_internal_record_routes(msg);

        // ③ 移除泄露内部信息的自定义头
        const STRIP_HEADERS: &[&str] = &[
            "X-Internal-Route",
            "X-Trace-Id",           // 追踪 ID 仅在内部传递
            "X-Instance-Id",
            "X-Site-Id",
        ];
        for header in STRIP_HEADERS {
            msg.remove_header(header);
        }

        // ④ 替换 Contact 中的内部 IP
        //    将 Contact 指向 sipserver 的公网地址
        self.rewrite_contact_to_public(msg);
    }
}
```

---

## 6. SDP 安全

```rust
pub struct SdpSecurityProcessor;

impl SdpSecurityProcessor {
    pub fn process(&self, msg: &mut SipMessage) -> Result<(), SdpError> {
        let sdp = msg.sdp_mut().ok_or(SdpError::NoSdp)?;

        // ① 媒体端口范围校验（与防火墙规则一致）
        for media in &sdp.media {
            if media.port < 10000 || media.port > 60000 {
                return Err(SdpError::PortOutOfRange);
            }
        }

        // ② 编解码器白名单（静默过滤不支持的编解码器）
        const ALLOWED_CODECS: &[&str] = &[
            "PCMU", "PCMA", "G729", "G722", "opus", "G723",
        ];
        for media in &sdp.media {
            for codec in &media.codecs {
                if !ALLOWED_CODECS.contains(&codec.name.as_str()) {
                    media.remove_codec(&codec.name);
                }
            }
        }

        // ③ SDP 大小限制
        if sdp.raw_len() > 4096 {
            return Err(SdpError::SdpTooLarge);
        }

        // ④ 连接地址重写（NAT 穿越）
        self.rewrite_connection_address(sdp, msg.source_ip())?;

        Ok(())
    }
}
```

---

## 7. 敏感数据保护

| 数据类型 | 存储 | 传输 | 日志 |
|---------|------|------|------|
| 分机密码/哈希 | 数据库加密存储（AES-256-GCM） | 不传输 | 永不记录 |
| SIP DIGEST nonce | Redis（TTL 60s） | 通过 SIP 头传输 | 可记录（无敏感性） |
| JWT token | 客户端持有 | WSS 连接参数 | 仅记录 token ID，不记录完整 token |
| Redis 密码 | Vault 管理 | TLS 加密传输 | 永不记录 |
| gRPC 服务密钥 | Vault 管理 | 启动时一次性加载 | 永不记录 |
| SDP 媒体地址 | 内存中处理 | 通过 SIP/SDP 传输 | 结构化日志中脱敏 |
| CDR 主叫/被叫号码 | 数据库加密存储 | 内部 API 传输 | 日志中部分脱敏（`1001` → `10**`） |

### 7.1 日志脱敏

```rust
pub struct LogSanitizer;

impl LogSanitizer {
    /// 脱敏电话号码
    pub fn sanitize_phone(phone: &str) -> String {
        if phone.len() <= 2 {
            return "**".to_string();
        }
        let visible = phone.len() - 2;
        let prefix = &phone[..visible.min(2)];
        format!("{}**", prefix)
    }

    /// 脱敏 IP 地址（保留网段）
    pub fn sanitize_ip(ip: &IpAddr) -> String {
        match ip {
            IpAddr::V4(v4) => {
                let octets = v4.octets();
                format!("{}.{}.***.***", octets[0], octets[1])
            }
            IpAddr::V6(v6) => {
                format!("{}:***", &v6.to_string()[..4])
            }
        }
    }
}
```
