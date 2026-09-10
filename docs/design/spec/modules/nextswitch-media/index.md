# nextswitch-media

> 媒体处理库

---

## 概述

nextswitch-media 提供 RTP/RTCP 媒体处理功能，用于媒体服务的核心实现。

## 功能模块

### RTP 处理

```rust
pub struct RtpPacket {
    pub version: u8,
    pub payload_type: u8,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub payload: Bytes,
}

impl RtpPacket {
    pub fn parse(data: &[u8]) -> Result<RtpPacket>;
    pub fn serialize(&self) -> Bytes;
}

pub struct RtpSession {
    pub local_ssrc: u32,
    pub remote_ssrc: u32,
    pub seq: AtomicU16,
    pub codec: Arc<dyn Codec>,
}

impl RtpSession {
    pub fn send(&self, payload: &[u8]) -> Result<()>;
    pub fn recv(&self) -> Result<RtpPacket>;
}
```

- RTP 包解析与序列化
- 序列号管理
- 时间戳处理
- SSRC 管理

### RTCP 处理

```rust
pub enum RtcpPacket {
    SenderReport(SenderReport),
    ReceiverReport(ReceiverReport),
    Bye(Bye),
    Nack(Nack),
}

pub struct SenderReport {
    pub ssrc: u32,
    pub ntp_timestamp: u64,
    pub rtp_timestamp: u32,
    pub packet_count: u32,
    pub octet_count: u32,
}
```

- RTCP SR/RR 处理
- NACK 丢包重传
- 统计信息收集

### 编解码接口

```rust
pub trait Codec: Send + Sync {
    fn payload_type(&self) -> u8;
    fn clock_rate(&self) -> u32;
    fn encode(&self, pcm: &[i16]) -> Result<Bytes>;
    fn decode(&self, data: &[u8]) -> Result<Vec<i16>>;
}

pub struct Pcmu;  // G.711 μ-law
pub struct Pcma;  // G.711 A-law
pub struct Opus;  // Opus
pub struct G729;  // G.729
```

- 统一编解码接口
- G.711 (PCMU/PCMA) 实现
- Opus 编解码
- G.729 编解码（可选）

### 媒体会话

```rust
pub struct MediaSession {
    pub id: String,
    pub rtp_session: RtpSession,
    pub codec: Arc<dyn Codec>,
    pub remote_addr: SocketAddr,
    pub state: AtomicEnum<SessionState>,
}

impl MediaSession {
    pub fn send_audio(&self, pcm: &[i16]) -> Result<()>;
    pub fn recv_audio(&self) -> Result<Vec<i16>>;
}
```

- 媒体会话管理
- 编解码转换
- 远端地址管理

### 媒体混合（会议桥）

```rust
pub struct MediaMixer {
    pub sessions: Vec<Arc<MediaSession>>,
    pub mix_strategy: MixStrategy,
}

impl MediaMixer {
    pub fn add_participant(&mut self, session: Arc<MediaSession>);
    pub fn remove_participant(&mut self, session_id: &str);
    pub fn mix_and_distribute(&self) -> Result<()>;
}
```

- 多方音频混合
- 静音检测
- 音量归一化

### 录音

```rust
pub struct MediaRecorder {
    pub session_id: String,
    pub output_path: PathBuf,
    pub format: RecordingFormat,
}

impl MediaRecorder {
    pub fn start(&mut self) -> Result<()>;
    pub fn stop(&mut self) -> Result<RecordingInfo>;
    pub fn write_frame(&mut self, pcm: &[i16]) -> Result<()>;
}
```

- 媒体流录制
- WAV/MP3 格式支持
- 双轨录音

## 被依赖方

| 应用 | 用途 |
|------|------|
| medserver | RTP/RTCP 处理、编解码、会议桥、录音 |
