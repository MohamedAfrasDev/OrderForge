# Plan: judge-readiness

Spec: [doc/spec/SPEC-judge-readiness.md](../../doc/spec/SPEC-judge-readiness.md) (approved 6 Nov 2026, defaults). Checklist: [todo.md](todo.md).

## Order and why

1. **Facts and reliability first (T1 to T4).** Nothing else is worth polishing if the site claims what it does not serve or the model fails in front of a judge. T1 is read-only. T4 changes hosted config and needs a fresh yes.
2. **Visible evidence (T5 to T7).** `/developers` first (smallest, reuses the built agent API), then the prepared demo requests, then `/demo`.
3. **Second-shop gate (T8, T9).** Code for the additive seed option is ready by 7 Nov so the hosted decision on 8 Nov is only a yes or a removal.
4. **Polish (T10 to T13).** Only the six frames. First cut if behind.
5. **Submission (T14 to T16).** Rewrite, deploy, regenerate proof, fresh tester, checkpoint.

## Dependency graph

```
T1 -> T2, T3 -> T4
T5 (independent) -> T7 <- T6
T8 -> T9 (needs T1)
T10 -> T11, T12, T13
T7, T5, T9, T13 -> T14 -> T15 -> T16
```

## Hosted actions (each needs a fresh yes, none is done by a task alone)

- T4: set `OPENROUTER_MODEL` (and unset or equalize the fallback) on Vercel, redeploy, run the soak against the hosted site.
- T9: add the two merchant-2 variables on Vercel, run the additive hosted seed with `--confirm-host`, run one hosted journey.
- T15: merge, deploy, run the README agent example against production.

## Risks

- Hosted state differs from what the checkpoints say (T1 catches it).
- Soak fails on the paid model too: record it as it is, do not claim reliability, keep the quick hand-off (T2) as the safety net.
- Polish expands: stop at the six frames; anything else is a separate request.
- Parallel browser specs race on shared shops (seen before): new specs use their own stores or only read.
