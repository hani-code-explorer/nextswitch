# WS/WSS 服务设计

> WebRTC 信令处理服务详细设计

---

## 概述

sigserver 是 NextSWITCH 的 WebSocket 信令服务，负责 WebRTC 信令处理、WebSocket 连接管理、媒体协商和呼叫状态机管理。

## 模块列表

| 模块 | 说明 |
|------|------|
| [WebSocket 传输层](./sigserver/websocket) | TLS 监听、连接管理、JWT 验证 |
| [呼叫状态机](./sigserver/state-machine) | WebRTC 呼叫状态机、呼叫上下文 |
| [WebRTC 媒体协商](./sigserver/webrtc) | SDP 协商、ICE 候选交换 |

## 端口配置

| 协议 | 端口 | 说明 |
|------|------|------|
| WebSocket (WSS) | 5443 | WebRTC 信令（与 SIP WSS 共享端口，通过路径区分） |
| Metrics/Health | 5080 | Prometheus 指标 + 健康检查 |
| gRPC | 50052 | 作为 gRPC 客户端连接 medserver |
