# Checkpoint: quote-approval review

Date: 2 Nov 2026 · Module: `quote-approval` · Reviewed against: [doc/spec/SPEC-quote-approval.md](../spec/SPEC-quote-approval.md) §11
· Code reviewed: `spec-3-quote-approval` at `79aabdd` plus one added test (see Findings).

Every verdict below was re-run on 2 Nov against current state. Evidence is labeled **local** (Docker Supabase on this machine),
**hosted** (the real Supabase project), or **CI** (GitHub Actions). CI evidence was added after the push (criterion 10). Nothing here is hosted evidence: the branch is pushed, but
migration 0005 has not been applied to the hosted project.

## Verdict

**11 of 11 criteria met.** Criterion 10 was partly met until CI ran on the pushed branch; it is now met (see its row). Every local gate is green and
CI is green on `5c2507c`. Migration 0005 is applied to the
local database only. The module is ready for `reservation` and `ai-intake` to build on, locally.

## Criteria

| # | Criterion (spec §11) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to F: 108000, 3600 per box, golden hash, one approval and purchase after a double accept, supersede refuses the old approval | Met | A: `quote-draft-publish` stores 30 boxes with the organizer at 3600 and 108000. B: publish sets `QUOTE_READY` and supersedes the live version. C: `quote-accept` creates one approval and one purchase bound to the hash. D: five simultaneous accepts leave one of each, and a second accept returns the same ids. E: `verifyApprovalBinding` refuses `SUPERSEDED` after a newer publish. F: a held draft is not auto-published and only a merchant publishes it. Golden hash `aeb92d2b…9724` in `snapshot.test.ts`. local |
| 2 | Canonical JSON and the hash pass unit and property tests; golden hash committed | Met | `canonical.test.ts` (key order, code-point sort, rejects floats, NaN, Infinity, `-0`, `undefined`, bigint, Date, Map, cycles), `snapshot.test.ts` (changes with each of 9 covered fields, ignores key order and condition order), `properties.test.ts` (200 random snapshots stable and order-independent). The golden value was hashed by hand-written canonical text outside the repo code. local |
| 3 | `transition` covers the full table; the database guard rejects every forbidden transition including `ACCEPTED → PUBLISHED` | Met | `state.test.ts` checks all 30 status and event pairs against a separately written table. `quote-guards.test.ts` runs every status pair against the real trigger and the TypeScript table, plus `ACCEPTED → PUBLISHED` and `DRAFT → ACCEPTED`. local |
| 4 | A blocked configuration, an unknown SKU, and an input carrying an amount or discount each create no quote | Met | `quote-draft-publish`: 30 bottles gives `INSUFFICIENT_STOCK` (needed 30, available 24); `MAGIC-WAND-999` gives `UNKNOWN_PRODUCT`; food under no-food is blocked; `amount`, `discount`, `totalMinor`, `status` and a price inside the configuration give `INVALID_INPUT`. Each asserts zero quote rows. local |
| 5 | The publish gate holds `UNSUPPORTED_CUSTOMIZATION`; only a merchant actor publishes it; the merchant's wording is in the quote and the hash | Met | Held draft sends the inquiry to `REVIEW_REQUIRED`; the system gets `MERCHANT_REVIEW_REQUIRED`; another merchant gets `NOT_FOUND`; blank wording gets `INVALID_INPUT`. Added in this review: a merchant-approved quote is accepted, its hash equals an independent recomputation with the wording and differs with other wording, and the approval's terms contain the wording. E2E: the customer sees the wording, not the original item. local |
| 6 | Acceptance refuses a wrong hash, a tampered row, an expired, superseded or withdrawn quote, a changed price, insufficient stock, each with its own code | Met | `quote-accept`: `HASH_MISMATCH`, `QUOTE_TAMPERED` (made-up hash, lines that do not fit, total that does not match), `EXPIRED` (exact boundary accepted, one ms later refused and the row marked `EXPIRED`), `SUPERSEDED`, `WITHDRAWN`, `NOT_PUBLISHED`, `QUOTE_STALE` (price +1 cent), `INSUFFICIENT_STOCK`, `INACTIVE_PRODUCT`, `NOT_FOUND` for another customer's or an unknown quote. None creates an approval. local |
| 7 | Two simultaneous accepts, and an accept racing a publish, are proven safe | Met | `quote-rpc` and `quote-accept`: five parallel accepts give one approval and one purchase (at the SQL function and at the service); eight rounds of accept racing a newer publish always end with exactly one live quote, the new one, and either a coded refusal with no approval or an accepted-then-superseded purchase that is reported. Five parallel drafts get versions 1 to 5. local |
| 8 | `verifyApprovalBinding` refuses a superseded or tampered quote, or a differing hash | Met | `quote-accept`: `SUPERSEDED` after a newer publish (the brief's "old acceptance cannot authorize payment"), `HASH_MISMATCH` when approval and quote hashes differ, `QUOTE_TAMPERED` for an accepted quote whose stored hash is not its content's hash, `NOT_FOUND`. The success case returns the snapshot with amount, currency and hash. local |
| 9 | RLS and server access: customers read only their own published or accepted quote; drafts are merchant-only | Met | `quote-reads`: no draft or held draft is ever returned; only the verified inquiry's quote; a quote with a bad stored hash is not shown; the view carries no merchant id, stock figure or internal id. `quote-review-queue`: a signed-in merchant's own session sees only their drafts, even when another merchant's id is asked for. E2E: a forged form field cannot accept another customer's quote nor publish another merchant's draft. local |
| 10 | `domain/quote` passes the purity test; typecheck, lint, unit, database and E2E green locally and in CI | Met | Local: 0 type errors, 0 lint errors, 499 unit, 237 database, 55 E2E, production build ok. `purity.test.ts` limits `domain/quote` imports to `lib/money`, `zod`, `domain/catalog` and sibling files, and bans clock, environment and `Math.random` reads. **CI: green on `5c2507c` (PR 2), 8 of 8 checks: typecheck, lint, test and build; database tests (local Supabase); E2E; Vercel preview, in both the push run and the pull-request run.** local + CI |
| 11 | The order room shows the exact quote, conditions and terms; the merchant review queue works | Met | E2E (5 tests): exact quote with $36.00, $1,080.00, conditions and the fixed terms sentence; accept once and stay accepted after reload; a stale page cannot accept a replaced quote; an expired quote has no button; a held draft is invisible. E2E (6 tests): the queue shows the draft with amounts, approve in own words, blank wording refused, withdraw with reason, another merchant's draft hidden. The richer quote history view was not built (it was cuttable). local |

Counts: quote-specific unit tests 123 (`tests/quote`), quote-specific database tests 138 (`tests/db/quote-*`), 11 quote E2E tests.

## Findings from this review

1. **Criterion 5 rested on an implication.** The merchant's wording being inside the hash was implied by the customer page loading (it
   hides a quote whose hash does not match). A direct test now pins it (see criterion 5).
2. **Spec deviations found while building**, all recorded in spec §4 and §3 at the time and none changing a status, transition or condition code:
   the withdraw-without-hash check constraint; `PAYMENT_STARTED` allows superseding after `VOIDED`, `EXPIRED` or `FAILED` attempts; the
   hash is computed at publish time, not draft time; the accept-versus-publish race has two valid outcomes; `INVALID_INPUT` was added as an error code.
3. **Accept-time revalidation is narrower than the spec sentence suggests.** It re-checks price, stock, active status and names against
   the current catalog. It does not re-check no-food, logo, budget or pickup date, because the shape of stored requirements belongs to
   `ai-intake`; those were validated when the draft was made. `ai-intake` should decide whether to store `Requirements` on the quote.
4. **One foundation test was changed.** `constraints.test.ts` published a second quote on an inquiry already holding one, which the new
   one-live-quote index rejects, so it now retires version 1 first.
5. **Beyond the spec:** a merchant-only demo page at `/merchant/dev/quotes` makes a demo inquiry and quote (held or published) with a
   customer link, because nothing else creates drafts until `ai-intake` exists. It is cuttable and can be removed when intake lands.
6. **Process note:** the T8 reads and their tests were written in one step rather than strictly red first. They pass and cover real behavior.
7. **Local data:** `npm run test:db` wipes local demo data and `supabase db reset` wipes local auth users, so the local seed was re-run
   after each (with the local URL and key set for that one command; `.env` points at hosted and the seed script refuses a remote host without `--confirm-host`).

## Open items

| Item | Why it is open | What closes it |
|---|---|---|
| Migration 0005 on hosted | Applied to local only; hosted needs a fresh explicit yes | You say yes immediately before; then apply and check read-only before and after, as for the catalog re-seed. |
| Expiry sweep | The spec mentioned a scheduled sweep to mark `EXPIRED` for tidiness; not built. Expiry is evaluated at the moment of use and shown to the customer, and the next publish supersedes an expired quote anyway | Decide with `reservation` whether the reconcile route should sweep; no correctness gap today. |
| "Payment is the next step" | Placeholder text on an accepted quote until `payments` exists | Replaced by `payments`. |
| `MERCHANT_ONLY` code | Defined in the contract, not yet returned by any service (every merchant function takes a merchant actor by type) | Used or removed when `payments` calls into this module. |

## Next

After CI is green and the hosted migration is decided: the next modules in build order are **`reservation`** and **`ai-intake`**
(they can run in parallel; both depend on this module). Spec first for each, as `AGENTS.md` requires.
