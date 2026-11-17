// Keep the CLI top-level await outside the plugin module it loads.
import { launchProcessRuntimeFixture } from './integration-fixture.mjs';
await launchProcessRuntimeFixture();
