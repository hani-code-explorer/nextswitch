import { CtiEvent, CtiEventType } from './types';

export type EventHandler<T = unknown> = (event: CtiEvent<T>) => void;

export interface WebSocketConfig {
  url: string;
  token: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

export class EventSubscriber {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private config: Required<WebSocketConfig>;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authenticated = false;
  private requestId = 0;
  private authResolve: (() => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnect: true,
      reconnectInterval: 5000,
      maxReconnectAttempts: 5,
      ...config,
    };
  }

  /**
   * Connect to WebSocket and authenticate
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authenticated = false;
      this.authResolve = null;
      this.authReject = null;

      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        console.log('[CTI SDK] WebSocket connected, authenticating...');
        this.authenticate()
          .then(() => {
            this.reconnectAttempts = 0;
            resolve();
          })
          .catch((error) => {
            this.ws?.close();
            reject(error);
          });
      };

      this.ws.onclose = (event) => {
        console.log('[CTI SDK] WebSocket closed:', event.code, event.reason);
        this.authenticated = false;
        if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('[CTI SDK] WebSocket error:', error);
        if (!this.authenticated) {
          reject(new Error('WebSocket connection failed'));
        }
      };

      this.ws.onmessage = (message) => {
        try {
          const data = JSON.parse(message.data);

          if (!this.authenticated) {
            this.handleAuthResponse(data);
            return;
          }

          const event = data as CtiEvent;
          this.dispatch(event);
        } catch (error) {
          console.error('[CTI SDK] Failed to parse message:', error);
        }
      };
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    this.handlers.clear();
  }

  /**
   * Subscribe to a specific event type
   */
  on<T = unknown>(eventType: CtiEventType | string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  /**
   * Subscribe to all events
   */
  onAny<T = unknown>(handler: EventHandler<T>): () => void {
    return this.on('*', handler);
  }

  /**
   * Check if connected and authenticated
   */
  isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'auth',
        params: { token: this.config.token },
        id: ++this.requestId,
      };

      this.ws?.send(JSON.stringify(request));
    });
  }

  private handleAuthResponse(data: JsonRpcResponse): void {
    if (data.id !== this.requestId) {
      console.warn('[CTI SDK] Received response with unexpected id:', data.id);
      return;
    }

    if (data.error) {
      const error = new Error(`Authentication failed: ${data.error.message}`);
      this.authReject?.(error);
      return;
    }

    if (data.result) {
      console.log('[CTI SDK] Authentication successful');
      this.authenticated = true;
      this.authResolve?.();
    }
  }

  private dispatch(event: CtiEvent): void {
    const handlers = this.handlers.get(event.event);
    if (handlers) {
      handlers.forEach((handler) => handler(event));
    }

    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((handler) => handler(event));
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    console.log(
      `[CTI SDK] Reconnecting in ${this.config.reconnectInterval}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('[CTI SDK] Reconnect failed:', error);
      });
    }, this.config.reconnectInterval);
  }
}
