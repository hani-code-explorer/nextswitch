import { ApiClient } from './client';
import {
  MakeCallRequest,
  HangupRequest,
  TransferRequest,
  ConferenceRequest,
  DtmfRequest,
  CallInfo,
  TransferType,
} from '../types';

export class CallApi {
  constructor(private client: ApiClient) {}

  /**
   * Make a new call
   */
  async make(request: MakeCallRequest): Promise<CallInfo> {
    return this.client.post<CallInfo>('/calls/make', request);
  }

  /**
   * Answer an incoming call
   */
  async answer(callId: string): Promise<CallInfo> {
    return this.client.post<CallInfo>(`/calls/${callId}/answer`);
  }

  /**
   * Hang up a call
   */
  async hangup(callId: string, request?: HangupRequest): Promise<void> {
    await this.client.post(`/calls/${callId}/hangup`, request);
  }

  /**
   * Put a call on hold
   */
  async hold(callId: string): Promise<CallInfo> {
    return this.client.post<CallInfo>(`/calls/${callId}/hold`);
  }

  /**
   * Resume a held call
   */
  async unhold(callId: string): Promise<CallInfo> {
    return this.client.post<CallInfo>(`/calls/${callId}/unhold`);
  }

  /**
   * Transfer a call
   */
  async transfer(callId: string, request: TransferRequest): Promise<CallInfo> {
    return this.client.post<CallInfo>(`/calls/${callId}/transfer`, request);
  }

  /**
   * Blind transfer a call
   */
  async blindTransfer(callId: string, target: string): Promise<CallInfo> {
    return this.transfer(callId, { target, type: TransferType.Blind });
  }

  /**
   * Consult transfer a call
   */
  async consultTransfer(callId: string, target: string, announce?: string): Promise<CallInfo> {
    return this.transfer(callId, { target, type: TransferType.Consult, announce });
  }

  /**
   * Merge calls into a conference
   */
  async conference(callId: string, otherCallId: string): Promise<CallInfo> {
    return this.client.post<CallInfo>(`/calls/${callId}/conference`, {
      otherCallId,
    } as ConferenceRequest);
  }

  /**
   * Send DTMF tones
   */
  async sendDtmf(callId: string, digits: string, duration?: number): Promise<void> {
    await this.client.post(`/calls/${callId}/dtmf`, { digits, duration } as DtmfRequest);
  }
}
