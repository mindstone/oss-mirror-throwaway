import type { BuildContext } from '@core/services/contributionPrFormatter';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import type {
  ContributionFile,
  RelaySubmitRequest,
  RelaySubmitResponse,
  RelayStatusResponse,
} from '@shared/schemas/contributionRelay';

export interface ContributionRelaySubmitRequest {
  contribution: ConnectorContribution;
  files: readonly ContributionFile[];
  buildContext?: BuildContext;
  beforeSubmit?: (requestBody: RelaySubmitRequest) => void | Promise<void>;
}

export interface ContributionRelaySubmitResult {
  requestBody: RelaySubmitRequest;
  response: RelaySubmitResponse;
}

export interface ContributionPublishedEmailResult {
  sent: boolean;
  alreadySent?: boolean;
  reason?: 'no_session' | 'network_error' | 'server_error' | 'bad_response' | 'not_configured';
}

export interface ContributionRelayExtension {
  submit(request: ContributionRelaySubmitRequest): Promise<ContributionRelaySubmitResult>;
  refreshStatus(relayContributionId: string): Promise<RelayStatusResponse>;
  notifyPublished?(contribution: ConnectorContribution): Promise<ContributionPublishedEmailResult>;
}

let registeredContributionRelayExtension: ContributionRelayExtension | null = null;

export function registerContributionRelayExtension(ext: ContributionRelayExtension): void {
  registeredContributionRelayExtension = ext;
}

export function getContributionRelayExtension(): ContributionRelayExtension | null {
  return registeredContributionRelayExtension;
}
