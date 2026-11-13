// Keep the CLI's top-level await outside the plugin module that it loads.
import { launchGatewayFixture } from './gateway-delivery-fixture.mjs';
await launchGatewayFixture();
