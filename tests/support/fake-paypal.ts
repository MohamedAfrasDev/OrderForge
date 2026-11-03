// A small in-memory stand-in for the PayPal sandbox endpoints OrderForge uses. It exists so the
// spike, its tests and the E2E suite can run without credentials or network. Anything produced
// through it is labeled "mocked": it proves our wiring, never PayPal's real behaviour.
//
// Keep to erasable TypeScript (no enums or parameter properties): `npm run paypal:fake` runs
// tests/support/fake-paypal-cli.ts, which imports this file, with Node's --experimental-strip-types.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

type Order = { id: string; status: string; amount: string; authorizationId?: string };
type Authorization = { id: string; orderId: string; status: string; amount: string; captureId?: string };
type Capture = { id: string; authorizationId: string; status: string; amount: string };

export type Injection =
  | { type: "status"; status: number; body?: unknown }
  | { type: "hang" }
  | { type: "drop-before" }
  /** The request is processed normally, then the connection dies before the answer is sent. */
  | { type: "drop-after" };

export type LoggedRequest = { method: string; path: string; requestId?: string; body: unknown };

export type FakePayPal = {
  url: string;
  port: number;
  requests: LoggedRequest[];
  orders: Map<string, Order>;
  authorizations: Map<string, Authorization>;
  captures: Map<string, Capture>;
  approve: (orderId: string) => boolean;
  /** One-shot fault for the next request whose "METHOD /path" contains `match`. */
  inject: (match: string, injection: Injection) => void;
  close: () => Promise<void>;
};

const FAKE_TOKEN = "fake-access-token";
export const FAKE_PAYEE = "FAKEMERCHANT1";

/** The only request fields the fake reads. */
type RequestBody =
  | {
      intent?: string;
      purchase_units?: Array<{ amount?: { currency_code?: string; value?: string } }>;
      amount?: { value?: string };
    }
  | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakePayPal(options: { port?: number } = {}): Promise<FakePayPal> {
  const orders = new Map<string, Order>();
  const authorizations = new Map<string, Authorization>();
  const captures = new Map<string, Capture>();
  const requests: LoggedRequest[] = [];
  const injections: Array<{ match: string; injection: Injection }> = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  // Start somewhere random so ids stay unique across runs that share one database.
  let counter = Math.floor(Math.random() * 1e8) * 100;

  const error = (status: number, name: string, issue: string) => ({
    status,
    body: { name, message: issue, debug_id: `fake-debug-${++counter}`, details: [{ issue }] },
  });

  function respond(res: ServerResponse, status: number, body?: unknown) {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  function route(method: string, path: string, body: RequestBody, prefer: string | undefined): { status: number; body?: unknown } {
    if (method === "POST" && path === "/v2/checkout/orders") {
      const unit = body?.purchase_units?.[0];
      const amount = unit?.amount;
      const value = amount?.value ?? "";
      if (body?.intent !== "AUTHORIZE" || amount?.currency_code !== "USD" || !/^\d+\.\d{2}$/.test(value)) {
        return error(422, "UNPROCESSABLE_ENTITY", "INVALID_REQUEST");
      }
      const id = `FAKEORDER${++counter}`;
      orders.set(id, { id, status: "CREATED", amount: value });
      return {
        status: 201,
        body: {
          id,
          status: "CREATED",
          links: [
            { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}` },
            { rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
          ],
        },
      };
    }

    let m = /^\/v2\/checkout\/orders\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && m) {
      const order = orders.get(m[1]);
      if (!order) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      return { status: 200, body: orderBody(order) };
    }

    m = /^\/v2\/checkout\/orders\/([A-Za-z0-9_-]+)\/authorize$/.exec(path);
    if (method === "POST" && m) {
      const order = orders.get(m[1]);
      if (!order) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (order.authorizationId) return error(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED");
      if (order.status !== "APPROVED") return error(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED");
      const id = `FAKEAUTH${++counter}`;
      authorizations.set(id, { id, orderId: order.id, status: "CREATED", amount: order.amount });
      order.authorizationId = id;
      order.status = "COMPLETED";
      return { status: 201, body: orderBody(order) };
    }

    m = /^\/v2\/payments\/authorizations\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && m) {
      const auth = authorizations.get(m[1]);
      return auth ? { status: 200, body: authBody(auth) } : error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }

    m = /^\/v2\/payments\/authorizations\/([A-Za-z0-9_-]+)\/capture$/.exec(path);
    if (method === "POST" && m) {
      const auth = authorizations.get(m[1]);
      if (!auth) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (auth.status === "CAPTURED") return error(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED");
      if (auth.status === "VOIDED") return error(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED");
      const value = body?.amount?.value ?? auth.amount;
      if (Number(value) > Number(auth.amount)) return error(422, "UNPROCESSABLE_ENTITY", "CAPTURE_AMOUNT_EXCEEDS_AUTHORIZED");
      const id = `FAKECAP${++counter}`;
      captures.set(id, { id, authorizationId: auth.id, status: "COMPLETED", amount: value });
      auth.status = "CAPTURED";
      auth.captureId = id;
      return { status: 201, body: captureBody(captures.get(id)!) };
    }

    m = /^\/v2\/payments\/authorizations\/([A-Za-z0-9_-]+)\/void$/.exec(path);
    if (method === "POST" && m) {
      const auth = authorizations.get(m[1]);
      if (!auth) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      // Observed on the real sandbox (T21): voiding a captured authorization is HTTP 422 PREVIOUSLY_CAPTURED.
      if (auth.status === "CAPTURED") return error(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED");
      if (auth.status === "VOIDED") return error(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED");
      auth.status = "VOIDED";
      return prefer?.includes("return=representation") ? { status: 200, body: authBody(auth) } : { status: 204 };
    }

    m = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && m) {
      const cap = captures.get(m[1]);
      return cap ? { status: 200, body: captureBody(cap) } : error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }

    return error(404, "RESOURCE_NOT_FOUND", "NOT_FOUND");
  }

  const money = (value: string) => ({ currency_code: "USD", value });
  const orderBody = (o: Order) => ({
    id: o.id,
    status: o.status,
    purchase_units: [
      {
        payee: { merchant_id: FAKE_PAYEE },
        payments: o.authorizationId
          ? {
              authorizations: [{ id: o.authorizationId, status: authorizations.get(o.authorizationId)!.status, amount: money(o.amount) }],
              captures: authorizations.get(o.authorizationId)!.captureId ? [{ id: authorizations.get(o.authorizationId)!.captureId }] : [],
            }
          : {},
      },
    ],
  });
  const authBody = (a: Authorization) => ({ id: a.id, status: a.status, amount: money(a.amount) });
  const captureBody = (c: Capture) => ({ id: c.id, status: c.status, amount: money(c.amount), final_capture: true });

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];
    const text = await readBody(req);

    // Test-control endpoint, not part of PayPal: the sandbox buyer's approval click.
    const control = /^\/__fake\/approve\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "POST" && control) {
      const order = orders.get(control[1]);
      if (order && order.status === "CREATED") order.status = "APPROVED";
      return respond(res, order ? 200 : 404, { approved: Boolean(order) });
    }

    if (method === "POST" && path === "/v1/oauth2/token") {
      if (!req.headers.authorization?.startsWith("Basic ")) return respond(res, 401, { error: "invalid_client" });
      return respond(res, 200, { access_token: FAKE_TOKEN, token_type: "Bearer", expires_in: 32400 });
    }
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      return respond(res, 401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed" });
    }

    let body: RequestBody = undefined;
    try {
      body = text ? (JSON.parse(text) as RequestBody) : undefined;
    } catch {
      return respond(res, 400, { name: "INVALID_REQUEST", message: "bad json" });
    }
    const requestId = req.headers["paypal-request-id"] as string | undefined;
    requests.push({ method, path, requestId, body });

    const label = `${method} ${path}`;
    const index = injections.findIndex((i) => label.includes(i.match));
    const injected = index >= 0 ? injections.splice(index, 1)[0].injection : undefined;
    if (injected?.type === "hang") return; // never answer
    if (injected?.type === "drop-before") return void req.socket.destroy();
    if (injected?.type === "status") return respond(res, injected.status, injected.body);

    // PayPal-Request-Id: the same key replays the first answer instead of repeating the effect.
    const key = requestId && method === "POST" ? `${label}|${requestId}` : undefined;
    const replay = key ? idempotent.get(key) : undefined;
    const result = replay ?? route(method, path, body, req.headers.prefer as string | undefined);
    if (key && !replay) idempotent.set(key, { status: result.status, body: result.body });

    if (injected?.type === "drop-after") return void req.socket.destroy();
    respond(res, result.status, result.body);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    orders,
    authorizations,
    captures,
    approve: (orderId) => {
      const order = orders.get(orderId);
      if (!order || order.status !== "CREATED") return false;
      order.status = "APPROVED";
      return true;
    },
    inject: (match, injection) => void injections.push({ match, injection }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
