# SIP服务设计

> SIP 信令处理服务详细设计

---

## 概述

sipserver 是 NextSWITCH 的 SIP 信令处理服务，负责 SIP 协议处理、分机注册、呼叫路由与代理、B2BUA 会话管理和 CDR 生成。

## 模块列表

| 模块 | 说明 |
|------|------|
| [Transport 层设计](./sipserver/transport) | 多协议监听、UDP Worker 模型 |
| [Pre-Route 管线](./sipserver/preroute) | 消息解析、SIP 防火墙、速率限制、呼叫准入控制 |
| [SIP 方法处理](./sipserver/methods) | OPTIONS、INFO、REFER 等方法处理 |
| [Proxy 模块](./sipserver/proxy) | 代理决策、注册表查询优化 |
| [Registrar 模块](./sipserver/registrar) | REGISTER 处理、注册数据结构 |
| [Dialog 模块](./sipserver/dialog) | B2BUA 会话管理、消息转发 |
| [CDR 生成](./sipserver/cdr) | CDR 数据流、写入实现 |
| [心跳机制](./sipserver/heartbeat) | 实例心跳、服务发现 |

## 端口配置

| 协议 | 端口 | 说明 |
|------|------|------|
| SIP UDP | 5060 | 默认 SIP 传输 |
| SIP TCP | 5060 | 大消息/可靠传输 |
| SIP TLS | 5061 | 加密 SIP |
| SIP WSS | 5443 | WebSocket SIP（与 sigserver 共享端口） |
| Metrics/Health | 9090 | Prometheus 指标 + 健康检查 |
| gRPC | 50051 | 作为 gRPC 客户端连接 medserver（ProcessCall） |
