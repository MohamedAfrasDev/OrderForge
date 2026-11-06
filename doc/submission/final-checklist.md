# Final submission checklist

Source: the brief's checklist, which was copied from the official rules as read on 31 October 2026, plus what the Devpost page said on 6 November 2026. **Deadline: 12 Nov 2026 12:00 PST (13 Nov 01:30 Sri Lanka time); target 18:00 on 12 Nov Sri Lanka time. Recheck the official rules before submitting**, and update this file. A ticked line must name its evidence; an unticked line must say why it is open.

## From the brief

- [x] Public repository on GitHub with all source, assets and setup instructions, and an open-source license shown in the About section. Evidence: `gh repo view` on 6 Nov 2026 reports visibility PUBLIC and license MIT. The About description is empty; add one line there.
- [ ] Working demo: hosted URL or complete run instructions, free to test until judging ends, with test credentials in the instructions. OPEN: the hosted URL works (evidence in `doc/evidence/product-pass-hosted.md`) but the sandbox buyer login and the demo shop login are not written into the Devpost notes yet; they go in `devpost-text.md` under "Try it". Also confirm the hosted site runs the merged code.
- [ ] Text description of features and functionality, plus which AI tools were used and how. OPEN: drafted in `devpost-text.md`; not pasted into Devpost; the models configured on Vercel must be confirmed against the "Tools used" table.
- [ ] Public YouTube demo video under 3 minutes showing the project running, with no unlicensed music or trademarks. OPEN: script written in `video-script.md`; not recorded. Check the rules on third-party trademarks: PayPal's own sandbox page appears on screen.
- [x] Project built or significantly updated between 1 October and 12 November 2026. Evidence: the first commit in the repository is dated 2026-11-01; `git log` shows work on every day from 1 to 6 Nov.
- [x] English materials. Evidence: every document and page text in the repository is in English.
- [ ] No secrets in the repository. OPEN: a pattern scan of all 529 tracked files on 6 Nov 2026 (commit `47841d2`) found no key, token or password (it matched placeholders in `.env.example`, fake values in tests and the hosted project reference in checkpoint documents, which is not a secret); rerun the scan on the final commit before submitting.
- [x] README with environment-variable names, migration and seed commands, worker setup, a demo reset, sandbox buyer guidance and known limitations. Evidence: `tests/readme.test.ts` checks each of these on every run.
- [ ] Sandbox-only status and simulated data labeled in the UI, the README and the video. OPEN: the UI banner and the README are checked by tests (`e2e/banner.spec.ts`, `tests/readme.test.ts`); the video is not recorded.
- [x] One project can win one Grand Prize or one Honorable Mention, plus one Sponsor Prize: noted. Evidence: the AG Grid sponsor prize is the one this project is eligible for, because AG Grid Community is used for the shop's data grids.

## From the Devpost page (read on 6 Nov 2026)

- [x] The project meaningfully uses PayPal and AI. Evidence: PayPal Orders v2 and Payments v2 in `doc/evidence/payments-real-sandbox.md`; the model pipeline in `doc/evidence/ai-intake-real-model.md`.
- [ ] Demo video "must show the project functioning on the device it was built for". OPEN: not recorded.
- [ ] The "Tools" field names the model or AI service and how it is used. OPEN: drafted; confirm the model names.
- [x] Free to test: the demo uses the PayPal sandbox only. Evidence: `SANDBOX_MODE` and `PAYPAL_ENV` must be `sandbox`, enforced by `lib/env-schema.ts` and tested.

## Before pressing submit

- [ ] Merge the open pull request, redeploy, and open `/how-it-works`, the home page and `/api/agent/v1/openapi.json` on the live site. OPEN: pull request 11 is merged; pull request 12 (the submission pack and the agent API) is open, its checks had passed except one browser job that was still running on 6 Nov 2026; it is not merged or deployed.
- [ ] Regenerate `doc/evidence/proof-points.md` (`npm run proof`) after the merge so it names the merged commit. OPEN: the committed copy names commit `47841d2` (generated 6 Nov 2026, 1604 unit, 1400 database and 153 browser tests passed); after the merge the merge commit is a different one.
- [ ] One last full run of the hosted journey by someone who has not seen it, using only the README and the Devpost notes. OPEN: not done.
- [ ] The second demo shop on the hosted site (an additive `--only` seed option, the two new variables on Vercel, a hosted seed, one hosted run). OPEN: needs your approval and your yes; see the checkpoint.
- [ ] One run of the README's agent example against the hosted address. OPEN: the agent routes are not deployed until pull request 12 is merged.
- [ ] Add a one-line description to the repository About section. OPEN: the description is empty.
