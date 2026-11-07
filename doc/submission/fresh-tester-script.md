# Fresh-tester run: instructions for the person testing

Purpose: find out where someone who has never seen OrderForge gets stuck, using only what a judge gets. The person testing must **not** be the person who built it and must not be coached while they work. Record what they say and do, not what they should have done.

## What the tester gets

- The repository's README (first screen) and the Devpost notes (the "Try it" section of `doc/submission/devpost-text.md` as it will be pasted, with the real sandbox buyer and shop logins filled in). Nothing else: no demo, no explanation, no video.
- A phone or a laptop, and the hosted address `https://order-forge.afras.dev`.

## The task, said once

"Imagine you are a judge with a few minutes. Find out what this project does and whether it works. Try it as a customer, then as the shop. Say what you are thinking out loud."

## What to record (one line each, in the tester's words where possible)

| # | Question | Record |
|---|---|---|
| 1 | After the first screen of the README, what do they say the project is for? | Their words |
| 2 | Where do they click first? Do they find `/demo` or "Try it as a customer"? | The first three clicks |
| 3 | Do they understand what the assistant did with their message? (the "From your message" lines) | Yes or no, and what they said |
| 4 | Do they notice the stock limit and understand why the box changed? | Yes or no |
| 5 | Do they find the PayPal sandbox login in the notes and get through PayPal's page? | Where they stopped, if they did |
| 6 | Do they find the shop's side and the decision screen? Which button do they press and what do they think it does? | The button and their words |
| 7 | What did they not understand, or want explained? | List |
| 8 | Anything broken, slow or confusing? | List, with the time of each |
| 9 | Total time from opening the README to the end of the shop's decision | Minutes |

## After the run

Write the result in `doc/evidence/fresh-tester-run.md`: the date, who (a role, not a name, unless they agree), the hosted commit, the table above filled in, and the three things most worth fixing. Make the small fixes (wording, a missing link, an unclear label); put the rest in the checkpoint as known limitations. Do not change what the tester saw until the record is written.

## Before the run

Check the stock first. The hosted gift-box shop must offer the 20-box request at $35.00 a box: if the steel bottle has fewer than 20 available, the first step is blocked and the run says nothing about the product. See the checkpoint `doc/checkpoints/judge-readiness-checkpoint.md`, finding 1.
