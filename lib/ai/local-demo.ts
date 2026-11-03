import type { ModelPort, ModelRequest, ModelResult } from "./model";

/** The model id this stand-in reports in the run record. It is never a real model. */
export const LOCAL_DEMO_MODEL_ID = "local-demo";

/** A message containing this makes the stand-in behave like a provider outage (for the outage screens). */
export const OUTAGE_TRIGGER = "[[outage]]";
/** A message containing this makes the stand-in answer with output that cannot be used. */
export const MALFORMED_TRIGGER = "[[malformed]]";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where the stand-in model is allowed: the database is a local one and the app is not running on Vercel. A hosted deployment
 * points at a hosted project, so asking for the stand-in there is an error, not a quiet fallback.
 */
export function localDemoAllowed(supabaseUrl: string, onVercel: boolean): boolean {
  try {
    return !onVercel && LOCAL_HOSTS.has(new URL(supabaseUrl).hostname);
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;

const lastCustomerText = (userContent: string): string => {
  const lines = userContent.split("\n");
  let start = -1;
  lines.forEach((line, i) => {
    if (/^--- message \S+ \(customer\) ---$/.test(line)) start = i;
  });
  if (start < 0) return "";
  const rest: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^--- (message \S+ \(|requirements recorded so far)/.test(line) || /^=====CUSTOMER_DATA_\d+=====$/.test(line)) break;
    rest.push(line);
  }
  return rest.join("\n");
};

function read(text: string): Json {
  const out: Json = {};
  // "30 boxes", "20 welcome boxes"; never the "40" of "$40 per box".
  const boxes = /(?<![$\d.])\b(\d{1,6})\s+(?!per\b)(?:[a-z]+\s+)?box(?:es)?\b/i.exec(text);
  if (boxes) out.boxCount = { value: Number(boxes[1]), status: "confirmed" };
  if (/\b(no food|without food|food[- ]free)\b/i.test(text)) out.noFood = { value: true, status: "confirmed" };
  if (/\blogo\b/i.test(text)) out.logoRequired = { value: true, status: "confirmed" };
  const budget = /\b(?:under|below|max(?:imum)?|at most)\s*\$\s?(\d{1,5})(?:\.(\d{2}))?/i.exec(text);
  if (budget) out.maxPricePerBoxMinor = { value: Number(budget[1]) * 100 + Number(budget[2] ?? 0), status: "confirmed" };
  if (/\bnotebooks?\b/i.test(text)) out.preferences = { value: ["notebooks"], status: "confirmed" };
  return out;
}

function fixedQuestion(system: string): string {
  const found = /The fixed question is: ("(?:[^"\\]|\\.)*")/.exec(system);
  return found ? (JSON.parse(found[1]!) as string) : "How many boxes would you like?";
}

function propose(system: string): Json {
  const marker = "The box template and products: ";
  const at = system.indexOf(marker);
  const view = JSON.parse(system.slice(at + marker.length)) as {
    products: Array<{ sku: string; isFood: boolean }>;
    slots: Array<{ id: string; allowedSkus: string[] }>;
  };
  const isFood = new Map(view.products.map((p) => [p.sku, p.isFood]));
  const selections: Record<string, string> = {};
  for (const slot of view.slots) selections[slot.id] = slot.allowedSkus.find((sku) => !isFood.get(sku)) ?? slot.allowedSkus[0]!;
  return { selections };
}

function rank(system: string): Json {
  const indexes = [...system.matchAll(/^index (\d+):/gm)].map((m) => Number(m[1]));
  return { ranking: indexes.map((index) => ({ index, explanation: "A practical swap for this slot." })) };
}

/**
 * A deterministic stand-in for the model, for local development and the end-to-end tests only: it reads quantities, budgets and a
 * few keywords with rules, proposes the first suitable product per slot, and ranks code's list in order. It is NOT a model and no
 * result from it is evidence about a model. The wiring refuses it on any host that is not local. Everything it returns still goes
 * through the same strict parsing and code checks as a real model's answer.
 */
export function createLocalDemoModel(): ModelPort {
  return {
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      const user = request.messages.find((m) => m.role === "user")?.content ?? "";
      const text = lastCustomerText(user);
      const model = LOCAL_DEMO_MODEL_ID;

      if (request.kind === "extract" && text.includes(OUTAGE_TRIGGER)) return { ok: false, failure: "PROVIDER_FAILURE", model, detail: "local demo outage", calls: 1 };
      let answer: unknown;
      if (request.kind === "extract") answer = text.includes(MALFORMED_TRIGGER) ? { price: { value: 1, status: "confirmed" } } : read(text);
      else if (request.kind === "ask") answer = { question: fixedQuestion(system) };
      else if (request.kind === "propose") answer = propose(system);
      else answer = rank(system);

      const parsed = request.parse(answer);
      if (!parsed.ok) return { ok: false, failure: "MALFORMED", model, detail: "the local demo answer was not usable", errors: parsed.errors, calls: 1 };
      return { ok: true, value: parsed.value, model, calls: 1 };
    },
  };
}
