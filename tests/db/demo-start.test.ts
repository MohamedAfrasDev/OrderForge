// Real local Postgres, SCRIPTED model (no network). A prepared /demo request takes the same path a typed one takes: stored first, read once,
// and the visitor gets a link to their order room, whatever the assistant does.
import { describe, expect, it } from "vitest";
import { startAndAnswer, type StartFlowDeps } from "../../app/store/[slug]/start-flow";
import { demoScript } from "@/domain/demo/scripts";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { createFakeModel } from "@/lib/ai";
import { must, serviceClient } from "./helpers";
import { BOTTLE_BOX, catalogMerchant, kindsOf, readA } from "./intake-fixtures";
import { NOW, SECRET, ctx, messagesOf } from "./intake-helpers";

const db = serviceClient();
const script = demoScript("demo-gift-boxes", "welcome-20")!;

const flow = (model: ReturnType<typeof createFakeModel>): StartFlowDeps => ({
  db,
  accessSecret: SECRET,
  model,
  authorize: (token) => authorizeCustomerLink(db, token, { secret: SECRET, now: new Date(NOW) }),
});
const answered = () => createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } });
const inquiriesOf = async (slug: string) => must(await db.from("inquiries").select("id, status, customer_email, merchants!inner(slug)").eq("merchants.slug", slug)) as Array<{ id: string; status: string; customer_email: string | null }>;

describe("startAndAnswer with a prepared request", () => {
  it("stores the prepared message as the customer's first message, reads it once, and links to an order room that holds the priced box", async () => {
    const m = await catalogMerchant(db);
    const model = answered();
    const out = await startAndAnswer(flow(model), m.slug, script.message, null, ctx);
    if (!out.ok) throw new Error(out.code);

    const messages = await messagesOf(db, out.value.inquiryId);
    expect(messages.map((x) => x.role)).toEqual(["customer", "assistant"]);
    expect(messages[0]!.body).toBe(script.message);
    expect(messages[1]!.body).toContain("$35.00 per box");
    expect(messages[1]!.body).toContain("$700.00");
    expect(kindsOf(model.requests)).toEqual(["extract", "propose"]); // one reading, nothing extra

    const [inquiry] = await inquiriesOf(m.slug);
    expect(inquiry).toMatchObject({ id: out.value.inquiryId, status: "CONFIGURING", customer_email: null });
    const access = await authorizeCustomerLink(db, out.value.accessToken, { secret: SECRET, now: new Date(NOW) });
    expect(access.ok && access.inquiry.id).toBe(out.value.inquiryId);
  });

  it("leaves the same traces as a typed request with the same words", async () => {
    const a = await catalogMerchant(db);
    const b = await catalogMerchant(db);
    const prepared = await startAndAnswer(flow(answered()), a.slug, script.message, null, ctx);
    const typed = await startAndAnswer(flow(answered()), b.slug, String(script.message), null, ctx);
    if (!prepared.ok || !typed.ok) throw new Error("start");
    const shape = async (id: string) => (await messagesOf(db, id)).map((x) => [x.role, x.body]);
    expect(await shape(prepared.value.inquiryId)).toEqual(await shape(typed.value.inquiryId));
    expect((await inquiriesOf(a.slug))[0]!.status).toBe((await inquiriesOf(b.slug))[0]!.status);
  });

  it("an unknown store stores nothing and never asks the model", async () => {
    const model = answered();
    const out = await startAndAnswer(flow(model), "no-such-shop-anywhere", script.message, null, ctx);
    expect(out).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(model.requests).toHaveLength(0);
  });

  it("when the assistant cannot answer, the visitor still gets the link, with their message kept for the retry", async () => {
    const m = await catalogMerchant(db);
    const model = createFakeModel({ answers: { extract: [{ fail: "PROVIDER_FAILURE" }] } });
    const out = await startAndAnswer(flow(model), m.slug, script.message, null, ctx);
    if (!out.ok) throw new Error(out.code);
    expect(model.requests.length).toBeGreaterThan(0);
    const messages = await messagesOf(db, out.value.inquiryId);
    expect(messages[0]).toMatchObject({ role: "customer", body: script.message });
    expect((await authorizeCustomerLink(db, out.value.accessToken, { secret: SECRET, now: new Date(NOW) })).ok).toBe(true);
  });
});
