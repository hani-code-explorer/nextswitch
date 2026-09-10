# NextSWITCH 信令服务器细化设计规格书（索引）

## 文档信息

| 字段 | 值 |
|------|-----|
| Version | 1.0.0 |
| Date | 2026-09-10 |
| Status | Draft |
| Supplements | signaling-server-design v2.0.0 |
| Cross-ref | media-server-design v3.0.0, routing-engine-design v2.0.0, config-and-gateway-design v2.0.0, platform-security-design v2.0.0 |

---

## 1. 概述

### 1.1 文档目的

本系列文档是 `signaling-server-design v2.0.0` 的细化补充，针对以下 7 个领域进行深入展开。每个领域独立成文，便于按需查阅和维护。

### 1.2 文档索引

| 编号 | 文档 | 内容 |
|------|------|------|
| 0 | [索引与附录](2026-09-10-signaling-00-index.md) | 文档索引、服务间消息格式参考、变更历史 |
| 1 | [服务交互设计](2026-09-10-signaling-01-interaction-design.md) | 信令服务器与平台内所有服务的交互协议、数据流、故障处理 |
| 2 | [SIP服务设计](2026-09-10-signaling-02-sipserver-design.md) | sipserver 内部模块的详细设计、数据结构、关键算法 |
| 3 | [WS/WSS 服务设计](2026-09-10-signaling-03-sigserver-design.md) | sigserver 内部模块的详细设计、WebRTC 媒体协商、状态机 |
| 4 | [medserver 接口设计](2026-09-10-signaling-04-medserver-interface.md) | sipserver/sigserver 调用 medserver gRPC API 的完整使用模式 |
| 5 | [监控设计](2026-09-10-signaling-05-monitoring-design.md) | 指标体系、追踪策略、告警规则、仪表板设计 |
| 6 | [配置管理设计](2026-09-10-signaling-06-config-design.md) | 配置加载、缓存策略、热更新机制、降级方案 |
| 7 | [安全设计](2026-09-10-signaling-07-security-design.md) | SIP 信令安全、服务间认证、通信加密、访问控制 |

### 1.3 服务定位回顾

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Web UI / 客户端                                │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS / WSS
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     nextswitch-api（API 网关）                         │
└────────┬──────────┬──────────┬──────────┬──────────┬────────────────┘
         │          │          │          │          │
         ▼          ▼          ▼          ▼          ▼
   ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
   │Auth      ││Config    ││CTI       ││IM        ││Monitor   │
   │Service   ││Service   ││Server    ││Server    ││Aggreg.   │
   └────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└──────────┘
        │           │           │           │
        │    ┌──────┴──────┐    │           │
        │    │             │    │           │
        ▼    ▼             ▼    ▼           │
   ┌──────────┐    ┌──────────┐             │
   │ sipserver │    │sigserver│            │
   │ (SIP)    │    │ (WebRTC)  │            │
   └────┬─────┘    └────┬─────┘            │
        │               │                   │
        └───────┬───────┘                   │
                │                           │
         ┌──────┴──────┐                    │
         │    Redis    │  共享注册表+Pub/Sub  │
         └──────┬──────┘                    │
                │                           │
         ┌──────┴──────┐                    │
         │router-server│  复杂路由           │
         └──────┬──────┘                    │
                │                           │
         ┌──────┴──────┐                    │
         │  medserver  │  媒体处理           │
         └─────────────┘                    │
```

---

## Appendix A: 服务间消息格式参考

### A.0 Redis Pub/Sub 频道清单

| 频道模式 | 发布方 | 订阅方 | 用途 |
|---------|--------|--------|------|
| `call:command:{instance_id}` | sigserver / cti-server | sipserver | 向 sipserver 发送呼叫指令（如发起 SIP INVITE） |
| `call:event:{instance_id}` | sipserver | sigserver / cti-server | 向 sigserver/cti-server 推送 SIP 事件（如 180 Ringing） |
| `config:{tenant_id}:{entity_type}` | config-service | sipserver, sigserver | 配置增量下发 |
| `cti:agent:{agent_id}:status` | cti-server | sipserver, sigserver | 坐席状态变更通知（如 ready/busy/offline） |

### A.0.1 Redis 服务注册表 Key 清单

| Key 模式 | 写入方 | 读取方 | TTL | 用途 |
|---------|--------|--------|-----|------|
| `svc:{service}:{instance_id}` | 所有服务实例 | 所有 gRPC 客户端 | 30s | 服务发现：端点地址、负载信息 |
| `heartbeat:{service}:{instance_id}` | 所有服务实例 | sipserver, sigserver | 30s | 实例存活检测、注册表清理 |

> 两个 key 由同一心跳协程通过 Redis pipeline 批量刷新，间隔 10s。`svc:` key 包含 gRPC/health 端点地址；`heartbeat:` key 仅用于存活判断。详见 [配置管理设计](2026-09-10-signaling-06-config-design.md) §6。

### A.1 Redis Pub/Sub 消息格式

#### 跨协议呼叫协调

```json
// call:command:{instance_id} — 向 sipserver 发送 SIP INVITE 指令
{
    "message_id": "uuid-v4",
    "timestamp": 1699999999000,
    "source_instance": "sigserver-01",
    "target_instance": "sipserver-02",
    "call_id": "abc123",
    "command": "invite",
    "payload": {
        "tenant_id": 1,
        "caller": "1001",
        "callee": "1002",
        "caller_name": "张三",
        "sdp_offer": "v=0\r\no=...",
        "headers": {
            "X-Tenant-Id": "1",
            "X-Call-Id": "abc123"
        }
    }
}
```

```json
// call:event:{instance_id} — 向 sigserver 推送 SIP 事件
{
    "message_id": "uuid-v4",
    "timestamp": 1699999999000,
    "source_instance": "sipserver-02",
    "call_id": "abc123",
    "event": "ringing",
    "payload": {
        "sip_status": 180,
        "sip_reason": "Ringing"
    }
}
```

#### 配置变更通知

```json
// config:{tenant_id}:{entity_type}
{
    "action": "update",
    "entity_type": "extensions",
    "entity_id": 12345,
    "tenant_id": 1,
    "version": 456,
    "timestamp": 1699999999000,
    "changed_by": "admin-user",
    "_signature": "a1b2c3d4e5f6..."
}
```

### A.2 CDR 记录格式

```json
{
    "cdr_id": "uuid-v4",
    "call_id": "abc123",
    "tenant_id": 1,
    "site_id": "us-east-1",
    "caller": "1001",
    "callee": "1002",
    "caller_name": "张三",
    "direction": "inbound",
    "start_time": "2026-09-10T10:00:00Z",
    "answer_time": "2026-09-10T10:00:05Z",
    "end_time": "2026-09-10T10:05:00Z",
    "duration_secs": 295,
    "ring_duration_secs": 5,
    "hangup_cause": "normal_clearing",
    "hangup_by": "caller",
    "sip_call_id": "sip-call-id-xyz",
    "from_instance": "sipserver-02",
    "to_instance": "sipserver-03",
    "media_session_id": "media-abc",
    "recorded": true,
    "recording_url": "/recordings/2026/09/10/media-abc.mp3",
    "quality": {
        "mos": 4.2,
        "packet_loss_pct": 0.1,
        "jitter_ms": 15
    }
}
```

---

## Appendix B: 变更历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-09-10 | 初始版本：细化信令服务器 7 大领域设计（拆分为独立文档） |
| 1.1.0 | 2026-09-10 | 服务发现：gRPC 对端地址从 TOML 静态配置改为 Redis 服务注册表缓存获取（`svc:{service}:{instance_id}`），新增 `ServiceDiscoveryCache` 组件，心跳协程同时写入注册表和存活 key |
