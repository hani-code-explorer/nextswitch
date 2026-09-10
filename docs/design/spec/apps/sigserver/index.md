# sigserver — WS/WSS 信令服务

> WebRTC 信令处理应用单元

---

## 概述

sigserver 是 NextSWITCH 的 WebSocket 信令服务，负责：

- WebRTC 信令处理
- WebSocket 连接管理
- WebRTC 媒体协商
- 呼叫状态机管理

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-sip** | SDP 处理 | SDP 解析与构建（WebRTC 媒体协商） |
| **nextswitch-api** | gRPC 通信 | gRPC 客户端、服务发现、与 medserver 通信 |

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
- **配置加载**：从 config-server 拉取配置
- **日志追踪**：结构化日志，WebSocket 连接追踪
- **指标收集**：连接数、呼叫数等指标

### nextswitch-sip

```rust
// 使用的 SDP 组件（不使用 SIP 消息处理）
use nextswitch_sip::sdp::{SdpOffer, SdpAnswer, SdpParser};
use nextswitch_sip::sdp::{IceCandidate, DtlsFingerprint};
```

- **SDP 解析**：解析 WebRTC 客户端的 SDP offer
- **SDP 构建**：构建 SDP answer
- **ICE 候选**：ICE candidate 解析与序列化
- **DTLS 指纹**：DTLS fingerprint 处理

### nextswitch-api

```rust
// 使用的 API 组件
use nextswitch_api::grpc::MediaServiceClient;
use nextswitch_api::discovery::ServiceDiscovery;
use nextswitch_api::auth::GrpcAuthInterceptor;
use nextswitch_api::webrtc::{MediaSessionRequest, IceTrickleRequest};
```

- **媒体服务客户端**：调用 medserver 创建 WebRTC 媒体会话
- **ICE Trickle**：ICE 候选交换
- **服务发现**：获取 medserver 端点
- **认证中间件**：gRPC 请求认证

## 相关文档

- [WS/WSS 服务设计](/spec/application/signaling/sigserver)
