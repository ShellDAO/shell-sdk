import { createShellProvider } from '../../dist/index.js';

type Witnesses = Awaited<ReturnType<ReturnType<typeof createShellProvider>['getBlockWitnesses']>>;
const missing: Witnesses = null;
declare const result: Witnesses;
// @ts-expect-error Availability must be checked before reading witness fields.
void result.witnessCount;
if (result !== null) void result.witnessCount;
void missing;
