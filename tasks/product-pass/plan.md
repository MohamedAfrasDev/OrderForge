# Plan: product-pass

Spec: [doc/spec/SPEC-product-pass.md](../../doc/spec/SPEC-product-pass.md) · Task list: [todo.md](todo.md)

## Approach

Customer first, shop second, plumbing last, and the riskiest unknown first. The one thing nobody has tried in this repo is AG Grid under
this Next.js and React, so task 0 proves it on a real page before anything depends on it. Then the customer's whole experience, in the
order a visitor meets it: one pure module that owns the words and the stage, the order room built on it, the conversation with the live
summary and quick replies, the price and PayPal sections, and the way in from the home page. Then the shop: a Today page, the grid
wrapper, the quote builder (the one new behaviour a handed-over request cannot do without) and the catalog editor. Then email, in three
small steps (data and pure rendering; the outbox and its limits; the Resend provider), because email touches the most things and must
never touch money. The last tasks are the chained end-to-end runs and the checkpoint.

Every task is about five files or fewer (a few are larger and say so), has its own verify step, and leaves typecheck, lint and the unit
tests green. Pure logic is tested first and has a purity test. Money is integer cents and comes only from the catalog engine and the
quote services; nothing here changes a state machine, a quote rule, a payment or a job. Changes the spec approved: two dependencies
(`ag-grid-community`, `ag-grid-react`, exact versions pinned at least two weeks old), three optional environment variables
(`RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`) and one migration (`0010_notifications.sql`, local first). The hosted database, the
Vercel variables and the first real email are touched only in the last task, each after a fresh yes.

## Dependency graph

```
T0 grid spike ──┬─ T6 grid wrapper, Today, Requests ─┬─ T7 Build a quote ──────────────┐
                │                                    └─ T13 other shop grids (cuttable)│
                └─ T9 catalog editor UI ── (needs T8)                                  │
T1 journey ─┬─ T2 order room ── T3 conversation, summary, quick replies ──────────────┤
            └─ T4 price, PayPal, keep this page ──────────────────────────────────────┤
T5 home entry, header, not-found ──────────────────────────────────────────────────────┤
T8 catalog edit rules and services ── T9                                               ├─ T15 chained E2E ─ T16 checkpoint
T10 email data and pure rendering ── T11 outbox ── T12 Resend provider ────────────────┤
T14 print and phrases (cuttable) ──────────────────────────────────────────────────────┘
```

## Phases and checkpoints

| Phase | Tasks | Needs a database, network or account? | Checkpoint |
|---|---|---|---|
| A. Prove the grid | T0 | Local Supabase | AG Grid builds, renders and tests under this stack; versions pinned |
| B. The customer's experience | T1 to T5 | Local Supabase; stand-in model | A visitor can start from the home page, build an order, read a price and see where they are, with no raw state names |
| C. The shop | T6 to T9 | Local Supabase | Today, the requests grid, Build a quote, and the catalog add and edit work end to end |
| D. Email | T10 to T12 | Local Supabase; a fake provider (Resend only in T12, and no real send without a yes) | The listed emails queue once, send through the port, fail safely |
| E. The rest of the shop | T13, T14 | Local Supabase | Other lists are grids; print and phrases (both cuttable) |
| F. Prove it and close | T15, T16 | Local Supabase; fake PayPal; hosted only after fresh yeses | Both chained journeys pass; criteria against evidence |

## Cut order (spec section 11)

If time runs short, cut from the end of this list first: T13, then T14, then T12's real provider (keep the outbox and the fake and say
so), then T9 beyond a price and stock edit, then T11's non-essential emails (keep: the customer's link, the price ready, the shop's
decision, the shop's new request). T1 to T7 and T15 are not cut. Payment and access tests failing on 9 Nov stops all feature work.
Building should end around 10 Nov; 11 to 12 Nov belong to the video, the text and the final checks.

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| AG Grid does not build or test under this Next.js and React, or bloats the customer pages | T0 first, on a real page; the grid is imported only by shop pages (checked in the build output); exact versions pinned; Community edition only |
| Converting the shop pages breaks the payment or fulfillment E2E checks | Selectors change, checks never do; detail areas keep the existing forms and actions; the 9 Nov tripwire tests run after every grid task |
| Email slips into the money path | Triggers derived from database state in a new scheduled step, never hooked inside payments or fulfillment; a failing provider changes nothing; a test proves it |
| A customer address is abused to send mail to someone else | Optional field, at most 8 emails per inquiry, fixed templates with no customer text, only the link to that customer's own request, the existing per-address limit on starting a request |
| Resend's test sender reaches only the account owner | Stated in the spec, the checkpoint and the submission; the demo uses that address; a verified domain is outside this module |
| The catalog editor breaks stock or quotes | The database already refuses `reserved > on_hand`; the template is written last; deactivating the last product of a slot is refused; published and accepted quotes are snapshots (tested) |
| Scope outgrows the days left | The cut order above, decided now, not on 10 Nov |
