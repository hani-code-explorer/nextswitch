# nextswitch-core

> 核心基础库

---

## 概述

nextswitch-core 提供平台核心基础功能，被所有应用和服务依赖。

## 功能模块

### 错误处理

```rust
pub enum AppError {
    Config(ConfigError),
    Network(NetworkError),
    Database(DatabaseError),
    Auth(AuthError),
    Internal(InternalError),
}

pub type Result<T> = std::result::Result<T, AppError>;
```

- 统一的错误类型
- 错误链和上下文支持
- 错误码映射

### 配置加载

```rust
pub struct ConfigLoader {
    source: ConfigSource,
    cache: Arc<RwLock<Config>>,
}

impl ConfigLoader {
    pub async fn load<T: DeserializeOwned>(&self) -> Result<T>;
    pub async fn watch<F>(&self, callback: F) -> Result<()>
    where F: Fn(Config) + Send + 'static;
}
```

- 从 config-server 拉取配置
- 配置热更新监听
- 本地缓存

### 日志追踪

```rust
pub fn init_tracing(service_name: &str) -> TracingGuard;

#[instrument(skip_all)]
pub async fn handle_request(ctx: RequestContext) -> Result<()> {
    tracing::info!("processing request");
    // ...
}
```

- 结构化日志（tracing）
- 请求追踪 ID 传递
- 日志级别动态调整

### 指标收集

```rust
use metrics::{counter, histogram, gauge};

counter!("requests_total", "method" => "GET").increment(1);
histogram!("request_duration_seconds").record(elapsed.as_secs_f64());
gauge!("active_connections").set(count as f64);
```

- Prometheus 指标导出
- Counter、Histogram、Gauge 支持
- 标签过滤

## 被依赖方

| 应用 | 用途 |
|------|------|
| sipserver | 核心基础功能 |
| sigserver | 核心基础功能 |
| medserver | 核心基础功能 |
| cti-server | 核心基础功能 |
| im-server | 核心基础功能 |
| config-server | 核心基础功能 |
| api-gateway | 核心基础功能 |
