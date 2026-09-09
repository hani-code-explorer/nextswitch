use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallState {
    Idle,
    Ringing,
    Active,
    Held,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub caller: String,
    pub callee: String,
    pub state: CallState,
}

impl Call {
    pub fn new(id: impl Into<String>, caller: impl Into<String>, callee: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            caller: caller.into(),
            callee: callee.into(),
            state: CallState::Idle,
        }
    }
}
