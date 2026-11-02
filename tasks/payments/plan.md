# Plan: payments

Spec: [doc/spec/SPEC-payments.md](../../doc/spec/SPEC-payments.md) · Task list: [todo.md](todo.md)

## Approach

Pure logic first, test first: the attempt state machine, request ids, the PayPal-result classifier and the verification functions,
with no database or network. Then migration 0007 in three slices (create and record, begin and settle, decide), each proven on real
Postgres with its races before anything calls PayPal. Only then the services, against the existing local fake PayPal with fault
injection, then reconciliation, then webhooks, and last the two screens. A schedule squeeze can therefore cut only the status wording
on the screens, never the state machine, the verification or the reconciliation.

Every task is about five files or fewer, has its own verify step, and leaves `npm run typecheck`, `lint` and `test` green.
Money is integer cents; amounts come only from the accepted snapshot. No new dependencies. One optional environment variable
(`PAYPAL_PAYEE_MERCHANT_ID`) was approved with the spec. The hosted database is touched only in the last task, after a fresh yes,
and the real-sandbox runs need you to play the buyer.

## Dependency graph

```
T1 pure logic ─ T2 migration 0007: create/record/approve ─ T3 begin + settle ─ T4 decide, resolve unknown, expire
T4 ─ T5 checkout service (fake PayPal) ─ T6 decision services ─ T7 reconcile ─ T8 webhooks ─ T9 screens ─ T10 checkpoint
```

T3 depends on T2 because every RPC shares the guard trigger and the lock order. T5 is the first task that sends anything to PayPal
(only the local fake). T7 needs T6 because reconciliation settles the operations T6 begins.

## Phases and checkpoints

| Phase | Tasks | Needs a database or account? | Checkpoint |
|---|---|---|---|
| A. Pure logic | T1 | No | Table, classifier and verification pass; purity green |
| B. Database | T2 to T4 | Local Supabase only | Atomicity with the reservation, the confirm-versus-decline race and repeated accept proven on real Postgres |
| C. Services | T5 to T8 | Local Supabase and the local fake PayPal (labeled mocked) | Demo path A to H and every fault-injection case pass |
| D. Screens and review | T9, T10 | Local Supabase; hosted only after a fresh yes; real sandbox with your buyer | Spec criteria ticked or explained; real-sandbox runs recorded and labeled |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| A PayPal request goes out without the stock held, or twice | `payment_begin` is one transaction with the reservation and commits before anything is sent; a stable request id per attempt and operation; tests inject lost answers and timeouts |
| A confirm and a decline both win | The decision moves under its row lock in the same transaction that begins capture or void; a database race test runs both at once |
| An unknown outcome is retried blindly | The only exit from `OUTCOME_UNKNOWN` is a reconcile that queries PayPal; fault-injection tests assert no second capture and the same request id on a justified retry |
| A late or duplicate webhook moves state backwards or twice | Webhooks only trigger a query of PayPal's current state; the guard trigger allows forward moves only; `processed_at` separates processed duplicates from unprocessed redeliveries |
| Something is marked paid on thin evidence | `verifyCapture` demands status, amount, currency, order and authorization linkage (and payee when configured); wrong ones become financial exceptions, tested |
| Attempt and reservation states drift apart | One pairing test after every transition in the database tests; settle updates both in one transaction |
| Authorization expiry cannot be observed in the sandbox | Application-level tests with an injected clock, labeled as such, exactly as the brief asks |
| Payment tests fail on 9 Nov | The brief's tripwire stops all feature work; payment and access tests run in CI on every push |
| The real-sandbox run needs a human buyer | Scheduled into T10 and asked for in advance; mocked results are never presented as real |
