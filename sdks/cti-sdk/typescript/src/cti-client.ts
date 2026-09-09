import { ApiClient, ClientConfig } from './api/client';
import { AgentApi } from './api/agent';
import { CallApi } from './api/call';
import { QueueApi } from './api/queue';
import { EventSubscriber, WebSocketConfig } from './events/websocket';

export interface CtiClientConfig {
  baseUrl: string;
  token: string;
  wsUrl?: string;
  timeout?: number;
}

export class CtiClient {
  private apiClient: ApiClient;
  private eventSubscriber: EventSubscriber | null = null;

  public readonly agent: AgentApi;
  public readonly call: CallApi;
  public readonly queue: QueueApi;

  constructor(config: CtiClientConfig) {
    const clientConfig: ClientConfig = {
      baseUrl: config.baseUrl,
      token: config.token,
      timeout: config.timeout,
    };

    this.apiClient = new ApiClient(clientConfig);
    this.agent = new AgentApi(this.apiClient);
    this.call = new CallApi(this.apiClient);
    this.queue = new QueueApi(this.apiClient);

    // Initialize WebSocket if URL is provided
    if (config.wsUrl) {
      const wsConfig: WebSocketConfig = {
        url: config.wsUrl,
        token: config.token,
      };
      this.eventSubscriber = new EventSubscriber(wsConfig);
    }
  }

  /**
   * Connect to real-time event stream
   */
  async connectEvents(): Promise<void> {
    if (!this.eventSubscriber) {
      throw new Error('WebSocket URL not configured. Please provide wsUrl in CtiClientConfig.');
    }
    await this.eventSubscriber.connect();
  }

  /**
   * Disconnect from real-time event stream
   */
  disconnectEvents(): void {
    if (this.eventSubscriber) {
      this.eventSubscriber.disconnect();
    }
  }

  /**
   * Get event subscriber for subscribing to events
   */
  get events(): EventSubscriber {
    if (!this.eventSubscriber) {
      throw new Error('WebSocket URL not configured. Please provide wsUrl in CtiClientConfig.');
    }
    return this.eventSubscriber;
  }
}
