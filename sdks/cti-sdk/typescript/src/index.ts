// Main client
export { CtiClient, CtiClientConfig } from './cti-client';

// API classes
export { AgentApi } from './api/agent';
export { CallApi } from './api/call';
export { QueueApi } from './api/queue';
export { ApiClient, CtiApiError, ClientConfig } from './api/client';

// Event handling
export { EventSubscriber, WebSocketConfig, EventHandler } from './events/websocket';
export {
  CtiEventType,
  CtiEvent,
  AgentSignedInData,
  AgentSignedOutData,
  AgentStateChangedData,
  CallRingingData,
  CallAnsweredData,
  CallHeldData,
  CallUnheldData,
  CallTransferredData,
  CallConferencedData,
  CallTerminatedData,
  QueueCallQueuedData,
  QueueCallDequeuedData,
  QueueStatsUpdatedData,
} from './events/types';

// Types
export {
  AgentStatus,
  CallState,
  CallDirection,
  TransferType,
  AgentSignInRequest,
  AgentSignOutRequest,
  ChangeAgentStateRequest,
  ForceAgentStateRequest,
  MakeCallRequest,
  HangupRequest,
  TransferRequest,
  ConferenceRequest,
  DtmfRequest,
  AgentSignInResponse,
  AgentStatusResponse,
  AgentStatusDetail,
  CallInfo,
  QueueStatus,
  QueueDetail,
  QueueAgent,
  QueuedCall,
  ErrorResponse,
} from './types';
