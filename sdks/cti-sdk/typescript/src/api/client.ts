import axios, { AxiosInstance, AxiosError } from 'axios';
import { ErrorResponse } from '../types';

export interface ClientConfig {
  baseUrl: string;
  token: string;
  timeout?: number;
}

export class CtiApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CtiApiError';
  }

  static fromAxios(error: AxiosError<ErrorResponse>): CtiApiError {
    const response = error.response;
    if (response?.data) {
      return new CtiApiError(
        response.status,
        response.data.code,
        response.data.message,
        response.data.details
      );
    }
    return new CtiApiError(
      response?.status || 0,
      'UNKNOWN_ERROR',
      error.message
    );
  }
}

export class ApiClient {
  private client: AxiosInstance;

  constructor(config: ClientConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError<ErrorResponse>) => {
        throw CtiApiError.fromAxios(error);
      }
    );
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.client.get<T>(path, { params });
    return response.data;
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const response = await this.client.post<T>(path, data);
    return response.data;
  }

  async put<T>(path: string, data?: unknown): Promise<T> {
    const response = await this.client.put<T>(path, data);
    return response.data;
  }

  async delete<T>(path: string): Promise<T> {
    const response = await this.client.delete<T>(path);
    return response.data;
  }
}
