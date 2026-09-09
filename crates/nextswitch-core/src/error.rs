use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("call not found: {0}")]
    CallNotFound(String),

    #[error("invalid state transition: {from} -> {to}")]
    InvalidStateTransition { from: String, to: String },

    #[error("internal error: {0}")]
    Internal(String),
}
