# sipserver — SIP 信令服务

> SIP 信令处理应用单元

---

## 概述

sipserver 是 NextSWITCH 的 SIP 信令处理服务，负责：

- SIP 协议处理（UDP/TCP/TLS/WSS）
- 分机注册管理
- 呼叫路由与代理
- B2BUA 会话管理
- CDR 生成

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-sip** | SIP 协议 | 消息解析/序列化、SIP 头处理、SDP 解析、URI 处理 |
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

- **错误处理**：统一的 `AppError` 类型，支持错误链和上下文
- **配置加载**：从 config-server 拉取配置，支持热更新
- **日志追踪**：结构化日志，请求追踪 ID 传递
- **指标收集**：Prometheus 指标导出

### nextswitch-sip

```rust
// 使用的 SIP 组件
use nextswitch_sip::message::{SipRequest, SipResponse, SipMessage};
use nextswitch_sip::header::{Headers, Via, From, To, Contact};
use nextswitch_sip::parser::SipParser;
use nextswitch_sip::uri::SipUri;
use nextswitch_sip::sdp::SdpParser;
```

- **消息解析**：高性能 SIP 消息解析器
- **头处理**：SIP 头构建与修改
- **URI 处理**：SIP URI 解析与规范化
- **SDP 处理**：SDP offer/answer 解析

### nextswitch-api

```rust
// 使用的 API 组件
use nextswitch_api::grpc::MediaServiceClient;
use nextswitch_api::discovery::ServiceDiscovery;
use nextswitch_api::auth::GrpcAuthInterceptor;
```

- **媒体服务客户端**：调用 medserver 处理呼叫（ProcessCall）
- **服务发现**：从 Redis 获取服务端点
- **认证中间件**：gRPC 请求认证

## 相关文档

- [SIP服务设计](/spec/application/signaling/sipserver)
- [模块设计](/spec/modules/)
