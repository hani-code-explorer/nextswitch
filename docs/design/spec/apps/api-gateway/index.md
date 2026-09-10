# api-gateway — API 网关

> API 入口应用单元

---

## 概述

api-gateway 是 NextSWITCH 的 API 网关服务，负责：

- API 路由与转发
- 认证授权
- 限流熔断
- 请求日志

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、配置加载、工具函数 |
| **nextswitch-api** | HTTP/gRPC | HTTP 服务端、API 路由定义、认证中间件 |

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
- **配置加载**：路由规则、限流配置
- **日志追踪**：请求追踪、审计日志
- **指标收集**：请求统计、延迟分布

### nextswitch-api

```rust
// 使用的 API 组件
use nextswitch_api::http::{HttpServer, Router, Handler};
use nextswitch_api::auth::{JwtValidator, TokenInfo};
use nextswitch_api::middleware::{
    AuthMiddleware, RateLimitMiddleware, CorsMiddleware,
};
use nextswitch_api::proxy::{ProxyTarget, ReverseProxy};
```

- **HTTP 服务端**：RESTful API 入口
- **JWT 验证**：Token 验证与解析
- **中间件**：认证、限流、CORS
- **反向代理**：请求转发到后端服务

## 路由规则

| 路径前缀 | 目标服务 | 说明 |
|----------|----------|------|
| `/api/v1/calls` | cti-server | 呼叫控制 API |
| `/api/v1/agents` | cti-server | 坐席管理 API |
| `/api/v1/cdrs` | sipserver | CDR 查询 API |
| `/api/v1/config` | config-server | 配置管理 API |
| `/api/v1/monitoring` | 监控服务 | 监控数据 API |
| `/ws/im` | im-server | IM WebSocket |
| `/ws/cti` | cti-server | CTI WebSocket |

## 请求处理流程

```
Client Request
    │
    ▼
┌─────────────────────────────────────────┐
│ ① 中间件链                               │
│    ├─ CORS 处理                          │
│    ├─ 请求日志                           │
│    ├─ JWT 验证                           │
│    └─ 限流检查                           │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ② 路由匹配                               │
│    ├─ 路径前缀匹配                        │
│    └─ 选择目标服务                        │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ③ 反向代理                               │
│    ├─ 请求转发                           │
│    ├─ 响应处理                           │
│    └─ 错误处理                           │
└─────────────────────────────────────────┘
```

## 相关文档

- [API 网关设计](/spec/config/config-and-gateway)
