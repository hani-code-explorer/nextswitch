# WebRTC 媒体协商

---

## 1. SDP 协商流程

```
WebRTC 客户端                sigserver                  medserver
     │                           │                            │
     │ invite (SDP offer)        │                            │
     │ ─────────────────────────►│                            │
     │                           │                            │
     │                           │ create_session(webRTC)     │
     │                           │ ──────────────────────────►│
     │                           │ {                          │
     │                           │   media_endpoint:          │
     │                           │     rtp://medserver:10000  │
     │                           │   ice_credentials: {...}   │
     │                           │   dtls_fingerprint: {...}  │
     │                           │ }                          │
     │                           │ ◄──────────────────────────│
     │                           │                            │
     │ invite response           │                            │
     │ { sdp_answer: ... }       │                            │
     │ ◄────────────────────────│                            │
     │                           │                            │
     │ ice_candidate             │                            │
     │ ─────────────────────────►│                            │
     │                           │ (透传到 medserver)          │
     │                           │ ──────────────────────────►│
     │                           │                            │
     │ ice_candidate             │                            │
     │ ◄────────────────────────│                            │
     │                           │ ◄──────────────────────────│
     │                           │                            │
     │ ═══ WebRTC 媒体流 ═══════ │ ═══ RTP ═══════════════════│
     │      ↔ medserver          │      ↔ 对端                 │
```

---

## 2. ICE 候选交换

```rust
pub struct MediaNegotiation {
    /// 本地 ICE 候选
    local_candidates: Vec<IceCandidate>,
    /// 远端 ICE 候选
    remote_candidates: Vec<IceCandidate>,
    /// ICE 连接状态
    ice_state: AtomicEnum<IceConnectionState>,
    /// DTLS 指纹
    dtls_fingerprint: Option<String>,
}

pub enum IceConnectionState {
    New,
    Checking,
    Connected,
    Completed,
    Failed,
    Disconnected,
    Closed,
}
```
