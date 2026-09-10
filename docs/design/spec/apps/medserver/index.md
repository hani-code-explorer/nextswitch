# medserver — 媒体服务

> RTP 媒体处理应用单元

---

## 概述

medserver 是 NextSWITCH 的媒体处理服务，负责：

- RTP/RTCP 媒体流处理
- 编解码转换
- 媒体混合（会议桥）
- 录音功能

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-media** | 媒体处理 | RTP 包处理、编解码接口、媒体会话管理 |
| **nextswitch-api** | gRPC 通信 | gRPC 服务端、媒体服务 API 定义 |

## 模块依赖详情

### nextswitch-core

```rust
// 使用的核心组件
use nextswitch_core::error::{AppError, Result};
use nextswitch_core::config::ConfigLoader;
use nextswitch_core::tracing::init_tracing;
use nextswitch_core::metrics::{counter, histogram};
```

- **错误处理**：统一的 `AppError` 类型
- **配置加载**：媒体端口范围、编解码配置
- **日志追踪**：媒体会话追踪
- **指标收集**：RTP 包统计、MOS 分数

### nextswitch-media

```rust
// 使用的媒体组件
use nextswitch_media::rtp::{RtpPacket, RtpSession, RtcpPacket};
use nextswitch_media::codec::{Codec, Pcmu, Pcma, Opus, G729};
use nextswitch_media::session::MediaSession;
use nextswitch_media::mixer::MediaMixer;
use nextswitch_media::recorder::MediaRecorder;
```

- **RTP 处理**：RTP 包解析、序列化、序列号管理
- **RTCP 处理**：RTCP SR/RR 处理、NACK 处理
- **编解码**：音频编解码接口和实现
- **媒体混合**：会议桥多方媒体混合
- **录音**：媒体流录制与存储

### nextswitch-api

```rust
// 使用的 API 组件（作为服务端）
use nextswitch_api::grpc::MediaServiceServer;
use nextswitch_api::webrtc::{
    CreateSessionRequest, CreateSessionResponse,
    UpdateSessionRequest, IceTrickleRequest,
};
```

- **gRPC 服务端**：提供媒体服务 API
- **会话管理 API**：创建/更新/销毁媒体会话
- **WebRTC 支持**：ICE trickle、DTLS 协商

## 相关文档

- [媒体服务器设计](/spec/application/media/design)
- [gRPC 接口](/spec/application/media/interface)
