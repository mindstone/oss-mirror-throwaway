export interface DisableRefreshSmokeFake {
  readonly provider: 'google' | 'slack' | 'hubspot' | 'microsoft';
  readonly baseUrl: string;
  getRefreshCallCount(): number;
  getApiCallCount(): number;
  getUnexpectedRequests(): string[];
  resetCounters(): void;
  close(): Promise<void>;
}
