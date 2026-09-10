# config-server — 配置中心

> 配置管理应用单元

---

## 概述

config-server 是 NextSWITCH 的配置中心服务，负责：

- 配置存储与分发
- 配置热更新
- 配置版本管理
- 配置审计

## 依赖模块

| 模块 | 用途 | 关键组件 |
|------|------|----------|
| **nextswitch-core** | 核心基础 | 错误类型、日志追踪、工具函数 |
| **nextswitch-api** | gRPC | gRPC 服务端、配置服务 API 定义 |

## 模块依赖详情

### nextswitch-core

```rust
// 使用的核心组件
use nextswitch_core::error::{AppError, Result};
use nextswitch_core::tracing::init_tracing;
use nextswitch_core::metrics::{counter, histogram};
```

- **错误处理**：统一的 `AppError` 类型
- **日志追踪**：配置变更追踪
- **指标收集**：配置拉取统计

### nextswitch-api

```rust
// 使用的 API 组件（作为服务端）
use nextswitch_api::grpc::ConfigServiceServer;
use nextswitch_api::config::{
    // 配置获取
    GetConfigRequest, GetConfigResponse,
    WatchConfigRequest, ConfigUpdate,
    // 配置管理
    SetConfigRequest, ListConfigsRequest,
};
```

- **gRPC 服务端**：提供配置服务 API
- **配置获取**：按 key 获取配置
- **配置监听**：Watch 机制，配置变更实时推送
- **配置管理**：配置的增删改查

## 配置存储架构

```
┌─────────────────────────────────────────────────────────┐
│                    config-server                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   gRPC API  │    │  Watch 管理  │    │  版本管理   │ │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘ │
│         │                  │                  │         │
│         └──────────────────┼──────────────────┘         │
│                            │                            │
│                            ▼                            │
│                   ┌─────────────────┐                   │
│                   │   配置缓存层    │                   │
│                   │   (内存 + Redis) │                   │
│                   └────────┬────────┘                   │
│                            │                            │
└────────────────────────────┼────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │  Redis  │    │  MySQL  │    │  etcd   │
        │ (缓存)  │    │ (持久化) │    │ (可选)  │
        └─────────┘    └─────────┘    └─────────┘
```

## 相关文档

- [配置中心设计](/spec/config/config-and-gateway)
- [信令配置管理](/spec/config/signaling-config)
