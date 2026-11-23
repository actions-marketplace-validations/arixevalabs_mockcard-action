# MockCard chaos run — GitHub Action

Fails your build when a change breaks how your app handles payment failures: duplicate webhooks,
webhooks that never arrive, late webhooks, 3DS abandonment and declines.

Author: Arixeva Labs <hello@arixevalabs.com> · [mockcard.io](https://www.mockcard.io) · MIT

```yaml
- name: Start the app
  run: npm run build && (npm start &) && npx wait-on http://localhost:3000
- uses: arixevalabs/mockcard-action@v2
  with:
    api-key: ${{ secrets.MOCKCARD_API_KEY }}   # a CI-scoped key from the dashboard
    project-id: prj_…
    target: http://localhost:3000/api/webhooks/stripe
```

MockCard plans the run and signs every event; the action delivers them to your app inside the job
(MockCard can't reach the runner) and reports the results. The job summary lists every check, and
each run appears in your MockCard run history with the commit and branch.

For assertions about what your app *did* (e.g. "the order was fulfilled exactly once"), use the SDK
for your language in your test suite instead: `mockcard` (npm), `mockcard/laravel`, `mockcard` (PyPI)…

Inputs: `api-key`, `project-id`, `target` (required); `scenarios`, `min-score` (default 100),
`time-scale` (default 0.2). Outputs: `run-id`, `score`, `status`.
