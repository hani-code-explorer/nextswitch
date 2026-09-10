# SIP 方法处理

---

## 1. 方法路由

```rust
pub struct MethodRouter {
    invite_handler: Arc<InviteHandler>,
    register_handler: Arc<RegisterHandler>,
    options_handler: Arc<OptionsHandler>,
    info_handler: Arc<InfoHandler>,
    refer_handler: Arc<ReferHandler>,
    notify_handler: Arc<NotifyHandler>,
    bye_handler: Arc<ByeHandler>,
    cancel_handler: Arc<CancelHandler>,
}

impl MethodRouter {
    pub async fn route(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        match msg.method() {
            Method::INVITE => self.invite_handler.handle(msg, ctx).await,
            Method::ACK => self.handle_ack(msg, ctx).await,
            Method::REGISTER => self.register_handler.handle(msg, ctx).await,
            Method::OPTIONS => self.options_handler.handle(msg, ctx).await,
            Method::INFO => self.info_handler.handle(msg, ctx).await,
            Method::REFER => self.refer_handler.handle(msg, ctx).await,
            Method::NOTIFY => self.notify_handler.handle(msg, ctx).await,
            Method::BYE => self.bye_handler.handle(msg, ctx).await,
            Method::CANCEL => self.cancel_handler.handle(msg, ctx).await,
            _ => {
                // 不支持的方法
                self.send_response(msg, StatusCode::METHOD_NOT_ALLOWED).await
            }
        }
    }
}
```

---

## 2. OPTIONS 处理（心跳探测）

OPTIONS 请求用于检测分机是否在线（心跳探测），以及获取对端能力信息。

```rust
pub struct OptionsHandler {
    registry: Arc<RedisRegistry>,
}

impl OptionsHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 检查目标是否在本地注册表
        let to_uri = msg.to().uri();
        let aor = format!("{}@{}", to_uri.user(), to_uri.host());
        
        match self.registry.lookup(&aor).await? {
            Some(reg) if reg.instance_id == ctx.instance_id => {
                // 目标在本实例，直接返回 200 OK
                let response = self.build_options_response(&msg, StatusCode::OK);
                self.send(response).await?;
                
                metrics::counter!("sip_options_total", "result" => "local_hit").increment(1);
            }
            Some(reg) => {
                // 目标在其他实例，转发 OPTIONS
                self.forward_to_instance(msg, &reg).await?;
                
                metrics::counter!("sip_options_total", "result" => "forwarded").increment(1);
            }
            None => {
                // 目标未注册，返回 404
                let response = self.build_options_response(&msg, StatusCode::NOT_FOUND);
                self.send(response).await?;
                
                metrics::counter!("sip_options_total", "result" => "not_found").increment(1);
            }
        }
        
        Ok(())
    }
    
    fn build_options_response(&self, request: &SipMessage, status: StatusCode) -> SipResponse {
        let mut response = SipResponse::new(status);
        
        // 复制必要头
        response.set_via(request.via());
        response.set_from(request.from());
        response.set_to(request.to());
        response.set_call_id(request.call_id());
        response.set_cseq(request.cseq());
        
        // 添加能力声明
        response.add_header("Allow", "INVITE, ACK, BYE, CANCEL, OPTIONS, INFO, REFER, NOTIFY, REGISTER");
        response.add_header("Accept", "application/sdp");
        response.add_header("Accept-Encoding", "gzip");
        response.add_header("Supported", "replaces, timer, path");
        
        // 添加 User-Agent
        response.add_header("User-Agent", "NextSWITCH/1.0");
        
        response
    }
}
```

---

## 3. INFO 处理（DTMF 中继）

INFO 请求用于在通话中传递 DTMF 信号（RFC 2976）。

```rust
pub struct InfoHandler {
    dialog_manager: Arc<DialogManager>,
}

impl InfoHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 提取 DTMF 信息
        let content_type = msg.content_type().ok_or(InfoError::NoContentType)?;
        
        if content_type == "application/dtmf-relay" {
            // RFC 2833 DTMF 中继
            let body = msg.body().ok_or(InfoError::NoBody)?;
            let dtmf = self.parse_dtmf_relay(body)?;
            
            // ② 查找关联的呼叫
            let call_id = msg.call_id();
            let dialog = self.dialog_manager.find_by_call_id(call_id).await;
            
            match dialog {
                Some(d) if d.state == DialogState::Confirmed => {
                    // ③ 转发 DTMF 到对端
                    // 如果是 B2BUA 模式，通过 medserver 转发
                    if let Some(media_session_id) = &d.media_session_id {
                        self.forward_dtmf_to_media(media_session_id, &dtmf).await?;
                    } else {
                        // 纯代理模式，转发 INFO 到对端
                        self.forward_info_to_peer(msg, &d).await?;
                    }
                    
                    // ④ 返回 200 OK
                    let response = self.build_info_response(&msg, StatusCode::OK);
                    self.send(response).await?;
                    
                    // ⑤ 通知 cti-server（如有监听）
                    self.notify_cti_dtmf(call_id, &dtmf).await;
                    
                    metrics::counter!("sip_info_dtmf_total").increment(1);
                }
                _ => {
                    // 找不到活跃呼叫，返回 481
                    let response = self.build_info_response(&msg, StatusCode::CALL_LEG_DOES_NOT_EXIST);
                    self.send(response).await?;
                }
            }
        } else {
            // 不支持的内容类型
            let response = self.build_info_response(&msg, StatusCode::UNSUPPORTED_MEDIA_TYPE);
            self.send(response).await?;
        }
        
        Ok(())
    }
    
    fn parse_dtmf_relay(&self, body: &str) -> Result<DtmfEvent, InfoError> {
        let mut signal = None;
        let mut duration = None;
        
        for line in body.lines() {
            if let Some((key, value)) = line.split_once('=') {
                match key.trim() {
                    "Signal" => signal = Some(value.trim().parse::<char>().map_err(|_| InfoError::InvalidSignal)?),
                    "Duration" => duration = Some(value.trim().parse::<u32>().map_err(|_| InfoError::InvalidDuration)?),
                    _ => {}
                }
            }
        }
        
        Ok(DtmfEvent {
            digit: signal.ok_or(InfoError::MissingSignal)?,
            duration_ms: duration.unwrap_or(160),
        })
    }
}

pub struct DtmfEvent {
    pub digit: char,
    pub duration_ms: u32,
}
```

---

## 4. REFER 处理（呼叫转接）

REFER 请求用于发起呼叫转接（盲转或咨询转）。

```rust
pub struct ReferHandler {
    proxy: Arc<ProxyModule>,
    dialog_manager: Arc<DialogManager>,
}

impl ReferHandler {
    pub async fn handle(&self, msg: SipMessage, ctx: RequestContext) -> Result<()> {
        // ① 提取 Refer-To 头
        let refer_to = msg.get_header("Refer-To").ok_or(ReferError::MissingReferTo)?;
        let target_uri = self.parse_refer_to(refer_to)?;
        
        // ② 检查转接权限
        let from_ext = self.extract_extension(msg.from())?;
        if !self.check_transfer_permission(&from_ext).await? {
            let response = self.build_refer_response(&msg, StatusCode::FORBIDDEN);
            self.send(response).await?;
            return Ok(());
        }
        
        // ③ 返回 202 Accepted（表示已接受转接请求）
        let response = self.build_refer_response(&msg, StatusCode::ACCEPTED);
        self.send(response).await?;
        
        // ④ 向目标发起新 INVITE
        let call_id = msg.call_id();
        let dialog = self.dialog_manager.find_by_call_id(call_id).await
            .ok_or(ReferError::DialogNotFound)?;
        
        // 创建新的呼叫上下文
        let new_ctx = CallContext {
            call_id: generate_call_id(),
            tenant_id: dialog.tenant_id,
            caller: from_ext.clone(),
            callee: target_uri.user().to_string(),
            ..Default::default()
        };
        
        // 发起新 INVITE
        let invite_result = self.proxy.handle_invite(new_ctx).await;
        
        // ⑤ 通过 NOTIFY 报告转接进度
        self.send_notify_progress(&dialog, StatusCode::TRYING).await;
        
        match invite_result {
            Ok(()) => {
                // 等待新呼叫应答
                // 应答后发送 BYE 给原主叫，完成盲转
                self.wait_and_complete_transfer(dialog, target_uri).await?;
            }
            Err(e) => {
                // 转接失败，通知转接方
                self.send_notify_progress(&dialog, StatusCode::SERVICE_UNAVAILABLE).await;
                metrics::counter!("sip_refer_failed_total").increment(1);
            }
        }
        
        Ok(())
    }
    
    async fn send_notify_progress(&self, dialog: &B2buaDialog, status: StatusCode) {
        let notify = self.build_notify(&dialog, status);
        self.send(notify).await.ok();
    }
    
    fn parse_refer_to(&self, header: &str) -> Result<SipUri, ReferError> {
        // 解析 Refer-To: <sip:1002@domain> 或 Refer-To: sip:1002@domain
        let uri_str = header.trim_start_matches('<').trim_end_matches('>');
        SipUri::parse(uri_str).map_err(|_| ReferError::InvalidUri)
    }
    
    async fn check_transfer_permission(&self, extension: &str) -> Result<bool> {
        // 从配置中检查分机是否有转接权限
        // 默认允许
        Ok(true)
    }
}
```
