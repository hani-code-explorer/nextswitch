# NextSWITCH 设计文档索引

> 最后更新：2026-09-10 | 文档版本：v2.0.0

## 文档清单

| # | 文档 | 版本 | 职责 | 行数 |
|---|------|------|------|------|
| 1 | [平台安全设计](2026-09-09-platform-security-design.md) | v2.0.0 | 认证授权、服务间认证、等保三级合规、加密、审计 | ~2266 |
| 2 | [配置中心与 API 网关设计](2026-09-09-config-and-gateway-design.md) | v2.0.0 | 配置数据管理、API 网关代理、限流、Redis 命名空间总表 | ~2918 |
| 3 | [信令服务器设计](2026-09-09-signaling-server-design.md) | v2.0.0 | SIP 代理/注册、WebSocket/WebRTC 信令、呼叫流程、CDR | ~2770 |
| 4 | [媒体服务器设计](2026-09-09-media-server-design.md) | v2.0.0 | 音频处理管道、录音、会议、IVR、转码 | ~1364 |
| 5 | [路由引擎设计](2026-09-09-routing-engine-design.md) | v2.0.0 | 两层路由决策（快速规则 + 图引擎）、配置热加载 | ~1389 |
| 6 | [CTI 服务设计](2026-09-09-cti-service-design.md) | v2.0.0 | 坐席状态机、呼叫控制、ACD 分配、事件推送 | ~1052 |
| 7 | [IM 服务设计](2026-09-09-im-service-design.md) | v2.0.0 | 即时消息、全渠道接入、AI 集成、CTI 联动 | ~1619 |
| — | [CTI SDK OpenAPI 规范](cti-sdk-openapi-draft.yaml) | v2.0.0 | CTI REST API + WebSocket 机器可读规范 | ~1029 |

## 文档关系图

```
                          ┌───────────────────────┐
                          │  配置中心与 API 网关    │
                          │  (统一入口 :8080)       │
                          │  JWT + 权限 + 限流      │
                          └───────────┬───────────┘
                                      │ 代理
                    ┌─────────────────┼─────────────────┐
                    │                 │                   │
        ┌───────────▼──────┐ ┌───────▼────────┐ ┌───────▼────────┐
        │  平台安全设计      │ │  CTI 服务       │ │  IM 服务        │
        │  (认证/授权/加密)  │ │  (坐席/ACD)    │◄│  (消息/AI)      │
        └──────────────────┘ └───────┬────────┘ └───────┬────────┘
                                     │ gRPC              │ gRPC
                    ┌────────────────┼───────────────────┘
                    │                │
        ┌───────────▼──────┐ ┌──────▼─────────┐
        │  信令服务器        │ │  路由引擎       │
        │  (SIP/WebSocket) │─►│  (决策层)      │
        └───────┬──────────┘ └────────────────┘
                │ gRPC
        ┌───────▼──────────┐
        │  媒体服务器        │
        │  (录音/会议/IVR)  │
        └──────────────────┘
```

## 跨文档约定

### 统一端口分配

| 服务 | HTTP | 监控/健康 | gRPC | SIP | WebSocket | RTP |
|------|------|----------|------|-----|-----------|-----|
| sipserver | — | 9090 | 50051 | 5060-5061 | — | — |
| signalserver | — | 9091 | 50051 | — | 8443 | — |
| medserver | — | 9092 | 50051 | — | — | 10000-60000 |
| nextswitch-api | 8080 | 9093 | — | — | 8080 | — |
| auth-service | 8081 | 9094 | 50051 | — | — | — |
| config-service | 8082 | 9095 | 50051 | — | — | — |
| cti-server | 8083 | 9096 | 50051 | — | 8083 | — |
| im-server | 8084 | 9097 | 50051 | — | 8084 | — |
| router-server | — | 9098 | 50051 | — | — | — |

### 统一错误响应格式

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

### WebSocket 认证方式

| 服务 | 认证方式 | 原因 |
|------|---------|------|
| signalserver | URL 参数 `?token=<jwt>` | 长连接需立即绑定分机号 |
| cti-server | JSON-RPC 后置认证 | Agent SDK 需灵活认证流程 |
| im-server | JSON-RPC 后置认证 | 外部客户（Widget）认证方式不同 |
| nextswitch-api (监控) | URL 参数 `?token=<jwt>` | 与 signalserver 保持一致 |

### Redis Key 格式规范

- **心跳**：`heartbeat:{service}:{instance_id}`（如 `heartbeat:sipserver:sipserver-03`）
- **所有 tenant_id**：`BIGINT`（不使用 UUID 字符串）
- **所有 agent_id/queue_id 引用**：`BIGINT`（引用对应表的主键）

### 服务间通信协议

| 通信路径 | 协议 | 说明 |
|---------|------|------|
| API 网关 → 各服务 | HTTP 代理 | REST API 转发 |
| sipserver ↔ signalserver | Redis Pub/Sub | 信令协调 |
| sipserver/signalserver → router-server | gRPC | 路由决策请求 |
| sipserver/signalserver → medserver | gRPC | 媒体控制 |
| sipserver/signalserver ↔ cti-server | Redis Pub/Sub | 呼叫命令/事件 |
| cti-server → medserver | gRPC | 会议/录音 |
| cti-server → router-server | gRPC | 队列路由 |
| im-server → cti-server | gRPC | ACD 共享队列 |
| im-server → router-server | gRPC | IM 会话路由 |
| router-server → config-service | gRPC + Redis Pub/Sub | 初始加载 + 增量更新 |
| router-server → medserver | gRPC | IVR 提示/收号 |
| config-service → 所有服务 | Redis Pub/Sub | 配置变更通知 |

## 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| v2.0.0 | 2026-09-10 | **文档合并与冲突修复**：将 11 个文档合并为 7 个；修复 IM 表类型不一致（VARCHAR→BIGINT）；统一 heartbeat key 格式；修复安全补充索引引用错误；补全 Redis 命名空间附录；添加统一端口分配表；统一错误响应格式；消除 NATS 引用；明确路由职责分层 |
| v1.0.0 | 2026-09-09 | 初始版本：11 个独立设计文档 |
