import { runConnectorSmoke } from '../../src/test-utils/connectorSmokeHarness';
import { slackCell } from './connectorSmokeCells';

runConnectorSmoke(slackCell);
