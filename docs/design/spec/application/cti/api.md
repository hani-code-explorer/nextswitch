# CTI SDK OpenAPI 规范

CTI（Computer Telephony Integration）API 的 OpenAPI 3.0 规范定义。

## 概述

CTI API 提供呼叫中心坐席控制和呼叫管理功能，支持：

- 坐席状态管理（签入/签出/状态变更）
- 呼叫控制（拨号/应答/转接/会议/保持）
- 实时事件订阅（WebSocket）
- 队列监控与统计

## 认证

所有 REST API 请求需要在 Header 中携带 JWT Token：

```
Authorization: Bearer &lt;access_token&gt;
```

## WebSocket 事件订阅

实时事件通过 WebSocket 推送，连接地址：`wss://{host}/api/v1/cti/events`

认证通过连接后的 JSON-RPC 2.0 握手完成（不在 URL 中传递 token）。

## OpenAPI 规范

<<< ./cti-sdk-openapi.yaml
