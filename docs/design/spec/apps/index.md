# 应用设计

> 部署应用单元设计文档索引

---

## 概述

本节包含 NextSWITCH 平台所有可部署应用单元的设计文档。每个应用独立部署、独立扩缩容，通过 gRPC 进行服务间通信。

## 应用列表

| 应用 | 说明 | 文档 |
|------|------|------|
| sipserver | SIP 信令服务 | [查看](./sipserver/) |
| sigserver | WS/WSS 信令服务 | [查看](./sigserver/) |
| medserver | 媒体服务 | [查看](./medserver/) |
| cti-server | CTI 服务 | [查看](./cti-server/) |
| im-server | IM 服务 | [查看](./im-server/) |
| config-server | 配置中心 | [查看](./config-server/) |
| api-gateway | API 网关 | [查看](./api-gateway/) |
