# Nextswitch 压力测试工具设计规格

> **日期**: 2026-09-10
> **状态**: 草案
> **作者**: Nextswitch Team

## 1. 概述

### 1.1 目标

为 Nextswitch VoIP 软交换平台构建专用压力测试工具 `nextswitch-stress`，具备以下能力：

- **单服务性能基线测试** — 定位单个服务（SignalServer、CTIServer、MediaServer）的性能瓶颈
- **全链路场景编排** — 模拟真实呼叫中心业务流（座席登录 → 外呼 → 通话 → 挂断），验证端到端容量
- **分阶段交付** — Phase 1 单机覆盖 SIP + CTI + 媒体；Phase 2 引入 WebRTC 客户端和分布式多机协同

### 1.2 设计决策摘要

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 核心目标 | 单服务压测 + 全链路编排 | 既需要瓶颈定位，也需要容量验证 |
| 压测规模 | 先单机后分布式 | Phase 1 单机满足开发验证，架构预留分布式扩展 |
| 实现形态 | 工作区内新建 Rust crate | 复用 `rsipstack`、`rustrtc`、`audio-codec`，技术栈一致 |
| WebRTC 客户端 | Phase 2 实现 | 降低初始复杂度，先跑通 SIP + CTI 核心框架 |
| CTI 客户端 | Rust 原生 WebSocket | 与压测引擎同进程，零跨语言开销 |

### 1.3 范围

**包含：**

- SIP UA 模拟（注册、主叫、被叫）
- CTI 座席模拟（登录、状态切换、呼叫控制）
- RTP 媒体生成（静音、正弦波、WAV 回放）
- 指标采集与报告（延迟分布、吞吐、错误率、资源占用）
- 场景编排引擎（YAML 配置驱动）
- 分布式扩展架构（Phase 2）

**不包含（Phase 1）：**

- WebRTC 客户端模拟（Phase 2）
- 分布式多机协调（Phase 2）
- 真实音频 MOS 评分（可选扩展）

## 2. 整体架构

```
┌─────────────────────────────────────────────────┐
│              nextswitch-stress                   │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌───────────┐   ┌────────────────────────┐    │
│  │  Config    │──▶│   Scenario Engine      │    │
│  │  (YAML)   │   │   (场景编排器)          │    │
│  └───────────┘   └──────────┬─────────────┘    │
│                             │                   │
│              ┌──────────────┼──────────────┐    │
│              ▼              ▼              ▼    │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │ SIP Driver   │ │ CTI Driver   │ │ Media   │ │
│  │ (rsipstack)  │ │ (WS+JSON-RPC)│ │ Gen     │ │
│  │              │ │              │ │ (RTP)   │ │
│  └──────┬───────┘ └──────┬───────┘ └────┬────┘ │
│         │                │              │       │
│  ┌──────┴────────────────┴──────────────┴────┐  │
│  │           Metrics Collector               │  │
│  │  (延迟分布 / 吞吐量 / 错误率 / 资源占用)   │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │           Reporter (终端 / JSON / CSV)     │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 2.1 核心组件

| 组件 | 职责 |
|------|------|
| **Config** | YAML 场景定义 + 目标服务地址 + 并发参数 |
| **Scenario Engine** | 解析场景剧本，按时间线调度 Driver 执行，管理虚拟用户生命周期 |
| **SIP Driver** | 模拟 SIP UA：注册、INVITE、BYE；支持主叫/被叫两种模式 |
| **CTI Driver** | 模拟座席：WebSocket 连接 → 登录 → 状态切换 → 接听/挂断/转接 |
| **Media Generator** | 生成 RTP 音频流（静音 / 正弦波 / 预录 WAV），配合 MOS 评分 |
| **Metrics Collector** | 无锁环形缓冲采集，实时聚合 P50/P95/P99 延迟、CPS、并发数 |
| **Reporter** | 实时终端输出 + 最终 JSON/CSV 报告导出 |

### 2.2 分阶段交付计划

| 阶段 | 内容 |
|------|------|
| **Phase 1** | 框架骨架 + SIP Driver（注册/呼叫）+ CTI Driver（登录/呼叫控制）+ Media Generator + Metrics + Reporter |
| **Phase 2** | WebRTC Driver（rustrtc 客户端模式）+ 分布式扩展（多机协调）|

## 3. 场景配置与编排

### 3.1 场景配置格式（YAML）

```yaml
# stress-scenario.yaml
name: "call-center-full-load"
description: "500座席登录 + 200并发外呼"

targets:
  sip_server: "192.168.1.10:5060"
  cti_server: "ws://192.168.1.10:8085"
  media_server: "192.168.1.10:7000"

phases:
  - name: "agent-login"
    start: 0s
    duration: 30s
    agents:
      count: 500
      ramp_up: 50        # 每秒新增50个座席
      driver: cti
      actions:
        - login: { extension: "agent-{id}", password: "test123" }
        - set_state: "ready"

  - name: "outbound-calls"
    start: 30s
    duration: 120s
    callers:
      count: 200
      ramp_up: 10         # 每秒新增10路呼叫
      driver: sip
      actions:
        - invite: { from: "trunk-{id}", to: "agent-{round_robin}" }
        - wait: { state: "answered", timeout: 10s }
        - hold: 30s        # 通话持续30秒
        - bye: {}

  - name: "monitor"
    start: 0s
    duration: 150s
    metrics:
      interval: 1s
      report:
        - terminal
        - file: { format: json, path: "results/report.json" }
```

### 3.2 编排模型

- **Phase** — 按时间线定义的一个压测阶段，有 `start`/`duration`/`ramp_up`
- **Virtual User** — 每个 caller/agent 是一个独立虚拟用户，有自己的 Driver 实例和状态机
- **Action** — 原子操作（`invite` / `answer` / `bye` / `login` / `set_state`），Driver 实现具体协议细节
- **Ramp-up** — 控制虚拟用户的注入速率，避免瞬间打满

### 3.3 单服务压测模式

直接模式不做场景编排，只测单服务极限：

```yaml
# 直接模式 - 不做场景编排，只测单服务极限
mode: direct
target: sip_server
test:
  type: register-flood
  count: 10000
  concurrent: 500
  duration: 60s
```

## 4. SIP Driver 详细设计

### 4.1 虚拟用户模型

```rust
struct SipUser {
    id: u64,
    extension: String,        // e.g. "1001"
    password: String,
    transport: TransportType, // UDP | TCP | TLS
    state: SipUserState,      // Idle | Registering | Registered | InCall | HangingUp
    call: Option<ActiveCall>,
}
```

### 4.2 支持的压测模式

| 模式 | 描述 | 指标 |
|------|------|------|
| `register-flood` | N 个 UA 并发注册，测量注册成功率与延迟 | 注册 CPS、P99 延迟、失败率 |
| `call-flood` | M 个主叫并发 INVITE 到目标，测量呼叫建立 | 呼叫 CPS、接通率、首包延迟 |
| `sustained-calls` | 维持 N 路并发通话，周期性挂断并重新发起 | 稳态并发数、媒体质量、内存增长 |
| `register-keepalive` | 大量注册后持续 re-REGISTER，测服务器长连接能力 | 注册刷新成功率、连接泄漏检测 |

### 4.3 SIP 协议细节

- 使用 `rsipstack` 创建独立 transaction layer，每个虚拟用户共享 transport 但独立 dialog
- **注册**：REGISTER → 200 OK，支持 Digest 认证
- **呼叫（主叫）**：INVITE → 180 → 200 OK → ACK → BYE，完整状态机
- **呼叫（被叫）**：监听 INVITE → 自动应答（180 + 200）→ 等待 BYE
- **RTP**：应答后启动本地 RTP 会话，发送合成音频流

## 5. CTI Driver 详细设计

### 5.1 座席状态机

```
AgentState: Login → Ready → [InCall | AfterCall | WrapUp] → Ready → Logout
                  ↘ NotReady ↗
```

### 5.2 CTI 客户端架构

```rust
struct CtiDriver {
    ws_pool: ConnectionPool,     // tokio-tungstenite 连接池
    agents: Vec<VirtualAgent>,   // 虚拟座席列表
    event_rx: mpsc::Receiver,    // 服务端推送事件接收
    metrics: Arc<MetricsSink>,
}

struct VirtualAgent {
    id: u64,
    extension: String,
    ws_conn: WebSocketStream,    // 每座席一条 WS 连接
    state: AgentState,
    current_call: Option<CallRef>,
}
```

### 5.3 支持的 CTI 压测场景

| 场景 | 描述 | 指标 |
|------|------|------|
| `login-storm` | N 座席并发登录，测量登录吞吐 | 登录 CPS、P99 延迟、失败率 |
| `state-churn` | 座席在 Ready/NotReady 间高频切换 | 状态切换延迟、服务端事件一致性 |
| `call-handling` | 模拟完整来电处理：振铃→接听→挂断→后处理 | 呼叫处理时长、事件丢失率 |
| `mixed-workload` | 登录 + 状态切换 + 呼叫处理混合 | 综合吞吐、各操作延迟分布 |

### 5.4 协议交互

```
Client                          CTI Server
  │                                │
  │── WS Connect ─────────────────▶│
  │── login(ext, pwd) ────────────▶│
  │◀── login_ack(agent_id) ───────│
  │── set_state("ready") ─────────▶│
  │◀── state_changed("ready") ────│
  │◀── call_event(ringing) ───────│  (由 SIP Driver 触发或 Server 模拟)
  │── answer(call_id) ────────────▶│
  │◀── call_event(answered) ──────│
  │── hangup(call_id) ────────────▶│
  │◀── call_event(ended) ─────────│
```

### 5.5 CTI 与 SIP 的协调

压测全链路场景时，CTI Driver 和 SIP Driver 需要协同——SIP 侧发起呼叫，CTI 侧座席振铃/接听。通过内部的 `Scenario Engine` 统一调度，共享 `CallRef` 关联同一次呼叫的两端。

## 6. Media Generator 详细设计

### 6.1 音频生成策略

| 模式 | 描述 | 用途 |
|------|------|------|
| `silence` | 全零 RTP payload，零 CPU 开销 | 纯信令压测，排除媒体干扰 |
| `tone` | 生成标准正弦波（如 440Hz），PCMU/PCMA 编码 | 媒体路径验证 + MOS 评分 |
| `wav-file` | 读取 WAV 文件循环发送，支持多种采样率 | 模拟真实语音流量特征 |
| `rtp-loop` | 录制真实通话的 RTP 包序列，按时间戳回放 | 最接近生产流量特征 |

### 6.2 RTP 会话模型

```rust
struct RtpGenerator {
    mode: AudioMode,
    codec: MediaCodec,           // PCMU | PCMA | G722 | Opus
    ptime_ms: u32,               // 默认 20ms
    payload_type: u8,
    ssrc: u32,
    sequence: AtomicU16,
    timestamp: AtomicU32,
    tone_state: Option<ToneState>,  // tone 模式下的相位累加器
    wav_reader: Option<WavLoop>,    // wav-file 模式下的循环读取器
}
```

### 6.3 关键设计决策

- **不依赖声卡/ALSA** — 纯内存生成，零硬件依赖，适合 CI/压测机
- **每路通话独立 SSRC** — 便于 MediaServer 侧区分和统计
- **DTMF 注入** — 支持在通话中发送 RFC 2833 事件，测试 IVR 交互场景
- **MOS 评估（可选）** — 如果 MediaServer 有回环能力，对比发送/接收的 RTP 包计算近似 MOS

### 6.4 资源开销估算

| 模式 | 每路 CPU | 每路内存 | 每路带宽 |
|------|---------|---------|---------|
| silence | ~0% | ~2KB | 0 (不发 RTP) 或 ~8kbps |
| tone (PCMU) | <0.5% | ~4KB | ~64kbps |
| wav-file (PCMU) | <1% | ~64KB (buffer) | ~64kbps |

## 7. Metrics Collector 详细设计

### 7.1 采集架构

```
Driver 线程                    Metrics Collector              Reporter
    │                               │                            │
    │── LatencySample ─────────────▶│                            │
    │── CallStart/CallEnd ─────────▶│── 环形缓冲 ──▶ 定时聚合 ──▶│── 终端实时刷新
    │── ErrorEvent ────────────────▶│   (lock-free)              │── JSON 文件
    │── ResourceSample ────────────▶│                            │── CSV 文件
```

### 7.2 指标分类

| 类别 | 指标 | 采集方式 |
|------|------|---------|
| **延迟** | 注册延迟、呼叫建立延迟（INVITE→200OK）、首包延迟、CTI 事件延迟 | 每个操作打点，聚合 P50/P95/P99/max |
| **吞吐** | 注册 CPS、呼叫 CPS、CTI 消息 TPS | 滑动窗口计数（1s 窗口）|
| **并发** | 活跃注册数、活跃通话数、活跃座席数、WS 连接数 | 瞬时快照 |
| **错误** | SIP 错误码分布、CTI 错误类型、超时计数、连接断开计数 | 分类计数器 |
| **资源** | 进程 RSS/VSS、CPU 使用率、FD 数量、tokio worker 利用率 | 定时采样（1s） |
| **质量** | RTP 丢包率、乱序率、jitter（如果开启 MOS 评估） | 每路通话采样聚合 |

### 7.3 无锁采集设计

```rust
struct MetricsSink {
    latency_tx: crossbeam::channel::Sender<LatencySample>,  // 无锁 MPMC
    counters: Vec<AtomicU64>,       // 按指标 ID 索引
    gauges: Vec<AtomicI64>,         // 可增可减的瞬时值
}

struct MetricsAggregator {
    rx: crossbeam::channel::Receiver<LatencySample>,
    histogram: hdrhistogram::Histogram<u64>,  // 延迟分布
    window_start: Instant,
}
```

- Driver 侧只负责 `send`，不阻塞业务逻辑
- Aggregator 在独立 tokio task 中定时拉取、聚合、输出
- 使用 `hdrhistogram` 做延迟分布，支持精确的 P50/P95/P99 计算

### 7.4 Reporter 输出格式

```
─── Nextswitch Stress Report ───────────────────────────────
Scenario: call-center-full-load    Duration: 120s
─────────────────────────────────────────────────────────────
SIP Register:  10000 total | 9998 ok | 2 failed | P99: 45ms
SIP Calls:       500 active | 482 answered | 18 timeout | P99 setup: 320ms
CTI Agents:      500 logged | 3 state errors | login P99: 120ms
RTP Streams:     482 active | 0.01% pkt loss | avg jitter: 2.1ms
Resources:    RSS 1.2GB | CPU 340% | FDs 8200
─────────────────────────────────────────────────────────────
```

## 8. 分布式扩展与多机协调（Phase 2）

### 8.1 整体拓扑

```
                    ┌──────────────────┐
                    │   Controller     │  (调度节点，单实例)
                    │   :9100 (gRPC)   │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼────────┐ ┌──▼──────────────┐
     │  Worker-1     │ │  Worker-2   │ │  Worker-N       │
     │  (单机压测引擎)│ │  (单机压测引擎)│ │  (单机压测引擎)  │
     └───────────────┘ └─────────────┘ └─────────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Nextswitch 集群  │  (被测目标)
                    └──────────────────┘
```

### 8.2 角色分工

| 角色 | 职责 |
|------|------|
| **Controller** | 解析场景 YAML、分配虚拟用户到各 Worker、收集聚合指标、触发全局 start/stop |
| **Worker** | 复用 Phase 1 单机引擎，接收分配的用户范围（如 agent 1-200），独立执行并上报本地指标 |

### 8.3 协调协议

```
Controller                    Worker-1          Worker-2
    │                           │                  │
    │── AssignRange(1..200) ───▶│                  │
    │── AssignRange(201..400) ──┼─────────────────▶│
    │── Prepare ───────────────▶│                  │
    │── Prepare ────────────────┼─────────────────▶│
    │◀── Ready ────────────────│                  │
    │◀── Ready ────────────────┼─────────────────│
    │── Start(timestamp) ──────▶│                  │
    │── Start(timestamp) ──────┼─────────────────▶│
    │   ... 各自独立执行 ...     │                  │
    │── CollectMetrics ────────▶│                  │
    │── CollectMetrics ─────────┼─────────────────▶│
    │◀── MetricsReport ────────│                  │
    │◀── MetricsReport ─────────┼─────────────────│
    │── 全局聚合 + 输出报告      │                  │
```

### 8.4 关键设计决策

- **用户分配策略** — 按范围切分（Worker-1 负责 agent 1-200，Worker-2 负责 201-400），保证同一虚拟用户始终在同一 Worker 上，避免跨机状态同步
- **时钟同步** — Start 命令携带统一时间戳，Worker 本地等待到该时刻再启动，误差容忍 ±50ms（压测场景可接受）
- **指标聚合** — Worker 本地先聚合（hdrhistogram 可合并），Controller 收集后做全局 merge，不传原始样本
- **无状态 Worker** — Worker 不保存跨次压测状态，Controller 可随时扩缩容

### 8.5 Phase 1 预留的扩展点

```rust
// Phase 1: 本地直接执行
trait Executor {
    async fn execute(&self, scenario: &Scenario) -> Result<Report>;
}

// Phase 2: 新增分布式实现
struct DistributedExecutor {
    controller: ControllerClient,  // gRPC 连接 Controller
    workers: Vec<WorkerEndpoint>,
}

impl Executor for DistributedExecutor { ... }
```

- `Executor` trait 是 Phase 1 就定义好的抽象，`LocalExecutor` 和 `DistributedExecutor` 共享同一接口
- 场景 YAML 增加 `distribution` 字段即可切换模式

### 8.6 万级并发资源估算

| 规模 | Worker 数量 | 单 Worker 内存 | 总带宽 |
|------|------------|---------------|--------|
| 1000 座席 + 500 通话 | 1 (单机) | ~500MB | ~32Mbps |
| 5000 座席 + 2000 通话 | 4 | ~500MB each | ~128Mbps |
| 10000 座席 + 5000 通话 | 8-10 | ~500MB each | ~320Mbps |

## 9. 分布式压测场景 YAML 配置示例

### 9.1 全链路呼叫中心压测

```yaml
name: "call-center-distributed-full"
description: "5000座席 + 2000并发外呼 + 混合话务，分布式多机协同"
mode: distributed

controller: "192.168.1.100:9100"
workers:
  - host: "192.168.1.101"
    port: 9101
    label: "worker-agent-primary"
  - host: "192.168.1.102"
    port: 9101
    label: "worker-agent-secondary"
  - host: "192.168.1.103"
    port: 9101
    label: "worker-caller"
  - host: "192.168.1.104"
    port: 9101
    label: "worker-caller-secondary"

distribution:
  strategy: "range-split"          # 按范围切分虚拟用户
  agent_workers: ["worker-agent-primary", "worker-agent-secondary"]
  caller_workers: ["worker-caller", "worker-caller-secondary"]
  sync_tolerance_ms: 50            # Worker 间启动时间容忍差

targets:
  sip_server:
    address: "10.0.1.10"
    port: 5060
    transport: udp
  cti_server:
    address: "ws://10.0.1.10:8085"
    protocol: wss
    tls_ca: "/etc/nextswitch/certs/ca.pem"
  media_server:
    address: "10.0.1.10"
    rtp_port_range: [10000, 20000]

phases:
  # ── Phase 1: 座席登录 ──────────────────────────────
  - name: "agent-login-wave"
    start: 0s
    duration: 60s
    agents:
      total: 5000
      ramp_up: 100                  # 每秒注入100个座席
      driver: cti
      distribution:
        across: "agent_workers"
        split: "even"               # 2500/2500
      credentials:
        extension_pattern: "agent-{id}"
        password: "stress-test-2026"
        start_id: 10001
      actions:
        - login: {}
        - wait: { duration: 500ms }
        - set_state: "ready"

  # ── Phase 2: 状态抖动 ──────────────────────────────
  - name: "agent-state-churn"
    start: 60s
    duration: 30s
    agents:
      total: 5000
      driver: cti
      distribution:
        across: "agent_workers"
        split: "even"
      actions:
        - loop:
            count: 3
            actions:
              - set_state: "not_ready"
              - wait: { duration: 2s }
              - set_state: "ready"
              - wait: { duration: 1s }

  # ── Phase 3: 外呼风暴 ──────────────────────────────
  - name: "outbound-call-storm"
    start: 90s
    duration: 180s
    callers:
      total: 2000
      ramp_up: 50                   # 每秒新增50路呼叫
      driver: sip
      distribution:
        across: "caller_workers"
        split: "even"               # 1000/1000
      source:
        extension_pattern: "trunk-{id}"
        start_id: 90001
      target:
        strategy: "round-robin-agents"   # 轮询分配给已登录座席
      actions:
        - invite:
            codec: PCMU
            ptime_ms: 20
        - wait: { state: "answered", timeout: 15s }
        - media:
            mode: tone
            frequency_hz: 440
            duration: 20s
        - bye: {}
        - wait: { duration: 5s }         # 挂断后间隔

  # ── Phase 4: 稳态维持 ──────────────────────────────
  - name: "sustained-traffic"
    start: 270s
    duration: 300s
    callers:
      total: 1000                   # 维持1000路并发
      ramp_up: 0                    # 不再增长
      driver: sip
      distribution:
        across: "caller_workers"
        split: "even"
      target:
        strategy: "round-robin-agents"
      actions:
        - invite: {}
        - wait: { state: "answered", timeout: 10s }
        - media:
            mode: wav-file
            file: "/opt/stress/audio/customer-service.wav"
            loop: true
        - hold: 45s
        - bye: {}
        - wait: { duration: 3s }
    agents:
      total: 5000
      driver: cti
      distribution:
        across: "agent_workers"
        split: "even"
      actions:
        - on_call_end:
            - set_state: "wrap_up"
            - wait: { duration: 5s }
            - set_state: "ready"

  # ── Phase 5: 座席登出 ──────────────────────────────
  - name: "agent-logout"
    start: 570s
    duration: 30s
    agents:
      total: 5000
      ramp_up: 200
      driver: cti
      distribution:
        across: "agent_workers"
        split: "even"
      actions:
        - set_state: "not_ready"
        - logout: {}

metrics:
  collection:
    interval: 1s
    latency_percentiles: [p50, p95, p99, p999, max]
    resource_sampling:
      enabled: true
      interval: 1s
  aggregation:
    mode: "hierarchical"            # Worker 本地聚合 → Controller 全局合并
    histogram_merge: true
  report:
    realtime:
      enabled: true
      interval: 5s
      output: terminal
    final:
      - format: json
        path: "results/distributed-full-report.json"
      - format: csv
        path: "results/distributed-full-report.csv"
      - format: html
        path: "results/distributed-full-report.html"

thresholds:                         # 达标判定
  register_success_rate: 99.9
  call_answer_rate: 95.0
  p99_call_setup_ms: 500
  p99_cti_event_ms: 200
  rtp_packet_loss_pct: 0.1
  max_error_count: 10
```

### 9.2 单服务极限压测（分布式）

```yaml
name: "sip-server-max-register"
description: "测试 SIP Server 注册极限 — 30000 UA 并发注册"
mode: distributed

controller: "10.0.1.100:9100"
workers:
  - host: "10.0.1.101"
    port: 9101
  - host: "10.0.1.102"
    port: 9101
  - host: "10.0.1.103"
    port: 9101
  - host: "10.0.1.104"
    port: 9101
  - host: "10.0.1.105"
    port: 9101
  - host: "10.0.1.106"
    port: 9101

distribution:
  strategy: "range-split"

targets:
  sip_server:
    address: "10.0.1.10"
    port: 5060
    transport: udp

phases:
  - name: "register-flood"
    start: 0s
    duration: 120s
    callers:
      total: 30000
      ramp_up: 500                  # 每秒500个注册
      driver: sip
      distribution:
        across: "all"               # 均匀分配到6个 Worker，每个5000
        split: "even"
      source:
        extension_pattern: "stress-{id}"
        start_id: 1
      actions:
        - register:
            auth: digest
            expires: 3600
        - wait: { state: "registered", timeout: 5s }

  - name: "keepalive"
    start: 120s
    duration: 300s
    callers:
      total: 30000
      driver: sip
      distribution:
        across: "all"
        split: "even"
      actions:
        - loop:
            interval: 1800s         # 每30分钟刷新注册
            jitter: 30s             # 随机抖动避免同步风暴
            actions:
              - register:
                  auth: digest
                  expires: 3600

metrics:
  collection:
    interval: 1s
  report:
    final:
      - format: json
        path: "results/sip-max-register.json"

thresholds:
  register_success_rate: 99.5
  p99_register_latency_ms: 100
  max_error_count: 50
```

### 9.3 故障注入场景

```yaml
name: "graceful-degradation"
description: "压测中模拟 Worker 故障，验证系统降级能力"
mode: distributed

controller: "10.0.1.100:9100"
workers:
  - host: "10.0.1.101"
    port: 9101
    label: "worker-a"
  - host: "10.0.1.102"
    port: 9101
    label: "worker-b"
  - host: "10.0.1.103"
    port: 9101
    label: "worker-c"

targets:
  sip_server:
    address: "10.0.1.10"
    port: 5060
    transport: udp
  cti_server:
    address: "ws://10.0.1.10:8085"

phases:
  - name: "baseline-load"
    start: 0s
    duration: 60s
    agents:
      total: 3000
      ramp_up: 100
      driver: cti
      distribution:
        across: "all"
        split: "even"
      actions:
        - login: {}
        - set_state: "ready"
    callers:
      total: 500
      ramp_up: 20
      driver: sip
      distribution:
        across: "all"
        split: "even"
      target:
        strategy: "round-robin-agents"
      actions:
        - invite: {}
        - wait: { state: "answered", timeout: 10s }
        - media: { mode: silence }
        - hold: 30s
        - bye: {}

  - name: "worker-failure"
    start: 60s
    duration: 0s                    # 瞬时触发
    fault_injection:
      - action: "kill-worker"
        target: "worker-c"
        method: "graceful-shutdown" # 模拟优雅宕机
      - action: "rebalance"
        from: "worker-c"
        to: ["worker-a", "worker-b"]
        strategy: "even-split"      # 剩余 Worker 接管

  - name: "recovery-observation"
    start: 60s
    duration: 120s
    agents:
      total: 3000
      driver: cti
      distribution:
        across: ["worker-a", "worker-b"]
        split: "even"
      actions:
        - monitor_only: true        # 不注入新操作，只观察恢复
    callers:
      total: 500
      driver: sip
      distribution:
        across: ["worker-a", "worker-b"]
        split: "even"
      target:
        strategy: "round-robin-agents"
      actions:
        - invite: {}
        - wait: { state: "answered", timeout: 10s }
        - media: { mode: silence }
        - hold: 30s
        - bye: {}

metrics:
  collection:
    interval: 500ms                 # 故障期间更密集采集
  report:
    final:
      - format: json
        path: "results/graceful-degradation.json"

thresholds:
  call_answer_rate: 90.0            # 降级后允许略低
  p99_call_setup_ms: 800            # 放宽延迟阈值
  max_error_count: 100
```

## 10. 关键依赖

| Crate | 用途 |
|-------|------|
| `rsipstack` | SIP 协议栈（注册、INVITE、BYE） |
| `tokio-tungstenite` | CTI WebSocket 客户端 |
| `audio-codec` | PCMU/PCMA/G722/Opus 编解码 |
| `crossbeam-channel` | 无锁 MPMC 指标采集通道 |
| `hdrhistogram` | 延迟分布直方图 |
| `serde` / `serde_yaml` | 场景配置解析 |
| `tracing` | 结构化日志 |
| `clap` | CLI 参数解析 |

## 11. 测试策略

| 测试层级 | 内容 |
|---------|------|
| **单元测试** | 各 Driver 状态机转换、Media Generator 音频生成、Metrics 聚合逻辑 |
| **集成测试** | 单 Driver + Mock Server 交互验证（SIP 注册/呼叫、CTI 登录/事件） |
| **端到端测试** | 小型场景（10 座席 + 5 并发呼叫）跑通完整流程，验证指标采集正确性 |
| **性能回归** | CI 中运行固定场景（100 UA 注册），对比延迟基线，超阈值报警 |
