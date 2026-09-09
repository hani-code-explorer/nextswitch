import { ApiClient } from './client';
import {
  QueueStatus,
  QueueDetail,
  QueueAgent,
  QueuedCall,
} from '../types';

export class QueueApi {
  constructor(private client: ApiClient) {}

  /**
   * List all queues with real-time status
   */
  async list(): Promise<QueueStatus[]> {
    return this.client.get<QueueStatus[]>('/queues');
  }

  /**
   * Get detailed queue information
   */
  async get(queueId: string): Promise<QueueDetail> {
    return this.client.get<QueueDetail>(`/queues/${queueId}`);
  }

  /**
   * Get agents in a queue
   */
  async getAgents(queueId: string): Promise<QueueAgent[]> {
    return this.client.get<QueueAgent[]>(`/queues/${queueId}/agents`);
  }

  /**
   * Get calls waiting in a queue
   */
  async getCalls(queueId: string): Promise<QueuedCall[]> {
    return this.client.get<QueuedCall[]>(`/queues/${queueId}/calls`);
  }
}
