# 平台架构

本文档描述 NextSWITCH 平台的整体架构约定，包括端口分配、错误格式、认证方式和 Redis 命名空间规范。

## 统一端口分配

| 服务 | HTTP | 监控/健康 | gRPC | SIP | WebSocket | RTP |
|------|------|----------|------|-----|-----------|-----|
| sipserver | — | 9090 | 50051 | 5060-5061 | — | — |
| sigserver | — | 5080 | 50051 | — | 5443 | — |
| medserver | — | 9092 | 50051 | — | — | 10000-60000 |
| nextswitch-api | 8080 | 9093 | — | — | 8080 | — |
| auth-service | 8081 | 9094 | 50051 | — | — | — |
| config-service | 8082 | 9095 | 50051 | — | — | — |
| cti-server | 8083 | 9096 | 50051 | — | 8083 | — |
| im-server | 8084 | 9097 | 50051 | — | 8084 | — |

## 统一错误响应格式

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": [
      { "field": "field_name", "message": "detail" }
    ],
    "request_id": "req-uuid-v4"
  }
}
```

> `request_id` 由 API 网关自动注入。

## WebSocket 认证方式

| 服务 | 认证方式 | 原因 |
|------|---------|------|
| sigserver | URL 参数 `?token=&lt;jwt&gt;` | 长连接需立即绑定分机号 |
| cti-server | JSON-RPC 后置认证 | Agent SDK 需灵活认证流程 |
| im-server | JSON-RPC 后置认证 | 外部客户（Widget）认证方式不同 |
| nextswitch-api (监控) | URL 参数 `?token=&lt;jwt&gt;` | 与 sigserver 保持一致 |

## Redis Key 格式规范

- **心跳**：`heartbeat:{service}:{instance_id}`（如 `heartbeat:sipserver:sipserver-03`）
- **所有 tenant_id**：`BIGINT`（不使用 UUID 字符串）
- **所有 agent_id/queue_id 引用**：`BIGINT`（引用对应表的主键）

## 服务间通信协议

| 通信路径 | 协议 | 说明 |
|---------|------|------|
| API 网关 → 各服务 | HTTP 代理 | REST API 转发 |
| sipserver ↔ sigserver | Redis Pub/Sub | SIP 信令 ↔ WS/WSS 信令跨协议协调 |
| sipserver/sigserver → medserver | gRPC | ProcessCall 呼叫处理（含路由决策后的媒体处理） |
| sipserver/sigserver ↔ cti-server | Redis Pub/Sub | 呼叫命令/事件 |
| cti-server → medserver | gRPC | 会议/录音 |
| im-server → cti-server | gRPC | ACD 共享队列 |
| config-service → 所有服务 | Redis Pub/Sub | 配置变更通知 |
