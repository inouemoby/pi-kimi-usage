# kimi-usage

Pi Coding Agent extension for monitoring [Kimi (Moonshot AI)](https://www.kimi.com) membership / Kimi Code subscription usage.

Shows the 5-hour rolling window and weekly quota in the pi footer bar.

## Install

```bash
pi install git:github.com/inouemoby/pi-kimi-usage
```

## Setup

No login needed. The extension resolves your Kimi API key (`sk-kimi-...`) in this order:

1. pi's auth config (`~/.pi/agent/auth.json` → `kimi-coding.key`) — the same key pi uses to call Kimi models (run `/auth kimi-coding` if missing)
2. `KIMI_API_KEY` environment variable
3. kimi-desktop auto-provisioned key (`%APPDATA%\kimi-desktop\daimon-share\config.toml`)

## Commands

| Command | Description |
|---------|-------------|
| `/kimi` | Show detailed usage with progress bars (5h / weekly / monthly / parallel) |

## Footer Display

When using a Kimi model, the footer shows:

```
↑3.2k ↓1.1k 12.5%/256k (auto) 5h:6% wk:1%    (kimi-coding) k3 • medium
```

- `5h:6%` — 5-hour rolling rate-limit window. `!` above expected rate, `!!` exceeds 1.5× expected rate
- `wk:1%` — weekly quota (resets every 7 days), same pacing flags

## Quota Details

- **5h window**: Rolling frequency limit — even with quota left, bursting too many requests in 5 hours triggers throttling.
- **Weekly quota**: Main subscription quota, auto-refreshes every 7 days from subscription date. Unused quota does not accumulate.
- **Monthly total**: Account-level shared pool. Shown in `/kimi` and the `kimi_usage` tool (the API does not expose its reset time).
- **Parallel**: Max concurrent requests (shown in `/kimi`).

## Tool: kimi_usage

The extension also registers a `kimi_usage` tool that the AI can call:

```
Check Kimi membership usage (5h window, weekly & monthly quota)
```

## API

Fetches usage from `https://api.kimi.com/coding/v1/usages` (reverse-engineered, undocumented — may change without notice) using your `sk-kimi-` API key as a Bearer token. All quota numbers are returned as strings and parsed locally. The endpoint natively provides reset timestamps for the 5-hour window (`limits[0].detail.resetTime`) and the weekly quota (`usage.resetTime`), but not for the monthly total (`totalQuota`).

## Related

- [pi-zai-usage](https://github.com/inouemoby/pi-zai-usage) — Same tool for ZAI Coding Plan
- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Same tool for Ollama Cloud
