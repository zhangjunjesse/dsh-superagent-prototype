// Keep the DSH CLI's top-level await outside the plugin it loads.
import { launchGatewayFlowFixture } from './gateway-flow-fixture.mjs';
await launchGatewayFlowFixture();
