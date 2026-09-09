use rustrtc::{PeerConnection, RtcConfiguration, RtcConfigurationBuilder, TransportMode};
use tracing::debug;

#[derive(Debug, Clone)]
pub struct RtpSession {
    pub local_port: u16,
    pub remote_port: u16,
}

impl RtpSession {
    pub fn new(local_port: u16, remote_port: u16) -> Self {
        debug!(
            "creating RTP session local={} remote={}",
            local_port, remote_port
        );
        Self {
            local_port,
            remote_port,
        }
    }

    pub fn create_peer_connection(&self) -> PeerConnection {
        let config = RtcConfigurationBuilder::new()
            .transport_mode(TransportMode::Rtp)
            .rtp_port_range(self.local_port, self.local_port + 100)
            .build();
        PeerConnection::new(config)
    }
}

pub fn default_rtc_config() -> RtcConfiguration {
    RtcConfigurationBuilder::new()
        .transport_mode(TransportMode::Rtp)
        .build()
}
