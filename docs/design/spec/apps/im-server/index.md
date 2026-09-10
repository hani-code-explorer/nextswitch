# im-server — IM 服务

> 即时通讯应用单元

---

## 概述

im-server 是 NextSWITCH 的即时通讯服务，负责：

- 消息收发与路由
- 在线状态管理
- 会话管理
- 消息持久化

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-api** | WebSocket | WebSocket 服务端、IM 消息协议 |

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
- **配置加载**：消息保留策略、存储配置
- **日志追踪**：消息流转追踪
- **指标收集**：消息统计、在线用户数

### nextswitch-api

```rust
// 使用的 API 组件
use nextswitch_api::websocket::{WsServer, WsConnection};
use nextswitch_api::im::{
    // 消息
    SendMessageRequest, MessageAck, ChatMessage,
    // 会话
    CreateSessionRequest, SessionInfo, SessionMember,
    // 状态
    PresenceUpdate, PresenceStatus,
};
```

- **WebSocket 服务端**：长连接管理
- **消息协议**：IM 消息格式定义
- **会话管理**：单聊、群聊会话
- **在线状态**：Presence 状态订阅与推送

## 消息类型

| 类型 | 说明 |
|------|------|
| `chat` | 普通文本消息 |
| `image` | 图片消息 |
| `file` | 文件消息 |
| `audio` | 语音消息 |
| `system` | 系统通知 |
| `call_event` | 通话事件通知 |

## 相关文档

- [IM 服务设计](/spec/application/im/design)
