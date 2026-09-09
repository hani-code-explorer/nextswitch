use tracing::debug;

#[derive(Debug, Clone, Copy)]
pub struct RtpSession {
    pub local_port: u16,
    pub remote_port: u16,
}

impl RtpSession {
    pub fn new(local_port: u16, remote_port: u16) -> Self {
        debug!("creating RTP session local={} remote={}", local_port, remote_port);
        Self { local_port, remote_port }
    }
}
