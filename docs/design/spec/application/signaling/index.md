# 信令服务器

信令服务器是 NextSWITCH 的核心通信组件，负责呼叫信令的接入、代理、流程编排和 CDR 生成。

信令层按协议分为两个独立子系统：

| 子系统 | 服务 | 协议 | 端口 | 职责 |
|--------|------|------|------|------|
| **SIP 信令** | sipserver | SIP (UDP/TCP/TLS/WSS) | 5060-5061 | SIP 注册、代理、B2BUA、SIP 安全 |
| **WS/WSS 信令** | sigserver | WebSocket + WebRTC (WSS) | 5443 | WebRTC 媒体协商、WS 私有协议接入、连接管理 |

两个子系统通过 **Redis Pub/Sub** 协调跨协议呼叫（SIP↔WebRTC），共享 Redis 注册表和 config-service 配置。

## 文档列表

| 文档 | 说明 |
|------|------|
| [信令服务器总体设计](./design) | 架构总览、设计目标、CDR 格式、Redis 规范 |
| [信令交互设计](./interaction) | sipserver/sigserver 与各服务的交互矩阵与呼叫流程 |
| [SIP服务设计](./sipserver) | SIP 信令处理服务概述与模块索引 |
| [WS/WSS 服务设计](./sigserver) | WebRTC 信令处理服务概述与模块索引 |

### SIP服务设计模块

| 模块 | 说明 |
|------|------|
| [Transport 层设计](./sipserver/transport) | 多协议监听、UDP Worker 模型 |
| [Pre-Route 管线](./sipserver/preroute) | 消息解析、SIP 防火墙、速率限制 |
| [SIP 方法处理](./sipserver/methods) | OPTIONS、INFO、REFER 等方法 |
| [Proxy 模块](./sipserver/proxy) | 代理决策、注册表查询 |
| [Registrar 模块](./sipserver/registrar) | REGISTER 处理 |
| [Dialog 模块](./sipserver/dialog) | B2BUA 会话管理 |
| [CDR 生成](./sipserver/cdr) | CDR 数据流与写入 |
| [心跳机制](./sipserver/heartbeat) | 实例心跳与服务发现 |

### WS/WSS 服务设计模块

| 模块 | 说明 |
|------|------|
| [WebSocket 传输层](./sigserver/websocket) | TLS 监听、连接管理 |
| [呼叫状态机](./sigserver/state-machine) | WebRTC 呼叫状态机 |
| [WebRTC 媒体协商](./sigserver/webrtc) | SDP 协商、ICE 候选交换 |
