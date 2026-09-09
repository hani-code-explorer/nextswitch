use rsipstack::sip::{Method, StatusCode};
use rsipstack::transport::TransportLayer;
use rsipstack::EndpointBuilder;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("nextswitch-sip starting");

    let cancel_token = CancellationToken::new();
    let transport_layer = TransportLayer::new(cancel_token.clone());

    let endpoint = EndpointBuilder::new()
        .with_transport_layer(transport_layer)
        .with_cancel_token(cancel_token.clone())
        .build();

    let endpoint_inner = endpoint.inner.clone();
    tokio::spawn(async move {
        if let Err(e) = endpoint_inner.serve().await {
            warn!("endpoint serve error: {}", e);
        }
    });

    info!("SIP endpoint initialized, waiting for incoming requests");

    let mut incoming = endpoint.incoming_transactions()?;
    while let Some(mut transaction) = incoming.recv().await {
        let method = transaction.original.method;
        info!("received SIP request: {}", method);

        match method {
            Method::Register => {
                info!("handling REGISTER");
                let _ = transaction.reply(StatusCode::OK).await;
            }
            Method::Options => {
                let _ = transaction.reply(StatusCode::OK).await;
            }
            Method::Invite => {
                info!("handling INVITE");
            }
            _ => {
                let _ = transaction.reply(StatusCode::MethodNotAllowed).await;
            }
        }
    }

    Ok(())
}
