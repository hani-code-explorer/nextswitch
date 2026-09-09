/**
 * Agent status enumeration
 */
export enum AgentStatus {
  SignedOut = 'signed_out',
  Ready = 'ready',
  NotReady = 'not_ready',
  Busy = 'busy',
  WrapUp = 'wrap_up',
  Break = 'break',
  Monitoring = 'monitoring',
  Training = 'training',
}

/**
 * Call state enumeration
 */
export enum CallState {
  Initiating = 'initiating',
  Ringing = 'ringing',
  Active = 'active',
  Held = 'held',
  Conferencing = 'conferencing',
  Terminated = 'terminated',
}

/**
 * Call direction enumeration
 */
export enum CallDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
  Internal = 'internal',
}

/**
 * Transfer type enumeration
 */
export enum TransferType {
  Blind = 'blind',
  Consult = 'consult',
}

// Request types
export interface AgentSignInRequest {
  agentId: string;
  skillGroups: string[];
  initialState?: 'ready' | 'not_ready';
}

export interface AgentSignOutRequest {
  reason?: string;
}

export interface ChangeAgentStateRequest {
  status: AgentStatus;
  reason?: string;
  duration?: number;
}

export interface ForceAgentStateRequest {
  status: AgentStatus;
  reason?: string;
  notifyAgent?: boolean;
}

export interface MakeCallRequest {
  callee: string;
  callerId?: string;
  headers?: Record<string, string>;
}

export interface HangupRequest {
  reason?: string;
}

export interface TransferRequest {
  target: string;
  type: TransferType;
  announce?: string;
}

export interface ConferenceRequest {
  otherCallId: string;
}

export interface DtmfRequest {
  digits: string;
  duration?: number;
}

// Response types
export interface AgentSignInResponse {
  agentId: string;
  status: AgentStatus;
  signedInAt: string;
  skillGroups: string[];
}

export interface AgentStatusResponse {
  agentId: string;
  status: AgentStatus;
  statusReason?: string;
  changedAt: string;
}

export interface AgentStatusDetail {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  statusReason?: string;
  signedInAt?: string;
  statusChangedAt?: string;
  skillGroups: string[];
  currentCallId?: string | null;
}

export interface CallInfo {
  callId: string;
  caller: string;
  callee: string;
  state: CallState;
  direction: CallDirection;
  agentId?: string;
  queueId?: string | null;
  startedAt: string;
  answeredAt?: string | null;
}

export interface QueueStatus {
  queueId: string;
  queueName: string;
  waitingCalls: number;
  availableAgents: number;
  busyAgents: number;
  longestWaitTime: number;
  estimatedWaitTime: number;
}

export interface QueueDetail extends QueueStatus {
  skillGroups: string[];
  notReadyAgents: number;
  totalCallsToday: number;
  answeredCallsToday: number;
  abandonedCallsToday: number;
  averageWaitTimeToday: number;
  averageTalkTimeToday: number;
}

export interface QueueAgent {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  currentCallId?: string | null;
  statusDuration: number;
}

export interface QueuedCall {
  callId: string;
  caller: string;
  queuePosition: number;
  waitTime: number;
  priority: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
