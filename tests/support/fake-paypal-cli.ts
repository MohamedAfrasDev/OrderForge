// `npm run paypal:fake`: a local fake PayPal for the spike CLI and merchant dev page. Mocked, not the real sandbox.
import { startFakePayPal } from "./fake-paypal.ts";

const port = Number(process.env.FAKE_PAYPAL_PORT ?? 4010);
const fake = await startFakePayPal({ port });
console.log(`Fake PayPal (mocked, not the real sandbox) listening on ${fake.url}`);
console.log(`Run the spike against it with PAYPAL_SPIKE_BASE_URL=${fake.url}`);
