# Problem Statement 3 — Grant Computation

```bash
npm test    # verifies the numbers below
npm start   # prints the full trace for Scenario 1
```

## Scenario 1 — Centre CTR-B

| Step | Value |
|---|---|
| Gates | all pass → eligible |
| Normative cost | (6,200×3) + (4,800×3×2) + (2,900×3) = **$56,100** |
| Tier (Rural, caseload 38 → 20–39 band) | **90%** |
| Gross grant | **$50,490** |
| Net grant | 50,490 − 4,500 = **$45,990** |
| Ministry (60%) / Community Chest (25%) / Town Council (15%) | **$27,594 / $11,497.50 / $6,898.50** |

Verified in `calculator.test.js` — split sums exactly to the net grant
because rounding happens once, at the split, not at every step (see the
assumptions noted at the top of `calculator.js`).

## Scenario 2 — 7 bands, different roles, 4-way split
`tiersByCentreType` and `split` in `scheme.json` are plain arrays — any
number of bands or split parties is a config edit, not a code change. What
*isn't* free: the three gate types are a fixed set handled in `calculator.js`.
A genuinely new kind of gate (not just new parameters on an existing one)
needs a code change — I'd wait for evidence that new schemes actually need
new gate *kinds*, not just new parameters, before building a rule-expression
language for it.

## Discussion 1 — Ambiguities I'd raise with the business team
1. **"Sum of (rate × 3) for each funded role"** — per role *category* once,
   or per *staff member* filling it? I assumed per-staff-member; wrong
   guess changes every centre's cost by a multiple of headcount.
2. **Partial-quarter staffing.** No proration rule is given for someone
   hired mid-quarter. I excluded them entirely rather than prorate —
   materially affects normative cost and will happen constantly in reality.
3. **Caseload measurement basis.** Average over the quarter? End-of-quarter
   snapshot? A centre near a band boundary gets a different tier depending
   on which one is used.
4. **Rounding rule.** No guidance given. I round once, at the split, so
   amounts sum exactly — a real finance system may have an existing
   house rule (round every step, truncate for disbursement) I'd need to
   match instead of assume.
5. **"Qualified" for G2** isn't defined — a certification? A registration
   number? What if it lapses mid-quarter?
6. **Ineligible centres and existing co-funding** — is the net grant simply
   $0, or does co-funding still need to be recorded for audit even with no
   new grant issued?

## Discussion 2 — Rate versioning across re-runs
`rates.json` is effective-dated, and `resolveRates(table, quarterStart)`
resolves by the **first day of the quarter being computed**, not "today" —
so a Feb 2027 re-run of Q3 2026 gets Q3 2026's rates regardless of any
revision since. Verified by a test that resolves the same table two ways.

**Limitations:** doesn't yet persist *which* rate version was applied
alongside each computed grant — a real system needs that stored per
computation for audit, not re-derived from the quarter date later. Also
assumes re-runs should always use the *original* quarter's rates by
default; if an appeal is specifically triggered by a retroactive rate
correction, the business may want the *corrected* historical rate applied
instead — that needs a "supersedes" relationship between rate versions for
the same period, which this flat effective-dated list doesn't model. Flagged
rather than guessed at.

## Deliberately left out
No persistence layer (pure functions over JSON — a real system stores each
computation as an immutable row), no config validation (split percentages
summing to 1.0, band gaps/overlaps). Straightforward to add; left out to
keep scope on the parts needing actual design judgment.
