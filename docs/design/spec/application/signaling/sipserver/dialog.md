# Dialog 模块（B2BUA）

---

## 1. B2BUA 会话管理

```rust
pub struct DialogManager {
    /// 活跃的 B2BUA 会话
    dialogs: DashMap<String, Arc<B2buaDialog>>,
    /// 呼叫 ID → Dialog ID 索引
    call_id_index: DashMap<String, String>,
}

pub struct B2buaDialog {
    pub id: String,
    pub call_id: String,
    pub tenant_id: i64,
    
    /// Leg A（主叫侧）
    pub leg_a: DialogLeg,
    /// Leg B（被叫侧）
    pub leg_b: Option<DialogLeg>,
    
    /// 降级原因
    pub downgrade_reason: B2buaReason,
    
    /// 关联的媒体会话 ID
    pub media_session_id: Option<String>,
    
    /// 状态
    pub state: AtomicEnum<DialogState>,
    
    pub created_at: Instant,
}

pub struct DialogLeg {
    pub call_id: String,
    pub from_tag: String,
    pub to_tag: String,
    pub cseq: u32,
    pub remote_target: String,
    pub route_set: Vec<String>,
    pub local_sdp: Option<String>,
    pub remote_sdp: Option<String>,
}

pub enum B2buaReason {
    Recording,        // 通话录音
    Conference,       // 会议桥
    Ivr,              // IVR 导航
    Transcode,        // 协议转换（SIP↔WebRTC）
    CallFlow,         // 呼叫流程编排
}

pub enum DialogState {
    Trying,           // Leg A 已建立，正在建立 Leg B
    Early,            // Leg B 已收到 1xx
    Confirmed,        // 双方都已应答
    Terminated,       // 通话结束
}
```

---

## 2. B2BUA 消息转发

```
主叫 (Leg A)              sipserver (B2BUA)              medserver              被叫 (Leg B)
    │                          │                             │                        │
    │ INVITE (SDP-A)           │                             │                        │
    │ ────────────────────────►│                             │                        │
    │                          │ create_session(transcode)   │                        │
    │                          │ ──────────────────────────► │                        │
    │                          │ { media_endpoint: rtp://... }                        │
    │                          │ ◄────────────────────────── │                        │
    │                          │                             │                        │
    │ 100 Trying               │                             │                        │
    │ ◄────────────────────────│                             │                        │
    │                          │ INVITE (SDP-Media)          │                        │
    │                          │ ───────────────────────────────────────────────────►│
    │                          │                             │                        │
    │                          │ 200 OK (SDP-B)              │                        │
    │                          │ ◄───────────────────────────────────────────────────│
    │                          │ update_session(link_leg_b)  │                        │
    │                          │ ──────────────────────────► │                        │
    │                          │                             │                        │
    │ 200 OK (SDP-Media)       │                             │                        │
    │ ◄────────────────────────│                             │                        │
    │                          │                             │                        │
    │ ACK                      │                             │                        │
    │ ────────────────────────►│                             │                        │
    │                          │ ACK                         │                        │
    │                          │ ───────────────────────────────────────────────────►│
    │                          │                             │                        │
    │ ════ 媒体流 ═════════════│ ════ RTP ══════════════════ │ ════ RTP ════════════ │
    │      SDP-A ↔ Media       │      Media ↔ Media          │      Media ↔ SDP-B     │
```
