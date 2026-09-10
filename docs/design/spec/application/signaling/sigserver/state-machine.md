# 呼叫状态机

---

## 1. WebRTC 呼叫状态机

```
                    ┌─────────┐
                    │  Idle   │
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │                     │
         invite (主叫)         incoming_call (被叫)
              │                     │
              ▼                     ▼
        ┌──────────┐         ┌──────────┐
        │ Trying   │         │ Alerting │
        └────┬─────┘         └────┬─────┘
             │                    │
      ┌──────┼──────┐      ┌─────┼──────┐
      │             │      │            │
  call_progress  call_ended answer      bye
  (ringing)      (取消)    │            │
      │             │      │            │
      ▼             ▼      ▼            ▼
 ┌──────────┐  ┌──────┐ ┌──────────┐ ┌──────────┐
 │ Ringing  │  │Ended │ │Answered  │ │Ended     │
 └────┬─────┘  └──────┘ └────┬─────┘ └──────────┘
      │                       │
 ┌────┼────┐             ┌────┼────┐
 │    │    │             │    │    │
answer bye  bye      bye hold  transfer
 │    │    │             │    │    │
 ▼    ▼    ▼             ▼    ▼    ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│Answered│ │Ended│ │Ended│ │ Held │
└──────┘ └──────┘ └──────┘ └──┬───┘
                               │
                          resume/bye
                               │
                               ▼
                         ┌──────────┐
                         │Answered/ │
                         │ Ended    │
                         └──────────┘
```

---

## 2. 呼叫上下文

```rust
pub struct CallSession {
    pub call_id: String,
    pub tenant_id: i64,
    pub direction: CallDirection,
    pub state: AtomicEnum<CallState>,
    
    /// 主叫信息
    pub caller: EndpointInfo,
    /// 被叫信息
    pub callee: EndpointInfo,
    
    /// WebRTC PeerConnection 管理
    pub peer_connection: Arc<PeerConnection>,
    
    /// 关联的媒体会话
    pub media_session_id: Option<String>,
    
    /// CDR 数据（实时更新）
    pub cdr: RwLock<CdrRecord>,
    
    /// 呼叫开始时间
    pub started_at: Instant,
    /// 应答时间
    pub answered_at: Option<Instant>,
    /// 结束时间
    pub ended_at: Option<Instant>,
}

pub enum CallDirection {
    Inbound,    // 来自 WebRTC 客户端
    Outbound,   // 发往 WebRTC 客户端
}

pub struct EndpointInfo {
    pub extension: String,
    pub connection_id: ConnectionId,
    pub display_name: Option<String>,
}
```
