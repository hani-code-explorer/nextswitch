# NextSWITCH Media Server (medserver) 设计规格

**版本**: 3.0.0  
**日期**: 2026-09-10  
**状态**: 草案  

---

## 目录

1. [总体架构](#1-总体架构)
2. [Pipeline 引擎设计](#2-pipeline-引擎设计)
3. [多站点设计](#3-多站点设计)
4. [传输层与端口管理](#4-传输层与端口管理)
5. [gRPC API 与服务接口](#5-grpc-api-与服务接口)
6. [会话管理](#6-会话管理)
7. [录音功能](#7-录音功能)
8. [会议功能](#8-会议功能)
9. [IVR 功能](#9-ivr-功能)
10. [转码功能](#10-转码功能)
11. [ASR/TTS 集成](#11-asrtts-集成)
12. [错误处理](#12-错误处理)
13. [测试策略](#13-测试策略)
14. [监控与可观测性](#14-监控与可观测性)

---

## 1. 总体架构

### 1.1 Crate 结构

```
nextswitch-media/
├── src/
│   ├── lib.rs              # 库入口
│   ├── pipeline/           # Pipeline 引擎
│   │   ├── mod.rs
│   │   ├── node.rs         # Node trait
│   │   ├── source.rs       # 源节点
│   │   ├── sink.rs         # 汇节点
│   │   └── processor.rs    # 处理节点
│   ├── transport/          # 传输层
│   │   ├── mod.rs
│   │   ├── rtp.rs          # RTP 传输
│   │   ├── srtp.rs         # SRTP/DTLS
│   │   └── port_pool.rs    # 端口池
│   ├── session/            # 会话管理
│   │   ├── mod.rs
│   │   ├── table.rs        # 会话表
│   │   └── reaper.rs       # 超时清理
│   ├── codec/              # 编解码
│   │   ├── mod.rs
│   │   ├── pcmu.rs
│   │   ├── pcma.rs
│   │   ├── g722.rs
│   │   ├── g729.rs
│   │   └── opus.rs
│   ├── features/           # 媒体功能
│   │   ├── recording.rs    # 录音
│   │   ├── conference.rs   # 会议
│   │   ├── ivr.rs          # IVR
│   │   └── transcoder.rs   # 转码
│   ├── asr_tts/            # ASR/TTS 集成
│   │   ├── mod.rs          # 模块入口、ProviderRegistry
│   │   ├── provider.rs     # Provider trait 定义
│   │   ├── router.rs       # 流量控制与路由选择
│   │   ├── pool.rs         # 连接池管理
│   │   ├── aliyun/         # 阿里云语音服务
│   │   │   ├── mod.rs
│   │   │   ├── asr.rs      # 实时语音识别 (SpeechTranscriber)
│   │   │   ├── tts.rs      # 流式语音合成 (FlowingSpeechSynthesizer)
│   │   │   └── token.rs    # Token 管理（自动刷新）
│   │   ├── pipeline.rs     # Pipeline 节点集成
│   │   └── events.rs       # ASR/TTS 事件定义
│   ├── api/                # gRPC API
│   │   ├── mod.rs
│   │   └── server.rs
│   └── monitoring/         # 监控
│       ├── mod.rs
│       ├── metrics.rs
│       └── api.rs
└── Cargo.toml
```

### 1.2 核心设计原则

1. **Pipeline 架构**：所有媒体处理通过可组合的 Node 链完成
2. **站点内优先**：每个站点独立部署，99% 流量本地处理
3. **零拷贝优先**：Pipeline 节点间传递 `Arc<AudioFrame>` 避免拷贝
4. **优雅降级**：资源不足时自动降级，不阻塞主媒体流
5. **可观测性**：内置 Prometheus 指标 + 前端 REST API

### 1.3 部署模式

**混合部署**：
- **独立部署**：medserver 作为独立进程，通过 gRPC 与 sipserver 通信
- **嵌入模式**：medserver 库嵌入 sipserver 进程（低延迟场景）

**容量规划**：
- 单实例：~25,000 并发会话
- 单站点：多实例负载均衡，支持 ~100,000 并发流
- 多站点：每个站点独立集群，跨站点链路 <1% 流量

---

## 2. Pipeline 引擎设计

### 2.1 Node Trait

```rust
pub trait PipelineNode: Send + Sync {
    /// 节点 ID
    fn id(&self) -> &str;
    
    /// 处理一帧音频
    fn process_frame(&mut self, input: AudioFrame) -> Result<Vec<AudioFrame>>;
    
    /// 节点类型
    fn node_type(&self) -> NodeType;
    
    /// 是否可热插拔（运行时添加/移除）
    fn hot_pluggable(&self) -> bool;
}

pub enum NodeType {
    Source,        // 音频源（RTP 接收、文件播放）
    Sink,          // 音频汇（RTP 发送、文件录制）
    Processor,     // 处理节点（编解码、混音、转码）
}
```

### 2.2 Pipeline 结构

```rust
pub struct Pipeline {
    /// 节点链（有序）
    nodes: Vec<Arc<Mutex<dyn PipelineNode>>>,
    
    /// 消息通道（节点间异步通信）
    message_bus: MessageBus,
    
    /// 运行状态
    state: AtomicEnum<PipelineState>,
    
    /// 统计
    stats: PipelineStats,
}

impl Pipeline {
    /// 添加节点
    pub fn add_node(&mut self, node: Box<dyn PipelineNode>);
    
    /// 移除节点（热插拔）
    pub fn remove_node(&mut self, node_id: &str) -> Result<()>;
    
    /// 启动 Pipeline
    pub async fn start(&mut self) -> Result<()>;
    
    /// 停止 Pipeline
    pub async fn stop(&mut self) -> Result<()>;
}
```

### 2.3 数据流

```
典型 Pipeline：

RTP Source → Decoder → [Recorder] → [Mixer] → Encoder → RTP Sink
     │           │          │           │          │          │
     └───────────┴──────────┴───────────┴──────────┴──────────┘
                    零拷贝 Arc<AudioFrame> 传递
```

**关键设计**：
- 节点间通过 `Arc<AudioFrame>` 传递，避免内存拷贝
- 分支节点（如 Recorder）可以 TAP 分流，不影响主路径
- 每个节点独立线程或线程池，通过消息队列解耦

---

## 3. 多站点设计

### 3.1 站点拓扑

```
Global DNS / GeoIP LB
       │
  ┌────┼────┐
  │    │    │
Site  Site  Site
US    EU    AP
  │
┌─┴─┐
AZ1 AZ2  ← 每站点多可用区
```

每个站点是独立集群，拥有独立的：
- medserver 实例
- Redis 集群（会话状态）
- 数据库（CDR、配置）
- 录音存储

### 3.2 站点内优先原则

**核心约束**：
- 每个站点独立部署完整媒体处理能力
- 99% 流量在站点内处理，无跨站点媒体流
- 跨站点场景（<1%）：用户漫游、站点故障切换

**站点内路由**：
```
主叫 (Site US) → sipserver (Site US) → medserver (Site US) → 被叫 (Site US)
```

**跨站点路由**（例外场景）：
```
主叫 (Site US) → sipserver (Site US) → [跨站点 SIP Trunk] → 
sipserver (Site EU) → medserver (Site EU) → 被叫 (Site EU)
```

### 3.3 数据模型

所有会话、录音、统计必须包含站点标识：

```rust
pub struct MediaSession {
    pub id: String,
    pub call_id: String,
    pub site_id: String,          // 站点标识
    pub az_id: String,            // 可用区标识
    pub instance_id: String,      // 实例标识
    // ...
}
```

### 3.4 站点配置

```toml
[media.site]
site_id = "us-east-1"
az_id = "us-east-1a"
instance_id = "medserver-01"

# 站点容量
max_sessions = 25000
port_range = "10000-60000"

# 站点内 Redis
redis_url = "redis://redis-us-east-1:6379"
```

---

## 4. 传输层与端口管理

### 4.1 端口分配策略

```rust
pub struct PortPool {
    range: PortRange,          // 例如 10000-60000
    allocated: BitSet,         // 位图跟踪已分配端口对
    available: AtomicUsize,    // 可用端口对计数
}

impl PortPool {
    /// 分配一对端口（RTP even, RTCP odd）
    pub fn allocate_pair(&self) -> Option<PortPair>;
    
    /// 释放端口对
    pub fn release_pair(&self, pair: PortPair);
    
    /// 获取可用率（用于负载均衡）
    pub fn utilization(&self) -> f64;
}
```

**端口池要求**：
- 启动时扫描 `/proc/net/udp` 排除已占用端口
- 位图分配 O(1)，无锁并发
- 端口对必须连续（RTP even, RTCP odd）
- 支持配置多个端口范围

### 4.2 传输层抽象

```rust
pub trait MediaTransport: Send + Sync {
    fn create_endpoint(&self, local_addr: SocketAddr) -> Result<RtpEndpoint>;
    fn send_rtp(&self, endpoint: &RtpEndpoint, pkt: &RtpPacket) -> Result<()>;
    fn recv_rtp(&self, endpoint: &RtpEndpoint) -> Result<RtpPacket>;
    fn close_endpoint(&self, endpoint: RtpEndpoint);
}
```

### 4.3 SRTP/DTLS 处理

```rust
pub struct SecureTransport {
    mode: SecurityMode,
    srtp_ctx: Option<SrtpContext>,
    dtls_ctx: Option<DtlsSrtpContext>,
}

enum SecurityMode {
    None,                        // 纯 RTP
    SrtpSdes { key: [u8; 32] },  // SRTP with SDES
    DtlsSrtp,                    // DTLS-SRTP (WebRTC)
}
```

### 4.4 端口范围配置

```toml
[media.transport]
port_ranges = [
    { start = 10000, end = 20000 },
    { start = 30000, end = 40000 },
]
preallocate = 1000
max_sessions = 25000
```

### 4.5 服务端口分配

medserver 的完整端口分配遵循统一端口表（详见 `config-and-gateway-design.md` Appendix B）：

| 协议 | 端口 | 说明 |
|------|------|------|
| HTTP | - | 不提供 HTTP 服务 |
| Metrics/Health | 9092 | Prometheus 指标 + 健康检查 + Dashboard API |
| gRPC | 50051 | MediaService / MediaEvents 接口 |
| RTP | 10000-60000 | 媒体流端口池（可通过 `port_ranges` 配置子范围） |

**健康检查端点**（详见 `config-and-gateway-design.md` Appendix D）：

| 端点 | 用途 | medserver 判断逻辑 |
|------|------|-------------------|
| `GET /health` | 综合健康检查 | Redis 可达 + 端口池可用 |
| `GET /health/live` | K8s 存活探针 | 进程是否在响应 HTTP |
| `GET /health/ready` | K8s 就绪探针 | Redis 可达 + 端口池已初始化 |
| `GET /health/startup` | K8s 启动探针 | 端口池预分配完成 |

---

## 5. gRPC API 与服务接口

### 5.1 接口总览

```protobuf
service MediaService {
    // 会话生命周期
    rpc CreateSession(CreateSessionRequest) returns (CreateSessionResponse);
    rpc ModifySession(ModifySessionRequest) returns (ModifySessionResponse);
    rpc DeleteSession(DeleteSessionRequest) returns (DeleteSessionResponse);
    
    // Pipeline 操作
    rpc AttachNode(AttachNodeRequest) returns (AttachNodeResponse);
    rpc DetachNode(DetachNodeRequest) returns (DetachNodeResponse);
    
    // 媒体功能
    rpc StartRecording(StartRecordingRequest) returns (StartRecordingResponse);
    rpc StopRecording(StopRecordingRequest) returns (StopRecordingResponse);
    rpc JoinConference(JoinConferenceRequest) returns (JoinConferenceResponse);
    rpc LeaveConference(LeaveConferenceRequest) returns (LeaveConferenceResponse);
    rpc PlayIvr(PlayIvrRequest) returns (PlayIvrResponse);
    rpc StopIvr(StopIvrRequest) returns (StopIvrResponse);
    
    // 状态查询
    rpc GetSessionStats(GetSessionStatsRequest) returns (GetSessionStatsResponse);
    rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
}
```

### 5.2 核心消息定义

```protobuf
message CreateSessionRequest {
    string session_id = 1;
    string call_id = 2;
    string site_id = 3;
    MediaEndpoint local = 4;
    MediaEndpoint remote = 5;
    CodecPreference codecs = 6;
    SecurityMode security = 7;
}

message MediaEndpoint {
    string address = 1;
    uint32 rtp_port = 2;
    uint32 rtcp_port = 3;
    repeated CodecParam codecs = 4;
    IceCredentials ice = 5;
    DtlsFingerprint fingerprint = 6;
}
```

### 5.3 事件通知（双向流）

```protobuf
service MediaEvents {
    rpc SubscribeEvents(SubscribeEventsRequest) 
        returns (stream MediaEvent);
}

message MediaEvent {
    string session_id = 1;
    oneof event {
        SessionStarted started = 2;
        SessionEnded ended = 3;
        RecordingStarted rec_started = 4;
        RecordingStopped rec_stopped = 5;
        DtmfDetected dtmf = 6;
        IvrFinished ivr_done = 7;
        MediaError error = 8;
        RtpStats stats = 9;
    }
}
```

### 5.4 错误模型

```protobuf
enum MediaErrorCode {
    MEDIA_OK = 0;
    SESSION_NOT_FOUND = 1;
    PORT_EXHAUSTED = 2;
    CODEC_NOT_SUPPORTED = 3;
    PIPELINE_ERROR = 4;
    RECORDING_FAILED = 5;
    DTLS_HANDSHAKE_FAILED = 6;
    ICE_CONNECTIVITY_FAILED = 7;
    INTERNAL_ERROR = 99;
}
```

### 5.5 服务通信矩阵

medserver 与其他服务的通信关系如下：

| 方向 | 调用方 | 被调方 | 协议 | 接口 | 说明 |
|------|--------|--------|------|------|------|
| ← | sipserver / signalserver | medserver | gRPC | MediaService | 创建/修改/删除媒体会话 |
| ← | cti-server | medserver | gRPC | MediaService | 会议混音、录音控制 |
| ← | router-server | medserver | gRPC | MediaService | PlayPrompt、CollectDigits（图引擎节点） |
| → | medserver | sipserver / signalserver | gRPC 事件流 | MediaEvents | 媒体事件推送（DTMF、播放完成等） |
| → | medserver | config-service | gRPC | ConfigService | 启动时加载媒体相关配置 |
| → | medserver | Redis | Pub/Sub | config:{tid}:{entity} | 接收配置增量变更通知 |
| ↔ | medserver | ASR/TTS Provider | WebSocket (WSS) | NLS / 其他 | 实时语音识别与语音合成（详见 §11） |

> **注意**：medserver 不直接对客户端暴露 HTTP API。Dashboard/监控 API 通过 Metrics/Health 端口（9092）提供，仅限内部网络访问。

---

## 6. 会话管理

### 6.1 会话状态机

```
         Create
           │
           ▼
    ┌─────────────┐
    │  Initializing │
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐
    │   Active     │
    └──────┬──────┘
           │
     ┌─────┼──────┐
     │     │      │
     ▼     ▼      ▼
   Hold   Mute  Reinvite
     │     │      │
     └─────┼──────┘
           │
           ▼
    ┌─────────────┐
    │   Active     │
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐
    │  Draining    │
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐
    │   Terminated │
    └─────────────┘
```

### 6.2 会话表

```rust
pub struct SessionTable {
    sessions: DashMap<String, Arc<Session>>,
    call_index: DashMap<String, String>,
    conference_index: DashMap<String, Vec<String>>,
    stats: SessionStats,
}

pub struct Session {
    pub id: String,
    pub call_id: String,
    pub site_id: String,
    pub state: AtomicEnum<SessionState>,
    pub pipeline: Arc<Pipeline>,
    pub transport: Arc<RtpEndpoint>,
    pub created_at: Instant,
    pub last_activity: AtomicInstant,
}
```

### 6.3 超时与清理

```rust
pub struct SessionReaper {
    inactivity_timeout: Duration,    // 默认 180s
    draining_timeout: Duration,      // 默认 5s
    scan_interval: Duration,         // 默认 10s
}
```

### 6.4 容量估算

```
单实例容量：
  - 最大并发会话：25,000
  - SessionTable 内存占用：~25MB
  - 端口池：50,000 端口对 → 位图 ~6KB
  - Pipeline 内存：~100MB
```

---

## 7. 录音功能

### 7.1 录音模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| 单声道混合 | 主被叫音频混合为单声道 | 普通通话录音 |
| 立体声分轨 | 主被叫分别录制到左右声道 | 质检分析 |
| 多轨独立 | 每方独立文件/轨道 | 会议录音、合规审计 |

### 7.2 Pipeline 集成

```
                  ┌──────────────┐
                  │   主媒体流    │
                  │ Decode→Process│
                  │   →Encode→Sink│
                  └──────────────┘
                         │
                    TAP (分流)
                         │
                         ▼
                  ┌──────────────┐
                  │ RecorderNode │
                  │  (异步写盘)   │
                  └──────────────┘
```

### 7.3 写入策略

```
音频帧 → 编码（如 MP3）→ 内存 Ring Buffer → 异步写盘线程 → fsync
```

**关键设计**：
- Ring Buffer：64KB 环形缓冲区
- 异步写盘：独立线程池
- 文件滚动：按时长（1 小时）或大小（64MB）

### 7.4 性能优化

**批量聚合写入**：
- 25,000 会话 ÷ 10 个写线程 = 每线程 2,500 会话
- 每 100ms 聚合写入一次 → IOPS 从 125 万降到 10 ops/s
- 每次写入大小：2 MB（顺序写）

**文件预分配**：
```rust
fn preallocate(&mut self, size: u64) -> Result<()> {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::fallocate(self.file.as_raw_fd(), 0, 0, size as i64)?;
    }
    Ok(())
}
```

### 7.5 多站点录音存储

```
Site US (us-east-1)
  └─ /data/recordings/us-east-1/2026/09/09/{session_id}.mp3

Site EU (eu-west-1)
  └─ /data/recordings/eu-west-1/2026/09/09/{session_id}.mp3
```

录音始终在媒体处理所在站点本地存储，异步同步到中心存储。

---

## 8. 会议功能

### 8.1 会议模型

```rust
pub struct Conference {
    pub id: String,
    pub site_id: String,
    pub members: DashMap<u32, Arc<ConferenceMember>>,
    pub mixer: Arc<AudioMixer>,
    pub config: ConferenceConfig,
    pub state: AtomicEnum<ConferenceState>,
}

pub struct ConferenceMember {
    pub member_id: u32,
    pub session_id: String,
    pub role: MixerRole,
    pub muted: AtomicBool,
    pub deaf: AtomicBool,
    pub energy_level: AtomicF32,
}
```

### 8.2 混音算法

**简单平均混音**（小规模会议）：
```rust
pub struct AverageMixer;

impl AudioMixer for AverageMixer {
    fn mix(&self, inputs: &[&AudioFrame]) -> AudioFrame {
        let divisor = inputs.len() as i16;
        // 简单平均
    }
}
```

**自适应混音**（大规模会议，VAD 加权）：
```rust
pub struct AdaptiveMixer {
    vad_threshold: f32,
    max_active_speakers: usize,
}

impl AudioMixer for AdaptiveMixer {
    fn mix(&self, inputs: &[&AudioFrame]) -> AudioFrame {
        // 1. 计算语音能量
        // 2. 取 top-N 活跃说话者
        // 3. 加权混音
    }
}
```

### 8.3 会议规模与性能

| 规模 | 混音器 | CPU 核心 | 内存 | 延迟 |
|------|--------|---------|------|------|
| 小型 (2-5 人) | AverageMixer | 0.1 | 1 MB | <10ms |
| 中型 (6-20 人) | AdaptiveMixer (max=10) | 0.5 | 5 MB | <20ms |
| 大型 (21-100 人) | AdaptiveMixer (max=5) | 2.0 | 20 MB | <50ms |
| 超大型 (>100 人) | 分层混音 | 5.0+ | 50 MB+ | <100ms |

### 8.4 分层混音延迟分析

**场景**：100 人会议，分 10 组，跨 2 个站点

```
Layer 1（组内混音）：20ms
跨站点传输：100ms (RTT/2)
Jitter Buffer：50ms
Layer 2（站点间混音）：20ms
Layer 3（个性化输出）：20ms
总混音延迟：230ms
```

**同步机制**：
- NTP 时钟同步
- Jitter Buffer 动态调整
- 时钟漂移补偿（时间拉伸）

### 8.5 多站点会议

```
Site US                    Site EU
  │                          │
  ├─ Participant A           ├─ Participant C
  └─ Participant B           └─ Participant D

跨站点混音：
  1. 每个站点本地混音（US: A+B, EU: C+D）
  2. 站点间传输混合后的音频
  3. 每个站点接收远端混合音频，与本地混合
```

---

## 9. IVR 功能

### 9.1 IVR 架构

**轻量内置 + 外部集成**：
- 内置：DTMF 检测、音频播放、简单脚本
- 外部：复杂流程编排通过 ExternalController 对接
- ASR/TTS：通过独立的 `asr_tts` 模块提供（详见 [§11 ASR/TTS 集成](#11-asrtts-集成)），IVR 通过 Pipeline 节点或 gRPC 事件与之交互

### 9.2 DTMF 检测

```rust
pub struct DtmfDetector {
    sample_rate: u32,
    detected_digits: VecDeque<DtmfEvent>,
    energy_threshold: f32,
    min_duration_ms: u32,
}

impl DtmfDetector {
    pub fn process_frame(&mut self, frame: &AudioFrame) -> Vec<DtmfEvent> {
        // Goertzel 算法检测 8 个频率
        let magnitudes = self.goertzel_analysis(frame);
        // 行列交叉检测
        if let Some(digit) = self.decode_digit(&magnitudes) {
            self.handle_digit(digit, frame.duration());
        }
        self.detected_digits.drain(..).collect()
    }
}
```

### 9.3 音频播放

```rust
pub struct AudioPlayer {
    queue: VecDeque<AudioClip>,
    current_position: usize,
    playing: bool,
}

pub struct AudioClip {
    pub id: String,
    pub format: AudioFormat,
    pub data: Vec<u8>,
    pub interruptible: bool,
    pub volume: f32,
}
```

### 9.4 IVR 脚本引擎

```rust
pub struct IvrScript {
    pub entry_point: String,
    pub states: HashMap<String, IvrState>,
}

pub enum IvrState {
    PlayPrompt { prompt_id: String, next: String },
    CollectDigits { max_digits: usize, timeout: Duration },
    MatchDigits { patterns: Vec<(String, String)> },
    Transfer { destination: String },
    Hangup { reason: String },
}
```

### 9.5 外部 IVR 集成

```rust
pub struct ExternalController {
    protocol: ControlProtocol,
    connected: AtomicBool,
    timeout: Duration,
}

enum ControlProtocol {
    Grpc { endpoint: String },
    Webhook { url: String },
    WebSocket { url: String },
}
```

### 9.6 ASR/TTS 集成

IVR 场景中的 ASR（语音识别）和 TTS（语音合成）能力由独立的 `asr_tts` 模块统一提供，详见 [§11 ASR/TTS 集成](#11-asrtts-集成)。

IVR 引擎通过以下方式与 ASR/TTS 交互：
- **Pipeline 节点模式**：ASR/TTS 作为 Pipeline 的 TAP/Source 节点嵌入，音频自动分流
- **gRPC 事件模式**：通过 `MediaEvent` 中的 `AsrResultEvent` / `TtsStatusEvent` 接收识别结果和合成状态
- **gRPC 控制模式**：通过 `StartAsr` / `StartTts` / `PushTtsText` 等 RPC 主动控制 ASR/TTS 会话

---

## 10. 转码功能

### 10.1 转码场景

| 场景 | 说明 | 示例 |
|------|------|------|
| 端到端编解码不匹配 | 主被叫支持不同编解码 | PCMU ↔ Opus |
| 会议混音 | 不同成员使用不同编解码 | 统一解码→混音→各自编码 |
| 录音 | 媒体流编码与录音格式不同 | G729 流 → MP3 录音 |
| WebRTC 适配 | WebRTC 强制要求 Opus | 传统 SIP (PCMU) ↔ WebRTC (Opus) |

### 10.2 转码 Pipeline 节点

```rust
pub struct TranscoderNode {
    input_codec: CodecType,
    output_codec: CodecType,
    decoder: Box<dyn AudioDecoder>,
    encoder: Box<dyn AudioEncoder>,
    resampler: Option<Resampler>,
    frames_transcoded: AtomicU64,
}

impl TranscoderNode {
    pub fn transcode_frame(&mut self, input: &AudioFrame) -> Result<AudioFrame> {
        // 1. 解码为 PCM
        let pcm = self.decoder.decode(&input.data)?;
        
        // 2. 重采样（如果需要）
        let pcm = if let Some(resampler) = &mut self.resampler {
            resampler.process(&pcm)?
        } else {
            pcm
        };
        
        // 3. 编码为目标格式
        let encoded = self.encoder.encode(&pcm)?;
        
        Ok(AudioFrame { /* ... */ })
    }
}
```

### 10.3 编解码支持矩阵

```rust
pub enum CodecType {
    Pcmu,      // G.711 μ-law, 8kHz, 64kbps
    Pcma,      // G.711 A-law, 8kHz, 64kbps
    G722,      // 16kHz, 64kbps (宽带)
    G729,      // 8kHz, 8kbps (窄带压缩)
    Opus,      // 8-48kHz, 6-510kbps (全频段)
}
```

所有 25 种组合都支持（通过 PCM 中间格式）。

### 10.4 采样率转换

```rust
pub struct Resampler {
    input_rate: u32,
    output_rate: u32,
    algorithm: ResampleAlgorithm,
}

enum ResampleAlgorithm {
    Linear,      // 低 CPU，质量一般
    Polyphase,   // 中等 CPU，质量好
    Sinc,        // 高 CPU，最佳质量
}
```

### 10.5 转码优化

**避免不必要的转码**：
```rust
pub fn needs_transcode(&self, from: CodecType, to: CodecType) -> bool {
    from != to
}
```

**PCMU ↔ PCMA 直接转换**（无需解码/编码）：
```rust
const ULAW_TO_ALAW_TABLE: [u8; 256] = [ /* 预计算表 */ ];

pub fn pcmu_to_pcma_direct(input: &[u8]) -> Vec<u8> {
    input.iter()
        .map(|&sample| ULAW_TO_ALAW_TABLE[sample as usize])
        .collect()
}
```

### 10.6 站点内优先原则

**核心约束**：
- 每个站点独立部署完整转码能力
- 99% 流量在站点内处理
- 跨站点场景（<1%）：优先在源站点完成转码

### 10.7 转码性能

```
单核转码能力（估算）：
  - PCMU ↔ PCMA: >100,000 流/核
  - G729 ↔ PCMU: ~5,000 流/核
  - Opus ↔ PCMU: ~3,000 流/核
  - G729 ↔ Opus: ~2,000 流/核

25,000 并发会话（全部需要转码）：
  - PCMU↔PCMA: 1 核
  - G729↔Opus: 12.5 核
  - 建议配置: 16 核
```

---

## 11. ASR/TTS 集成

### 11.1 总体设计

ASR/TTS 模块为 medserver 提供语音识别（ASR）和语音合成（TTS）能力，采用**多 Provider 抽象 + 流量路由**架构，支持同时对接多套语音服务并通过流程控制选择具体 Provider。

**第一阶段目标**：对接阿里云智能语音交互（NLS）的实时语音识别和流式语音合成。

**架构总览**：

```
                        ┌─────────────────────────────────┐
                        │         ASR/TTS Router          │
                        │   (流量控制 + Provider 选择)      │
                        └────────────┬────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │ Aliyun ASR/  │ │  Provider B  │ │  Provider C  │
            │ TTS (Phase1) │ │  (Phase2+)   │ │  (Phase2+)   │
            └──────┬───────┘ └──────────────┘ └──────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
   ┌─────────────┐  ┌─────────────┐
   │  ASR (WSS)  │  │  TTS (WSS)  │
   │ Speech-     │  │ Flowing-    │
   │ Transcriber │  │ Speech-     │
   │             │  │ Synthesizer │
   └─────────────┘  └─────────────┘
          │                 │
          ▼                 ▼
   Pipeline ASR Node   Pipeline TTS Node
   (音频流 → 文本事件)   (文本 → 音频流)
```

### 11.2 Provider 抽象层

#### 11.2.1 ASR Provider Trait

```rust
#[async_trait]
pub trait AsrProvider: Send + Sync {
    /// Provider 唯一标识（如 "aliyun", "tencent", "baidu"）
    fn provider_id(&self) -> &str;

    /// 创建 ASR 会话
    async fn create_session(
        &self,
        config: AsrSessionConfig,
    ) -> Result<Box<dyn AsrSession>>;

    /// Provider 健康检查
    async fn health_check(&self) -> Result<ProviderHealth>;

    /// 获取 Provider 当前负载（用于路由决策）
    fn current_load(&self) -> ProviderLoad;
}

#[async_trait]
pub trait AsrSession: Send + Sync {
    /// 启动识别会话
    async fn start(&mut self) -> Result<()>;

    /// 发送音频帧（PCM 16-bit 单声道）
    async fn send_audio(&mut self, frame: &[u8]) -> Result<()>;

    /// 停止识别会话
    async fn stop(&mut self) -> Result<()>;

    /// 接收识别结果事件流
    fn event_stream(&self) -> mpsc::Receiver<AsrEvent>;

    /// 会话是否存活
    fn is_alive(&self) -> bool;
}

pub struct AsrSessionConfig {
    /// 音频格式
    pub format: AudioFormat,
    /// 采样率（8000 或 16000）
    pub sample_rate: u32,
    /// 是否返回中间结果
    pub enable_intermediate_result: bool,
    /// 自动标点
    pub enable_punctuation: bool,
    /// ITN（中文数字→阿拉伯数字）
    pub enable_itn: bool,
    /// 断句静音阈值 (ms)
    pub max_sentence_silence_ms: u32,
    /// 是否启用语义断句
    pub enable_semantic_sentence: bool,
    /// 是否过滤语气词
    pub enable_disfluency: bool,
    /// 定制热词 ID
    pub vocabulary_id: Option<String>,
    /// 自定义模型 ID
    pub customization_id: Option<String>,
    /// Provider 特有参数
    pub extra: HashMap<String, String>,
}
```

#### 11.2.2 TTS Provider Trait

```rust
#[async_trait]
pub trait TtsProvider: Send + Sync {
    /// Provider 唯一标识
    fn provider_id(&self) -> &str;

    /// 创建 TTS 会话
    async fn create_session(
        &self,
        config: TtsSessionConfig,
    ) -> Result<Box<dyn TtsSession>>;

    /// Provider 健康检查
    async fn health_check(&self) -> Result<ProviderHealth>;

    /// 获取 Provider 当前负载
    fn current_load(&self) -> ProviderLoad;
}

#[async_trait]
pub trait TtsSession: Send + Sync {
    /// 启动合成会话
    async fn start(&mut self) -> Result<()>;

    /// 发送待合成文本（支持流式分段发送）
    async fn send_text(&mut self, text: &str) -> Result<()>;

    /// 通知文本发送完毕（触发缓存刷新）
    async fn finish_text(&mut self) -> Result<()>;

    /// 停止合成
    async fn stop(&mut self) -> Result<()>;

    /// 接收音频数据流
    fn audio_stream(&self) -> mpsc::Receiver<TtsAudioChunk>;

    /// 接收合成事件（句子边界、时间戳等）
    fn event_stream(&self) -> mpsc::Receiver<TtsEvent>;

    /// 会话是否存活
    fn is_alive(&self) -> bool;
}

pub struct TtsSessionConfig {
    /// 输出音频格式
    pub format: AudioFormat,
    /// 采样率
    pub sample_rate: u32,
    /// 发音人
    pub voice: String,
    /// 音量 (0-100)
    pub volume: u8,
    /// 语速 (-500 ~ 500)
    pub speech_rate: i16,
    /// 音调 (-500 ~ 500)
    pub pitch_rate: i16,
    /// 启用字级时间戳
    pub enable_subtitle: bool,
    /// 启用音素级时间戳
    pub enable_phoneme_timestamp: bool,
    /// Provider 特有参数
    pub extra: HashMap<String, String>,
}
```

#### 11.2.3 事件模型

```rust
pub enum AsrEvent {
    /// 识别会话已启动
    Started { task_id: String },
    /// 新句子开始
    SentenceBegin { index: u32, time_ms: u64 },
    /// 中间识别结果（实时变化）
    IntermediateResult {
        index: u32,
        time_ms: u64,
        text: String,
        words: Vec<WordInfo>,
    },
    /// 句子结束（最终结果）
    SentenceEnd {
        index: u32,
        time_ms: u64,
        begin_time_ms: u64,
        text: String,
        confidence: f32,
        words: Vec<WordInfo>,
    },
    /// 识别完成
    Completed { task_id: String },
    /// 识别失败
    Failed { error_code: String, message: String },
}

pub struct WordInfo {
    pub text: String,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
}

pub enum TtsEvent {
    /// 合成已启动
    Started { task_id: String },
    /// 句子开始合成
    SentenceBegin { index: u32 },
    /// 句子合成完成（含时间戳）
    SentenceEnd {
        index: u32,
        subtitles: Vec<SubtitleInfo>,
    },
    /// 合成完成
    Completed { task_id: String },
    /// 合成失败
    Failed { error_code: String, message: String },
}

pub struct SubtitleInfo {
    pub text: String,
    pub begin_time_ms: u64,
    pub end_time_ms: u64,
    pub phonemes: Vec<PhonemeInfo>,
}

pub struct PhonemeInfo {
    pub text: String,
    pub begin_time_ms: u64,
    pub end_time_ms: u64,
    pub tone: String,
}

pub struct TtsAudioChunk {
    pub data: Vec<u8>,
    pub format: AudioFormat,
    pub sample_rate: u32,
    pub sequence: u64,
}
```

### 11.3 阿里云 NLS 实现

#### 11.3.1 连接与认证

阿里云 NLS 使用临时 Token 鉴权，通过 WebSocket 传输。

```rust
pub struct AliyunNlsClient {
    appkey: String,
    token_manager: Arc<AliyunTokenManager>,
    endpoint: NlsEndpoint,
    ws_pool: WebSocketPool,
}

pub struct NlsEndpoint {
    /// 公网地址
    pub public_url: String,
    /// 内网地址（VPC 部署时使用）
    pub internal_url: Option<String>,
}

impl AliyunNlsClient {
    /// 建立 WebSocket 连接
    async fn connect(&self) -> Result<TungsteniteWs> {
        let token = self.token_manager.get_token().await?;
        let url = if let Some(internal) = &self.endpoint.internal_url {
            format!("{}?token={}", internal, token)
        } else {
            format!("{}?token={}", self.endpoint.public_url, token)
        };
        // WebSocket 连接建立...
    }
}
```

#### 11.3.2 Token 管理

阿里云 Token 有效期 24 小时，需自动刷新。

```rust
pub struct AliyunTokenManager {
    access_key_id: String,
    access_key_secret: String,
    region: String,
    current_token: RwLock<Option<CachedToken>>,
    refresh_tx: mpsc::Sender<()>,
}

struct CachedToken {
    token: String,
    expire_at: Instant,
}

impl AliyunTokenManager {
    /// 获取有效 Token（自动刷新）
    pub async fn get_token(&self) -> Result<String> {
        let cached = self.current_token.read().await;
        if let Some(ref t) = *cached {
            if t.expire_at > Instant::now() + Duration::from_secs(300) {
                return Ok(t.token.clone());
            }
        }
        drop(cached);
        self.refresh_token().await
    }

    /// 调用阿里云 CreateToken API 刷新
    async fn refresh_token(&self) -> Result<String> {
        // 调用 POP API: CreateToken
        // 更新 current_token
        // 返回新 token
    }
}
```

#### 11.3.3 ASR 实现（SpeechTranscriber）

```rust
pub struct AliyunAsrSession {
    ws: TungsteniteWs,
    task_id: String,
    appkey: String,
    event_tx: mpsc::Sender<AsrEvent>,
    state: AsrSessionState,
}

impl AliyunAsrSession {
    /// 发送 StartTranscription 指令
    async fn start(&mut self) -> Result<()> {
        let msg = serde_json::json!({
            "header": {
                "message_id": generate_message_id(),
                "task_id": self.task_id,
                "namespace": "SpeechTranscriber",
                "name": "StartTranscription",
                "appkey": self.appkey,
            },
            "payload": {
                "format": "pcm",
                "sample_rate": self.config.sample_rate,
                "enable_intermediate_result": self.config.enable_intermediate_result,
                "enable_punctuation_prediction": self.config.enable_punctuation,
                "enable_inverse_text_normalization": self.config.enable_itn,
                "max_sentence_silence": self.config.max_sentence_silence_ms,
                "enable_semantic_sentence_detection": self.config.enable_semantic_sentence,
                "disfluency": self.config.enable_disfluency,
            }
        });
        self.ws.send_text(msg.to_string()).await?;
        // 等待 TranscriptionStarted 事件
        Ok(())
    }

    /// 发送音频二进制帧
    async fn send_audio(&mut self, frame: &[u8]) -> Result<()> {
        self.ws.send_binary(frame).await?;
        Ok(())
    }

    /// 接收并解析服务端事件
    async fn recv_loop(&self) {
        loop {
            match self.ws.recv().await {
                Ok(WsMessage::Text(text)) => {
                    let event: NlsResponse = serde_json::from_str(&text)?;
                    let asr_event = self.translate_event(event)?;
                    self.event_tx.send(asr_event).await?;
                }
                Ok(WsMessage::Binary(_)) => { /* ASR 不返回音频 */ }
                Err(e) => {
                    self.event_tx.send(AsrEvent::Failed {
                        error_code: "WS_ERROR".into(),
                        message: e.to_string(),
                    }).await?;
                    break;
                }
            }
        }
    }
}
```

**音频格式适配**：

阿里云 ASR 要求 PCM 16-bit 单声道，采样率 8000 或 16000。medserver Pipeline 中的音频帧需经过格式转换：

```
RTP 音频 → Decoder → Resampler(→16kHz) → Mono(→单声道) → PCM16LE → Aliyun ASR WSS
```

#### 11.3.4 TTS 实现（FlowingSpeechSynthesizer）

```rust
pub struct AliyunTtsSession {
    ws: TungsteniteWs,
    task_id: String,
    appkey: String,
    audio_tx: mpsc::Sender<TtsAudioChunk>,
    event_tx: mpsc::Sender<TtsEvent>,
    audio_seq: AtomicU64,
    state: TtsSessionState,
}

impl AliyunTtsSession {
    /// 发送 StartSynthesis 指令
    async fn start(&mut self) -> Result<()> {
        let msg = serde_json::json!({
            "header": {
                "message_id": generate_message_id(),
                "task_id": self.task_id,
                "namespace": "FlowingSpeechSynthesizer",
                "name": "StartSynthesis",
                "appkey": self.appkey,
            },
            "payload": {
                "voice": self.config.voice,
                "format": format_to_aliyun(&self.config.format),
                "sample_rate": self.config.sample_rate,
                "volume": self.config.volume,
                "speech_rate": self.config.speech_rate,
                "pitch_rate": self.config.pitch_rate,
                "enable_subtitle": self.config.enable_subtitle,
                "enable_phoneme_timestamp": self.config.enable_phoneme_timestamp,
            }
        });
        self.ws.send_text(msg.to_string()).await?;
        Ok(())
    }

    /// 流式发送文本
    async fn send_text(&mut self, text: &str) -> Result<()> {
        let msg = serde_json::json!({
            "header": {
                "message_id": generate_message_id(),
                "task_id": self.task_id,
                "namespace": "FlowingSpeechSynthesizer",
                "name": "RunSynthesis",
                "appkey": self.appkey,
            },
            "payload": {
                "text": text,
            }
        });
        self.ws.send_text(msg.to_string()).await?;
        Ok(())
    }

    /// 通知文本发送完毕
    async fn finish_text(&mut self) -> Result<()> {
        let msg = serde_json::json!({
            "header": {
                "message_id": generate_message_id(),
                "task_id": self.task_id,
                "namespace": "FlowingSpeechSynthesizer",
                "name": "StopSynthesis",
                "appkey": self.appkey,
            },
            "payload": {}
        });
        self.ws.send_text(msg.to_string()).await?;
        Ok(())
    }

    /// 接收循环：处理文本事件和音频二进制帧
    async fn recv_loop(&self) {
        loop {
            match self.ws.recv().await {
                Ok(WsMessage::Text(text)) => {
                    let event: NlsResponse = serde_json::from_str(&text)?;
                    let tts_event = self.translate_event(event)?;
                    self.event_tx.send(tts_event).await?;
                }
                Ok(WsMessage::Binary(audio_data)) => {
                    let seq = self.audio_seq.fetch_add(1, Ordering::Relaxed);
                    self.audio_tx.send(TtsAudioChunk {
                        data: audio_data,
                        format: self.config.format.clone(),
                        sample_rate: self.config.sample_rate,
                        sequence: seq,
                    }).await?;
                }
                Err(e) => {
                    self.event_tx.send(TtsEvent::Failed {
                        error_code: "WS_ERROR".into(),
                        message: e.to_string(),
                    }).await?;
                    break;
                }
            }
        }
    }
}
```

**TTS 音频回注 Pipeline**：

```
Aliyun TTS WSS → Binary Frames → PCM16@16kHz → Resampler(→8kHz) → Encoder(→PCMU) → RTP Sink
```

### 11.4 Provider 注册与路由

#### 11.4.1 Provider Registry

```rust
pub struct ProviderRegistry {
    asr_providers: DashMap<String, Arc<dyn AsrProvider>>,
    tts_providers: DashMap<String, Arc<dyn TtsProvider>>,
}

impl ProviderRegistry {
    /// 注册 ASR Provider
    pub fn register_asr(&self, id: String, provider: Arc<dyn AsrProvider>);

    /// 注册 TTS Provider
    pub fn register_tts(&self, id: String, provider: Arc<dyn TtsProvider>);

    /// 获取指定 Provider
    pub fn get_asr(&self, id: &str) -> Option<Arc<dyn AsrProvider>>;
    pub fn get_tts(&self, id: &str) -> Option<Arc<dyn TtsProvider>>;

    /// 列出所有可用 Provider
    pub fn list_asr(&self) -> Vec<String>;
    pub fn list_tts(&self) -> Vec<String>;
}
```

#### 11.4.2 流量路由策略

路由层根据配置规则选择具体 Provider，支持多种策略：

```rust
pub struct AsrTtsRouter {
    registry: Arc<ProviderRegistry>,
    rules: RwLock<Vec<RouteRule>>,
    default_asr: String,
    default_tts: String,
}

pub enum RouteStrategy {
    /// 固定指定 Provider
    Static { provider_id: String },
    /// 加权轮询
    WeightedRoundRobin { weights: Vec<(String, u32)> },
    /// 按 site_id 路由（就近接入）
    SiteAffinity { mapping: HashMap<String, String> },
    /// 按业务类型路由（如 VIP 客户用高质量 Provider）
    BusinessTier { tier_mapping: HashMap<String, String> },
    /// 故障自动切换
    Failover { primary: String, fallback: String },
}

pub struct RouteRule {
    /// 规则匹配条件
    pub condition: RouteCondition,
    /// 路由策略
    pub strategy: RouteStrategy,
    /// 规则优先级（数字越小越优先）
    pub priority: u32,
}

pub struct RouteCondition {
    /// 匹配租户 ID（空表示全部）
    pub tenant_ids: Vec<String>,
    /// 匹配站点 ID
    pub site_ids: Vec<String>,
    /// 匹配业务类型（如 "ivr", "realtime_asr", "recording_asr"）
    pub business_types: Vec<String>,
}

impl AsrTtsRouter {
    /// 根据上下文选择 ASR Provider
    pub async fn select_asr(&self, ctx: &RouteContext) -> Result<Arc<dyn AsrProvider>> {
        let rules = self.rules.read().await;
        for rule in rules.iter() {
            if rule.condition.matches(ctx) {
                return self.resolve_asr(&rule.strategy).await;
            }
        }
        // 使用默认 Provider
        self.registry.get_asr(&self.default_asr)
            .ok_or_else(|| MediaError::ExternalDependency {
                service: "asr".into(),
                reason: "No ASR provider available".into(),
            })
    }

    /// 根据上下文选择 TTS Provider
    pub async fn select_tts(&self, ctx: &RouteContext) -> Result<Arc<dyn TtsProvider>>;

    /// 故障切换：当主 Provider 不可用时自动降级
    async fn resolve_asr_with_failover(
        &self,
        primary: &str,
        fallback: &str,
    ) -> Result<Arc<dyn AsrProvider>> {
        if let Some(provider) = self.registry.get_asr(primary) {
            if provider.health_check().await.is_ok() {
                return Ok(provider);
            }
            tracing::warn!(primary, "ASR provider unhealthy, failing over");
        }
        self.registry.get_asr(fallback)
            .ok_or_else(|| MediaError::ExternalDependency {
                service: "asr".into(),
                reason: format!("Both primary ({}) and fallback ({}) unavailable", primary, fallback),
            })
    }
}

pub struct RouteContext {
    pub tenant_id: String,
    pub site_id: String,
    pub business_type: String,
    pub call_direction: CallDirection,
    pub extra: HashMap<String, String>,
}
```

#### 11.4.3 路由配置示例

```toml
[media.asr_tts]
default_asr = "aliyun"
default_tts = "aliyun"

# 路由规则（按优先级排序）
[[media.asr_tts.rules]]
priority = 10
condition = { tenant_ids = ["vip-tenant-001"] }
strategy = { type = "static", provider_id = "aliyun-premium" }

[[media.asr_tts.rules]]
priority = 20
condition = { site_ids = ["us-east-1"], business_types = ["realtime_asr"] }
strategy = { type = "weighted_round_robin", weights = [
    { provider_id = "aliyun", weight = 70 },
    { provider_id = "aws", weight = 30 },
] }

[[media.asr_tts.rules]]
priority = 100
condition = {}  # 兜底规则
strategy = { type = "failover", primary = "aliyun", fallback = "local" }
```

### 11.5 连接池管理

WebSocket 连接是有状态的长连接，需要连接池管理以提高复用率和控制并发。

```rust
pub struct WebSocketPool {
    /// 每个 Provider 的连接池
    pools: DashMap<String, ProviderPool>,
    config: PoolConfig,
}

pub struct ProviderPool {
    provider_id: String,
    idle_connections: Mutex<Vec<PooledWs>>,
    active_count: AtomicUsize,
    max_connections: usize,
    max_idle: usize,
    idle_timeout: Duration,
    connect_timeout: Duration,
}

pub struct PoolConfig {
    /// 每个 Provider 最大并发连接数
    pub max_connections_per_provider: usize,
    /// 每个 Provider 最大空闲连接数
    pub max_idle_per_provider: usize,
    /// 空闲连接超时
    pub idle_timeout: Duration,
    /// 连接建立超时
    pub connect_timeout: Duration,
    /// 健康检查间隔
    pub health_check_interval: Duration,
}

impl WebSocketPool {
    /// 获取或创建连接
    pub async fn acquire(&self, provider_id: &str) -> Result<PooledWs> {
        let pool = self.pools.get(provider_id)
            .ok_or(MediaError::ConfigError("Unknown provider".into()))?;

        // 优先复用空闲连接
        if let Some(ws) = pool.try_reuse_idle() {
            return Ok(ws);
        }

        // 检查是否达到上限
        if pool.active_count.load(Ordering::Relaxed) >= pool.max_connections {
            return Err(MediaError::ResourceExhausted {
                resource: format!("WS pool for {}", provider_id),
            });
        }

        // 创建新连接
        pool.create_new().await
    }

    /// 归还连接
    pub fn release(&self, provider_id: &str, ws: PooledWs);

    /// 后台清理空闲连接
    async fn idle_reaper(&self) {
        loop {
            tokio::time::sleep(self.config.idle_timeout / 2).await;
            for mut entry in self.pools.iter_mut() {
                entry.value_mut().evict_idle();
            }
        }
    }
}
```

### 11.6 Pipeline 集成

ASR/TTS 作为 Pipeline 节点嵌入媒体处理链。

#### 11.6.1 ASR Pipeline 节点

```rust
pub struct AsrPipelineNode {
    id: String,
    session: Option<Box<dyn AsrSession>>,
    router: Arc<AsrTtsRouter>,
    route_ctx: RouteContext,
    /// 音频格式转换器
    format_adapter: AsrFormatAdapter,
    /// 事件回调
    event_callback: Option<mpsc::Sender<AsrEvent>>,
    state: PipelineNodeState,
}

impl PipelineNode for AsrPipelineNode {
    fn id(&self) -> &str { &self.id }

    fn process_frame(&mut self, input: AudioFrame) -> Result<Vec<AudioFrame>> {
        // ASR 节点是 TAP 节点：音频帧透传给下游，同时分流给 ASR
        let pcm = self.format_adapter.adapt(&input)?;
        if let Some(ref mut session) = self.session {
            // 异步发送，不阻塞主媒体路径
            let _ = session.send_audio(&pcm).now_or_never();
        }
        // 透传原始帧，不影响主 Pipeline
        Ok(vec![input])
    }

    fn node_type(&self) -> NodeType { NodeType::Processor }
    fn hot_pluggable(&self) -> bool { true }
}
```

#### 11.6.2 TTS Pipeline 节点

```rust
pub struct TtsPipelineNode {
    id: String,
    session: Option<Box<dyn TtsSession>>,
    router: Arc<AsrTtsRouter>,
    route_ctx: RouteContext,
    /// 音频格式转换器（TTS 输出 → Pipeline 格式）
    format_adapter: TtsFormatAdapter,
    /// 待合成的文本队列
    text_queue: VecDeque<String>,
    state: PipelineNodeState,
}

impl PipelineNode for TtsPipelineNode {
    fn id(&self) -> &str { &self.id }

    fn process_frame(&mut self, input: AudioFrame) -> Result<Vec<AudioFrame>> {
        // TTS 节点是 Source 节点：生成音频帧注入 Pipeline
        // 从 TTS 音频流中取出数据，转换为 Pipeline 格式
        if let Some(chunk) = self.try_recv_audio() {
            let frames = self.format_adapter.to_pipeline_frames(chunk)?;
            Ok(frames)
        } else {
            Ok(vec![])
        }
    }

    fn node_type(&self) -> NodeType { NodeType::Source }
    fn hot_pluggable(&self) -> bool { true }
}
```

#### 11.6.3 Pipeline 数据流示例

**IVR 场景（TTS 播报 + ASR 识别）**：

```
                    ┌─────────────────────────────────────────┐
                    │              Pipeline                    │
                    │                                         │
RTP Source ──┬──→ Decoder ──→ Encoder ──→ RTP Sink           │
             │       │                        ↑               │
             │    [TAP]                       │               │
             │       │                        │               │
             │       ▼                        │               │
             │  ASR Node ──→ (WSS) ──→ 识别文本事件 ──→ IVR  │
             │                              引擎             │
             │                               │               │
             │                               ▼               │
             │  TTS Node ←── (WSS) ←── 合成文本指令           │
             │       │                                         │
             └───────┘                                         │
              注入音频 ─────────────────────────────────────────┘
```

### 11.7 gRPC API 扩展

在 `MediaService` 中增加 ASR/TTS 控制接口：

```protobuf
service MediaService {
    // ... 已有接口 ...

    // ASR 控制
    rpc StartAsr(StartAsrRequest) returns (StartAsrResponse);
    rpc StopAsr(StopAsrRequest) returns (StopAsrResponse);

    // TTS 控制
    rpc StartTts(StartTtsRequest) returns (StartTtsResponse);
    rpc PushTtsText(PushTtsTextRequest) returns (PushTtsTextResponse);
    rpc StopTts(StopTtsRequest) returns (StopTtsResponse);

    // Provider 管理
    rpc ListAsrProviders(ListProvidersRequest) returns (ListProvidersResponse);
    rpc ListTtsProviders(ListProvidersRequest) returns (ListProvidersResponse);
}

message StartAsrRequest {
    string session_id = 1;
    AsrConfig config = 2;
    // 可选：指定 Provider（不指定则走路由规则）
    string provider_id = 3;
    // 业务类型（用于路由匹配）
    string business_type = 4;
}

message AsrConfig {
    bool enable_intermediate_result = 1;
    bool enable_punctuation = 2;
    bool enable_itn = 3;
    uint32 max_sentence_silence_ms = 4;
    bool enable_semantic_sentence = 5;
    bool enable_disfluency = 6;
    string vocabulary_id = 7;
}

message StartAsrResponse {
    string asr_session_id = 1;
    string provider_id = 2;
}

message StartTtsRequest {
    string session_id = 1;
    TtsConfig config = 2;
    string provider_id = 3;
    string business_type = 4;
}

message TtsConfig {
    string voice = 1;
    uint32 volume = 2;
    int32 speech_rate = 3;
    int32 pitch_rate = 4;
    bool enable_subtitle = 5;
}

message PushTtsTextRequest {
    string session_id = 1;
    string asr_session_id = 2;
    string text = 3;
    bool is_final = 4;  // 是否为最后一段文本
}

message StopAsrRequest {
    string session_id = 1;
    string asr_session_id = 2;
}

message StopTtsRequest {
    string session_id = 1;
    string asr_session_id = 2;
}
```

**事件扩展**：在 `MediaEvent` 中增加 ASR/TTS 事件：

```protobuf
message MediaEvent {
    string session_id = 1;
    oneof event {
        // ... 已有事件 ...
        AsrResultEvent asr_result = 10;
        TtsStatusEvent tts_status = 11;
    }
}

message AsrResultEvent {
    string asr_session_id = 1;
    string provider_id = 2;
    oneof result {
        AsrSentenceBegin sentence_begin = 3;
        AsrIntermediateResult intermediate = 4;
        AsrSentenceEnd sentence_end = 5;
    }
}

message TtsStatusEvent {
    string tts_session_id = 1;
    string provider_id = 2;
    oneof status {
        TtsStarted started = 3;
        TtsSentenceEnd sentence_done = 4;
        TtsCompleted completed = 5;
        TtsFailed failed = 6;
    }
}
```

### 11.8 错误处理与容错

#### 11.8.1 错误分类

| 错误场景 | 严重级别 | 处理策略 |
|---------|---------|---------|
| WebSocket 连接断开 | Recoverable | 自动重连（指数退避，最多 3 次） |
| Token 过期 | Recoverable | 自动刷新 Token 并重连 |
| Provider 不可达 | Degraded | 路由层自动 Failover 到备用 Provider |
| Provider 返回错误码 | Recoverable | 解析错误码，记录日志，通知上层 |
| 音频格式不匹配 | Degraded | 尝试重采样/转码，失败则终止 ASR/TTS 会话 |
| 连接池耗尽 | Degraded | 拒绝新 ASR/TTS 请求，主媒体流不受影响 |
| 所有 Provider 不可用 | Fatal(ASR/TTS) | 终止 ASR/TTS 功能，主媒体流不受影响 |

#### 11.8.2 重连策略

```rust
pub struct ReconnectPolicy {
    max_retries: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
    multiplier: f64,
}

impl ReconnectPolicy {
    pub fn default_aliyun() -> Self {
        Self {
            max_retries: 3,
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(5),
            multiplier: 2.0,
        }
    }

    pub fn backoff_duration(&self, attempt: u32) -> Duration {
        let d = self.initial_backoff * (self.multiplier.powi(attempt as i32) as u32);
        d.min(self.max_backoff)
    }
}
```

#### 11.8.3 核心原则

**ASR/TTS 故障不影响主媒体流**：
- ASR/TTS 作为 Pipeline 的 TAP/Source 节点，独立于主音频路径
- Provider 故障时，主通话音频正常传输，仅 ASR/TTS 功能降级
- 上层（IVR 引擎、CTI）通过事件感知 ASR/TTS 状态变化，决定后续行为

### 11.9 监控指标

```rust
pub struct AsrTtsMetrics {
    /// 活跃 ASR 会话数（按 Provider 分组）
    pub active_asr_sessions: IntGaugeVec,
    /// 活跃 TTS 会话数（按 Provider 分组）
    pub active_tts_sessions: IntGaugeVec,

    /// ASR 识别延迟（从发送音频到收到 SentenceEnd）
    pub asr_latency_seconds: HistogramVec,
    /// TTS 合成延迟（从发送文本到收到首个音频帧）
    pub tts_first_audio_latency_seconds: HistogramVec,
    /// TTS 合成总延迟
    pub tts_total_latency_seconds: HistogramVec,

    /// Provider 连接池使用率
    pub ws_pool_utilization: GaugeVec,
    /// Provider 错误计数（按错误类型分组）
    pub provider_errors_total: IntCounterVec,
    /// Provider 重连次数
    pub provider_reconnects_total: IntCounterVec,

    /// ASR 识别句子数
    pub asr_sentences_total: IntCounterVec,
    /// TTS 合成字符数
    pub tts_characters_total: IntCounterVec,

    /// 路由切换次数（Failover 触发）
    pub route_failover_total: IntCounterVec,
}
```

### 11.10 配置示例

```toml
[media.asr_tts]
enabled = true
default_asr = "aliyun"
default_tts = "aliyun"

# 阿里云 NLS 配置
[media.asr_tts.providers.aliyun]
type = "aliyun-nls"
appkey = "${ALIYUN_NLS_APPKEY}"
access_key_id = "${ALIYUN_ACCESS_KEY_ID}"
access_key_secret = "${ALIYUN_ACCESS_KEY_SECRET}"
region = "cn-shanghai"

# ASR 端点
[media.asr_tts.providers.aliyun.asr]
public_url = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"
internal_url = "ws://nls-gateway-cn-shanghai-internal.aliyuncs.com:80/ws/v1"
default_sample_rate = 16000
default_format = "pcm"

# TTS 端点
[media.asr_tts.providers.aliyun.tts]
public_url = "wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1"
internal_url = "ws://nls-gateway-cn-beijing-internal.aliyuncs.com:80/ws/v1"
default_voice = "xiaoyun"
default_sample_rate = 16000
default_format = "pcm"

# 连接池配置
[media.asr_tts.pool]
max_connections_per_provider = 500
max_idle_per_provider = 50
idle_timeout = "5m"
connect_timeout = "3s"
health_check_interval = "30s"

# Token 刷新
[media.asr_tts.token]
refresh_before_expiry = "5m"
cache_backend = "memory"  # 或 "redis"（多实例共享）

# 路由规则
[[media.asr_tts.rules]]
priority = 10
condition = { business_types = ["recording_asr"] }
strategy = { type = "static", provider_id = "aliyun" }

[[media.asr_tts.rules]]
priority = 100
condition = {}
strategy = { type = "failover", primary = "aliyun", fallback = "aliyun-backup" }
```

---

## 12. 错误处理

### 12.1 错误分类

```rust
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("资源耗尽: {resource}")]
    ResourceExhausted { resource: String },
    
    #[error("编解码错误: {0}")]
    CodecError(String),
    
    #[error("传输错误: {0}")]
    TransportError(String),
    
    #[error("Pipeline 错误: {0}")]
    PipelineError(String),
    
    #[error("会话错误: {0}")]
    SessionError(String),
    
    #[error("外部依赖错误: {service} - {reason}")]
    ExternalDependency { service: String, reason: String },
    
    #[error("配置错误: {0}")]
    ConfigError(String),
    
    #[error("内部错误: {0}")]
    Internal(String),
}

pub enum ErrorSeverity {
    Recoverable,
    Degraded,
    Fatal,
}
```

### 12.2 错误传播策略

```
错误处理原则：
  1. 媒体路径（RTP 收发）：不 panic，不阻塞，降级处理
  2. 控制路径（gRPC API）：返回明确错误码，携带上下文
  3. 后台任务（录音、清理）：记录日志，自动重试或告警
```

### 12.3 常见错误场景与处理

| 错误场景 | 严重级别 | 处理策略 |
|---------|---------|---------|
| RTP 包丢失 | Recoverable | 继续运行，依赖 jitter buffer |
| 端口分配失败 | Degraded | 返回 `PORT_EXHAUSTED`，拒绝新会话 |
| 编解码失败 | Degraded | 尝试降级到 PCM，或终止该会话 |
| 录音磁盘满 | Degraded | 停止录音，主媒体流不受影响 |
| DTLS 握手失败 | Degraded | 终止该会话 |
| Pipeline 节点 panic | Fatal | 捕获 panic，终止会话，释放资源 |
| 内存不足 (OOM) | Fatal | 终止最旧的会话，释放内存 |

### 12.4 优雅降级

```rust
pub struct GracefulDegradation {
    load: SystemLoad,
    strategy: DegradationStrategy,
}

enum DegradationStrategy {
    Normal,
    RejectNewSessions,
    SimplifyMixer,
    EssentialOnly,
    Emergency,
}

impl GracefulDegradation {
    pub fn evaluate(&mut self) -> DegradationStrategy {
        if self.load.cpu_usage > 0.95 || self.load.memory_usage > 0.95 {
            DegradationStrategy::Emergency
        } else if self.load.disk_usage > 0.95 {
            DegradationStrategy::EssentialOnly
        } else if self.load.cpu_usage > 0.85 {
            DegradationStrategy::SimplifyMixer
        } else if self.load.port_utilization > 0.90 {
            DegradationStrategy::RejectNewSessions
        } else {
            DegradationStrategy::Normal
        }
    }
}
```

### 12.5 错误恢复

```rust
pub struct ErrorRecovery {
    recovery_tasks: Vec<RecoveryTask>,
}

impl ErrorRecovery {
    pub fn default_tasks() -> Vec<RecoveryTask> {
        vec![
            RecoveryTask {
                name: "cleanup_zombie_sessions".to_string(),
                interval: Duration::from_secs(10),
                action: Box::new(cleanup_zombie_sessions),
            },
            RecoveryTask {
                name: "reclaim_orphaned_ports".to_string(),
                interval: Duration::from_secs(60),
                action: Box::new(reclaim_orphaned_ports),
            },
            RecoveryTask {
                name: "flush_recording_buffers".to_string(),
                interval: Duration::from_secs(5),
                action: Box::new(flush_recording_buffers),
            },
        ]
    }
}
```

### 12.6 统一错误响应格式

medserver 通过 gRPC 返回错误时，status message 遵循统一错误格式（详见 `config-and-gateway-design.md` 14.1 节）：

```json
{
  "error": {
    "code": "PORT_EXHAUSTED",
    "message": "RTP 端口池已耗尽",
    "details": [
      {
        "field": "port_pool",
        "message": "可用端口对: 0, 已分配: 25000"
      }
    ],
    "request_id": "req-uuid-v4"
  }
}
```

**媒体服务错误码与 gRPC Status 映射**：

| MediaErrorCode | gRPC Status | 说明 |
|----------------|-------------|------|
| `SESSION_NOT_FOUND` | NOT_FOUND | 会话不存在 |
| `PORT_EXHAUSTED` | RESOURCE_EXHAUSTED | RTP 端口池耗尽 |
| `CODEC_NOT_SUPPORTED` | INVALID_ARGUMENT | 不支持的编解码格式 |
| `PIPELINE_ERROR` | INTERNAL | Pipeline 处理异常 |
| `RECORDING_FAILED` | INTERNAL | 录音写入失败 |
| `DTLS_HANDSHAKE_FAILED` | FAILED_PRECONDITION | DTLS-SRTP 握手失败 |
| `ICE_CONNECTIVITY_FAILED` | DEADLINE_EXCEEDED | ICE 连接超时 |
| `INTERNAL_ERROR` | INTERNAL | 内部错误 |

---

## 13. 测试策略

### 13.1 测试分层

```
┌─────────────────────────────────────┐
│         端到端测试 (E2E)             │
├─────────────────────────────────────┤
│         集成测试 (Integration)       │
├─────────────────────────────────────┤
│         单元测试 (Unit)              │
└─────────────────────────────────────┘
```

### 13.2 单元测试示例

```rust
#[test]
fn pcmu_encode_decode_roundtrip() {
    let encoder = create_encoder(CodecType::Pcmu).unwrap();
    let decoder = create_decoder(CodecType::Pcmu).unwrap();
    
    let pcm = generate_sine_wave(8000, 160);
    let encoded = encoder.encode(&pcm).unwrap();
    let decoded = decoder.decode(&encoded).unwrap();
    
    assert_eq!(pcm.len(), decoded.len());
    for (a, b) in pcm.iter().zip(decoded.iter()) {
        assert!((a - b).abs() < 100);
    }
}

#[test]
fn average_mixer_two_inputs() {
    let mixer = AverageMixer;
    
    let input1 = AudioFrame::from_samples(8000, vec![1000, 2000, 3000]);
    let input2 = AudioFrame::from_samples(8000, vec![2000, 3000, 4000]);
    
    let output = mixer.mix(&[&input1, &input2]);
    
    assert_eq!(output.samples, vec![1500, 2500, 3500]);
}
```

### 13.3 集成测试示例

```rust
#[tokio::test]
async fn pipeline_with_recorder() {
    let mut pipeline = Pipeline::new();
    
    pipeline.add_source(TestSource::new(generate_sine_wave(8000, 160)));
    pipeline.add_node(DecoderNode::new(CodecType::Pcmu));
    
    let recorder = RecorderNode::new(RecordingFormat::Wav, RecordingOutput::Memory);
    pipeline.add_node(recorder);
    
    pipeline.add_node(EncoderNode::new(CodecType::Pcmu));
    pipeline.add_sink(TestSink::new());
    
    pipeline.start().await.unwrap();
    tokio::time::sleep(Duration::from_millis(2000)).await;
    pipeline.stop().await.unwrap();
    
    let recording = pipeline.get_node::<RecorderNode>().unwrap().get_recording();
    assert!(recording.len() > 0);
}
```

### 13.4 负载测试

```rust
#[tokio::test]
#[ignore]
async fn stress_test_10k_sessions() {
    let server = start_test_server().await;
    let mut client = MediaServiceClient::connect(server.addr()).await.unwrap();
    
    for i in 0..10_000 {
        let req = CreateSessionRequest {
            session_id: format!("stress-{}", i),
            ..Default::default()
        };
        client.create_session(req).await.unwrap();
    }
    
    let list = client.list_sessions(ListSessionsRequest::default()).await.unwrap();
    assert_eq!(list.sessions.len(), 10_000);
}
```

### 13.5 测试覆盖率目标

| 模块 | 行覆盖率 | 分支覆盖率 |
|------|---------|-----------|
| 编解码 | >90% | >85% |
| 混音器 | >90% | >85% |
| Pipeline | >80% | >75% |
| 会话管理 | >85% | >80% |
| gRPC API | >70% | >60% |
| 录音 | >75% | >70% |
| DTMF | >85% | >80% |
| 转码 | >80% | >75% |
| ASR/TTS | >80% | >75% |

---

## 14. 监控与可观测性

### 14.1 指标分类

```
指标层次：
  ├─ 系统级指标（System Metrics）
  │   ├─ CPU / 内存 / 磁盘 / 网络
  │   └─ 进程级（线程数、FD 数）
  │
  ├─ 技术级指标（Technical Metrics）
  │   ├─ 端口池利用率
  │   ├─ Pipeline 延迟
  │   ├─ 编解码耗时
  │   └─ gRPC 请求延迟
  │
  └─ 业务级指标（Business Metrics）
      ├─ 并发会话数
      ├─ 通话时长分布
      ├─ 会议参与人数
      ├─ 录音时长/大小
      └─ 错误率
```

### 14.2 Prometheus 指标导出

```rust
pub struct BusinessMetrics {
    pub active_sessions: IntGauge,
    pub sessions_created_total: IntCounter,
    pub sessions_terminated_total: IntCounter,
    pub session_duration_seconds: Histogram,
    
    pub active_conferences: IntGauge,
    pub conference_participants: Histogram,
    
    pub active_recordings: IntGauge,
    pub recording_duration_seconds: Histogram,
    pub recording_size_bytes: Histogram,
    pub recording_dropped_frames_total: IntCounter,
    
    pub errors_total: IntCounterVec,
    pub cross_site_calls_total: IntCounter,
    pub site_id: IntGauge,
}
```

### 14.3 Prometheus 端点

```rust
pub async fn start_metrics_server(addr: SocketAddr) {
    let metrics_route = warp::path("metrics").map(|| {
        let encoder = TextEncoder::new();
        let metric_families = prometheus::gather();
        let mut buffer = Vec::new();
        encoder.encode(&metric_families, &mut buffer).unwrap();
        
        warp::http::Response::builder()
            .header("Content-Type", encoder.format_type())
            .body(buffer)
            .unwrap()
    });
    
    warp::serve(metrics_route).run(addr).await;
}
```

### 14.4 前端监控 API

```rust
#[derive(Serialize)]
pub struct DashboardResponse {
    pub overview: OverviewStats,
    pub realtime: RealtimeStats,
    pub trends: TrendStats,
    pub alerts: Vec<Alert>,
}

#[derive(Serialize)]
pub struct OverviewStats {
    pub total_sessions: u64,
    pub active_sessions: u64,
    pub total_conferences: u64,
    pub active_conferences: u64,
    pub total_recordings: u64,
    pub active_recordings: u64,
    pub uptime_seconds: u64,
    pub site_id: String,
}

#[derive(Serialize)]
pub struct RealtimeStats {
    pub cpu_usage_percent: f64,
    pub memory_usage_percent: f64,
    pub disk_usage_percent: f64,
    pub port_pool_utilization_percent: f64,
    pub active_streams: u64,
    pub total_bandwidth_mbps: f64,
    pub average_latency_ms: f64,
    pub error_rate_percent: f64,
    pub dropped_frame_rate_percent: f64,
}
```

**API 路由**：
```
GET /api/v1/monitoring/dashboard     # Dashboard 概览
GET /api/v1/monitoring/sessions      # 会话列表
GET /api/v1/monitoring/conferences   # 会议列表
GET /api/v1/monitoring/recordings    # 录音列表
GET /api/v1/monitoring/alerts        # 告警列表
POST /api/v1/monitoring/alerts/{id}/acknowledge  # 确认告警
```

### 14.5 Dashboard 设计

```
┌─────────────────────────────────────────────────────────────┐
│  NextSWITCH Media Server Dashboard                          │
│  Site: us-east-1 | Instance: medserver-01 | Uptime: 7d 12h │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Active       │  │ Total        │  │ Port Pool    │      │
│  │ Sessions     │  │ Sessions     │  │ Utilization  │      │
│  │   12,450     │  │   125,000    │  │    68%       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Sessions Timeline (Last 24 Hours)                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │  System Resources    │  │  Media Quality       │        │
│  │  CPU:    45%  ████░░ │  │  Avg Latency: 23ms   │        │
│  │  Memory: 62%  █████░ │  │  Error Rate: 0.1%    │        │
│  └──────────────────────┘  └──────────────────────┘        │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ⚠ Active Alerts (2)                                │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 14.6 告警规则

```yaml
groups:
  - name: medserver_alerts
    rules:
      - alert: HighCPUUsage
        expr: medserver_cpu_usage_percent > 85
        for: 5m
        labels:
          severity: warning
      
      - alert: PortPoolExhaustion
        expr: medserver_port_pool_utilization_percent > 90
        for: 5m
        labels:
          severity: critical
      
      - alert: HighErrorRate
        expr: rate(medserver_errors_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
      
      - alert: RecordingDiskFull
        expr: medserver_recording_disk_free_bytes < 10GB
        for: 5m
        labels:
          severity: critical
```

### 14.7 监控配置

```toml
[media.monitoring]
http_enabled = true
http_addr = "0.0.0.0:9092"
metrics_path = "/metrics"
health_path = "/health"
api_base_path = "/api/v1/monitoring"

collection_interval = "10s"
retention_period = "7d"

alerting_enabled = true
alertmanager_url = "http://alertmanager:9093"
```

---

## 附录 A：术语表

| 术语 | 说明 |
|------|------|
| Pipeline | 音频处理链，由多个 Node 组成 |
| Node | Pipeline 中的处理单元（源、汇、处理器） |
| Session | 媒体会话，对应一通电话的媒体流 |
| Conference | 会议，多个参与者混合音频 |
| Recording | 录音，将音频流持久化到文件 |
| IVR | 交互式语音应答 |
| Transcoding | 转码，编解码格式转换 |
| Port Pool | 端口池，预分配的 RTP 端口集合 |
| Site | 站点，物理或逻辑部署位置 |
| AZ | 可用区，站点内的隔离单元 |

---

## 附录 B：配置示例

```toml
[media]
# 站点配置
site_id = "us-east-1"
az_id = "us-east-1a"
instance_id = "medserver-01"

# 容量
max_sessions = 25000

[media.transport]
port_ranges = [
    { start = 10000, end = 20000 },
    { start = 30000, end = 40000 },
]
preallocate = 1000

[media.recording]
storage_dir = "/data/recordings"
default_format = "mp3"
max_file_size = "64MB"
max_file_duration = "1h"

[media.recording.io]
ring_buffer_size = "64KB"
batch_flush_interval = "100ms"
fsync_policy = "interval"
fsync_interval = "5s"
writer_threads = 8

[media.conference]
default_mixer = "adaptive"
max_active_speakers = 5
vad_threshold = 0.1

[media.ivr]
prompt_cache_size = "1GB"
tts_cache_size = "500MB"

# ASR/TTS 配置（详见 §11.10）
[media.asr_tts]
enabled = true
default_asr = "aliyun"
default_tts = "aliyun"

[media.monitoring]
http_enabled = true
http_addr = "0.0.0.0:9092"
```

---

## 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-09-09 | 初始版本 |
| 2.0.0 | 2026-09-09 | 跨文档一致性验证。新增：服务端口分配表（§4.5，引用 config-and-gateway-design Appendix B）；健康检查端点（§4.5，引用 config-and-gateway-design Appendix D）；服务通信矩阵（§5.5）；统一错误响应格式（§11.6，引用 config-and-gateway-design §14.1） |
| 3.0.0 | 2026-09-10 | 新增 §11 ASR/TTS 集成：多 Provider 抽象层（AsrProvider/TtsProvider trait）；阿里云 NLS 实现（SpeechTranscriber + FlowingSpeechSynthesizer）；Provider 注册与流量路由（加权轮询、站点亲和、Failover）；WebSocket 连接池；Pipeline 节点集成（ASR TAP 节点 + TTS Source 节点）；gRPC API 扩展（StartAsr/StopAsr/StartTts/PushTtsText/StopTts）；Token 自动刷新；监控指标。更新：§1.1 crate 结构增加 asr_tts 模块；§5.5 通信矩阵增加 ASR/TTS Provider 行；§9.1/§9.6 IVR 引用 ASR/TTS 模块；§13.5 测试覆盖率增加 ASR/TTS 行；附录 B 配置增加 asr_tts 段 |

---

**文档结束**
