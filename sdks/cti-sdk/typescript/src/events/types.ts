/**
 * Event types for CTI WebSocket events
 */

export enum CtiEventType {
  // Agent events
  AgentSignedIn = 'agent.signed_in',
  AgentSignedOut = 'agent.signed_out',
  AgentStateChanged = 'agent.state_changed',

  // Call events
  CallRinging = 'call.ringing',
  CallAnswered = 'call.answered',
  CallHeld = 'call.held',
  CallUnheld = 'call.unheld',
  CallTransferred = 'call.transferred',
  CallConferenced = 'call.conferenced',
  CallTerminated = 'call.terminated',

  // Queue events
  QueueCallQueued = 'queue.call_queued',
  QueueCallDequeued = 'queue.call_dequeued',
  QueueStatsUpdated = 'queue.stats_updated',
}

export interface CtiEvent<T = unknown> {
  event: CtiEventType | string;
  data: T;
  timestamp: string;
  correlationId?: string;
}

// Agent event data types
export interface AgentSignedInData {
  agentId: string;
  skillGroups: string[];
  signedInAt: string;
}

export interface AgentSignedOutData {
  agentId: string;
  reason?: string;
  signedOutAt: string;
}

export interface AgentStateChangedData {
  agentId: string;
  previousState: string;
  currentState: string;
  callId?: string;
  reason?: string;
}

// Call event data types
export interface CallRingingData {
  callId: string;
  caller: string;
  callee: string;
  direction: 'inbound' | 'outbound' | 'internal';
  queueId?: string;
  agentId?: string;
}

export interface CallAnsweredData {
  callId: string;
  agentId: string;
  answeredAt: string;
}

export interface CallHeldData {
  callId: string;
  heldAt: string;
}

export interface CallUnheldData {
  callId: string;
  unheldAt: string;
}

export interface CallTransferredData {
  callId: string;
  fromAgentId?: string;
  toAgentId?: string;
  toQueueId?: string;
  transferType: 'blind' | 'consult';
}

export interface CallConferencedData {
  callId: string;
  conferenceId: string;
  participants: string[];
}

export interface CallTerminatedData {
  callId: string;
  reason?: string;
  duration: number;
}

// Queue event data types
export interface QueueCallQueuedData {
  callId: string;
  queueId: string;
  caller: string;
  position: number;
  queuedAt: string;
}

export interface QueueCallDequeuedData {
  callId: string;
  queueId: string;
  reason: 'answered' | 'abandoned' | 'transferred';
  agentId?: string;
  waitTime: number;
}

export interface QueueStatsUpdatedData {
  queueId: string;
  waitingCalls: number;
  availableAgents: number;
  longestWaitTime: number;
  estimatedWaitTime: number;
}
