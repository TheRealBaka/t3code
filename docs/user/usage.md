# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Plan limits in chat

Type `/usage` in any thread to see how much of your plans is left, next to the last 7 days of token
totals. The card always shows both providers, read live from the sign-ins on the thread's machine:

- **Claude:** the current 5-hour session and weekly windows, including model-specific weeks.
- **Codex:** whichever windows your ChatGPT plan has. Plus plans show a 5-hour session and a
  week; plans with only a weekly limit show just the week. Other named limits, such as a
  per-model allowance, are listed with their name.

If a provider is not signed in, is turned off, or uses an API key instead of a subscription, its
block says so instead.
