# Golden repo fixture

`projectplan.md` §12: "small npm project with real tests, used by
integration/e2e". Materialized into a temp git repository by
`test/fixtures/golden.ts` — never used in place, so a test can commit to it,
branch from it and leave it dirty without touching Dispatched Code's own repo.

- `npm test` runs the node built-in test runner against `test/checks.mjs`. No
  dependencies, so it works offline and in a fresh container.
- `breakGoldenRepo()` in `golden.ts` makes the suite fail on demand, which is
  what the reconciliation and merge-gate tests need.
