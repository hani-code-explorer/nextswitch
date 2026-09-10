# Transport 层设计

---

## 1. 多协议监听

```rust
pub struct TransportLayer {
    listeners: Vec<Arc<dyn Transport>>,
    message_tx: mpsc::Sender<SipMessage>,
}

pub enum TransportProtocol {
    Udp,    // 默认，端口 5060
    Tcp,    // 端口 5060
    Tls,    // 端口 5061
    Wss,    // 端口 5443（WebSocket over TLS）
}

/// UDP 传输（高性能，无连接状态）
pub struct UdpTransport {
    socket: Arc<UdpSocket>,
    /// 多个 workers 共享 socket（SO_REUSEPORT）
    workers: Vec<JoinHandle<()>>,
}

/// TCP/TLS 传输（连接池管理）
pub struct TcpTransport {
    listener: TcpListener,
    connections: DashMap<SocketAddr, Arc<TcpConnection>>,
    max_connections: usize,
    idle_timeout: Duration,
}

impl TransportLayer {
    pub async fn start(&mut self, config: &TransportConfig) -> Result<()> {
        for bind in &config.binds {
            match bind.protocol {
                TransportProtocol::Udp => {
                    let udp = UdpTransport::bind(bind.addr, bind.port, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(udp));
                }
                TransportProtocol::Tcp => {
                    let tcp = TcpTransport::bind(bind.addr, bind.port, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(tcp));
                }
                TransportProtocol::Tls => {
                    let tls = TlsTransport::bind(bind.addr, bind.port, &bind.tls_config, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(tls));
                }
                TransportProtocol::Wss => {
                    let wss = WssTransport::bind(bind.addr, bind.port, &bind.tls_config, self.message_tx.clone()).await?;
                    self.listeners.push(Arc::new(wss));
                }
            }
        }
        Ok(())
    }
}
```

---

## 2. UDP Worker 模型

```
                    ┌──────────────────┐
                    │   UdpSocket      │
                    │  (SO_REUSEPORT)  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Worker 0 │  │ Worker 1 │  │ Worker N │
        │ (Tokio  │  │ (Tokio  │  │ (Tokio  │
        │  Task)  │  │  Task)  │  │  Task)  │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │              │              │
             └──────────────┼──────────────┘
                            │
                            ▼
                    ┌──────────────────┐
                    │  message_tx      │
                    │  (mpsc channel)  │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  SIP Pipeline    │
                    │  (Pre-Route →    │
                    │   Method Router  │
                    │   → Proxy)       │
                    └──────────────────┘
```

**Worker 数量**：默认 `num_cpus`，可通过配置调整。
