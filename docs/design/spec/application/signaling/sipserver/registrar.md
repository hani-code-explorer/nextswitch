# Registrar 模块

---

## 1. REGISTER 处理流程

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

---

## 2. 注册数据结构

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
