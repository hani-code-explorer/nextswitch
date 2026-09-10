# nextswitch-sip

> SIP 协议库

---

## 概述

nextswitch-sip 提供 SIP 协议处理功能，主要用于 SIP 信令服务和 WebRTC 媒体协商。

## 功能模块

### SIP 消息解析

```rust
pub struct SipParser;

impl SipParser {
    pub fn parse_request(data: &[u8]) -> Result<SipRequest>;
    pub fn parse_response(data: &[u8]) -> Result<SipResponse>;
}

pub struct SipRequest {
    pub method: Method,
    pub uri: SipUri,
    pub headers: Headers,
    pub body: Option<Bytes>,
}
```

- 高性能 SIP 消息解析
- 支持 UDP/TCP 流式解析
- 零拷贝优化

### SIP 头处理

```rust
pub struct Headers {
    via: Vec<Via>,
    from: From,
    to: To,
    call_id: CallId,
    cseq: CSeq,
    contact: Option<Contact>,
    // ... 更多头
}

impl Headers {
    pub fn add_via(&mut self, via: Via);
    pub fn set_from(&mut self, from: From);
    pub fn get_contact(&self) -> Option<&Contact>;
}
```

- SIP 头构建与修改
- Via 头链管理
- 自定义头支持

### SIP URI 处理

```rust
pub struct SipUri {
    pub scheme: UriScheme,  // sip, sips
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub params: UriParams,
}

impl SipUri {
    pub fn parse(s: &str) -> Result<SipUri>;
    pub fn to_string(&self) -> String;
    pub fn normalize(&mut self);
}
```

- SIP URI 解析
- URI 规范化
- 参数处理

### SDP 处理

```rust
pub struct SdpParser;

impl SdpParser {
    pub fn parse(data: &str) -> Result<SdpSession>;
}

pub struct SdpSession {
    pub origin: Origin,
    pub connection: Option<Connection>,
    pub media: Vec<MediaDescription>,
    pub attributes: Vec<Attribute>,
}

pub struct SdpOffer {
    pub session: SdpSession,
    pub ice_candidates: Vec<IceCandidate>,
}

pub struct SdpAnswer {
    pub session: SdpSession,
    pub ice_candidates: Vec<IceCandidate>,
}
```

- SDP offer/answer 解析
- ICE candidate 处理
- DTLS fingerprint 提取
- WebRTC 支持

## 被依赖方

| 应用 | 用途 |
|------|------|
| sipserver | SIP 消息解析、头处理、URI 处理 |
| sigserver | SDP 解析（WebRTC 媒体协商） |
