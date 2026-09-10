# cti-server — CTI 服务

> 计算机电话集成应用单元

---

## 概述

cti-server 是 NextSWITCH 的 CTI 服务，负责：

- 坐席状态管理
- ACD 排队分配
- 呼叫控制 API
- 事件通知推送

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-api** | gRPC/WebSocket | gRPC 服务端、WebSocket 推送、CTI API 定义 |

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
- **配置加载**：ACD 策略、队列配置
- **日志追踪**：坐席操作追踪
- **指标收集**：排队统计、坐席状态统计

### nextswitch-api

```rust
// 使用的 API 组件
use nextswitch_api::grpc::CtiServiceServer;
use nextswitch_api::cti::{
    // 呼叫控制
    MakeCallRequest, TransferRequest, HoldRequest, ConferenceRequest,
    // 坐席管理
    AgentLoginRequest, AgentReadyRequest, AgentStateChange,
    // 事件推送
    CtiEvent, CtiEventStream,
};
use nextswitch_api::websocket::{WsPushServer, PushMessage};
```

- **gRPC 服务端**：提供 CTI 控制 API
- **WebSocket 推送**：实时事件推送到前端
- **呼叫控制**：发起呼叫、转接、保持、会议
- **坐席管理**：登录/登出、状态切换、技能组

## 坐席状态机

```
              ┌─────────┐
              │  Idle   │
              └────┬────┘
                   │
            agent_login
                   │
                   ▼
             ┌──────────┐
        ┌────│  Ready   │────┐
        │    └──────────┘    │
        │                    │
   call_assigned       pause_request
        │                    │
        ▼                    ▼
   ┌──────────┐       ┌──────────┐
   │  Busy    │       │  Paused  │
   └────┬─────┘       └────┬─────┘
        │                  │
    call_ended        resume_request
        │                  │
        └────────┬─────────┘
                 │
                 ▼
           ┌──────────┐
           │  Ready   │
           └──────────┘
```

## 相关文档

- [CTI 服务设计](/spec/application/cti/design)
- [CTI API 规范](/spec/application/cti/api)
