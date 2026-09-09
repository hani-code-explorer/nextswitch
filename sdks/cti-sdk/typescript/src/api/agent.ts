import { ApiClient } from './client';
import {
  AgentSignInRequest,
  AgentSignInResponse,
  AgentSignOutRequest,
  AgentStatusResponse,
  AgentStatusDetail,
  ChangeAgentStateRequest,
  ForceAgentStateRequest,
  AgentStatus,
} from '../types';

export class AgentApi {
  constructor(private client: ApiClient) {}

  /**
   * Sign in agent to the CTI system
   */
  async signIn(request: AgentSignInRequest): Promise<AgentSignInResponse> {
    return this.client.post<AgentSignInResponse>('/agents/signin', request);
  }

  /**
   * Sign out agent from the CTI system
   */
  async signOut(request?: AgentSignOutRequest): Promise<AgentStatusResponse> {
    return this.client.post<AgentStatusResponse>('/agents/signout', request);
  }

  /**
   * Get current agent status
   */
  async getStatus(): Promise<AgentStatusDetail> {
    return this.client.get<AgentStatusDetail>('/agents/status');
  }

  /**
   * Change agent state
   */
  async changeState(request: ChangeAgentStateRequest): Promise<AgentStatusResponse> {
    return this.client.put<AgentStatusResponse>('/agents/state', request);
  }

  /**
   * Force change agent state (supervisor only)
   */
  async forceState(agentId: string, request: ForceAgentStateRequest): Promise<AgentStatusResponse> {
    return this.client.post<AgentStatusResponse>(`/agents/${agentId}/force-state`, request);
  }

  /**
   * Set agent to ready state
   */
  async setReady(reason?: string): Promise<AgentStatusResponse> {
    return this.changeState({ status: AgentStatus.Ready, reason });
  }

  /**
   * Set agent to not ready state
   */
  async setNotReady(reason?: string): Promise<AgentStatusResponse> {
    return this.changeState({ status: AgentStatus.NotReady, reason });
  }

  /**
   * Set agent to break state
   */
  async setBreak(reason?: string, duration?: number): Promise<AgentStatusResponse> {
    return this.changeState({ status: AgentStatus.Break, reason, duration });
  }

  /**
   * Set agent to wrap-up state
   */
  async setWrapUp(reason?: string): Promise<AgentStatusResponse> {
    return this.changeState({ status: AgentStatus.WrapUp, reason });
  }
}
