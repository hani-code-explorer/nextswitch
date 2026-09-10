# router-server — 路由服务（已废弃）

> **注意**：router-server 已不再作为独立服务部署。其路由决策逻辑已整合至信令服务器（sipserver/sigserver）本地执行。配置数据模型详见 [路由配置设计](/spec/application/routing/)。信令服务器通过 gRPC `ProcessCall` 与媒体服务器（medserver）协作完成呼叫处理。

---

## 历史说明

router-server 曾是 NextSWITCH 的路由决策服务，原负责：

- 呼叫路由规则匹配
- 号码变换
- 中继选择
- 路由策略执行

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-api** | gRPC 通信 | gRPC 服务端、路由服务 API 定义 |

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
- **配置加载**：路由规则配置、号码变换规则
- **日志追踪**：路由决策追踪
- **指标收集**：路由匹配统计、决策延迟

### nextswitch-api

```rust
// 使用的 API 组件（作为服务端）
use nextswitch_api::grpc::RoutingServiceServer;
use nextswitch_api::routing::{
    RouteRequest, RouteResponse,
    RouteDecision, RouteAction,
};
```

- **gRPC 服务端**：提供路由服务 API
- **路由决策 API**：接收路由请求，返回决策结果
- **路由类型**：Direct、Trunk、IVR、Queue 等

## 路由决策流程

```
RouteRequest
    │
    ▼
┌─────────────────────────────────────────┐
│ ① 加载路由规则                            │
│    ├─ 租户级规则                          │
│    ├─ 站点级规则                          │
│    └─ 全局规则                            │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ② 规则匹配                               │
│    ├─ 主叫号码匹配                        │
│    ├─ 被叫号码匹配                        │
│    ├─ 时间条件匹配                        │
│    └─ 优先级排序                          │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ③ 号码变换                               │
│    ├─ 前缀添加/删除                       │
│    ├─ 正则替换                            │
│    └─ 号码规范化                          │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ④ 返回决策                               │
│    ├─ Direct → 目标分机                   │
│    ├─ Trunk → 中继组                     │
│    ├─ Queue → ACD 队列                   │
│    ├─ IVR → IVR 流程                     │
│    └─ Deny → 拒绝                        │
└─────────────────────────────────────────┘
```

## 相关文档

- [路由引擎设计](/spec/application/routing/design)
