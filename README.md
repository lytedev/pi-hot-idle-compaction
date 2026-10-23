# pi-hot-idle-compaction

A [pi](https://github.com/earendil-works/pi) extension that keeps long sessions cheap on providers with a
prompt cache that expires: it summarises while the cache is still warm, drops stale tool output instead of
paying to re-read it, and (optionally) keeps the cache alive for exactly as long as that is cheaper than
missing.

```
pi install npm:pi-hot-idle-compaction
```

Requires pi >= 1.4.0. Nothing happens until the extension knows the model's prompt-cache lifetime: either
the model declares `promptCache` in `models.json`
([docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#prompt-cache-lifetimes)),
or you set `hotIdleCompaction.ttlSeconds`.

## Why

A request that follows a long coding session re-sends the whole conversation. If the provider still holds it
in its prompt cache, you pay the cheap cached-read price; if the cache expired while you were away, you pay
the full uncached price for every token again.

Cost of one return-after-a-break, DeepSeek V4 Pro on StreamLake (uncached input $0.66/M, cached read
$0.022/M, output $1.98/M; cache writes cost the same as uncached input), at a 400k-token context:

| What happens on return                                   | Cost                      | At 400k     |
| -------------------------------------------------------- | ------------------------- | ----------- |
| Cache expired, nothing done (cold miss)                  | C x uncached              | $0.26       |
| Old tool results stubbed on resume (60% of context)      | (1 - 0.6) x C x uncached  | $0.11       |
| Summary sent before expiry, hitting the cache            | C x cached + O x out + S x uncached | $0.043 |
| Ongoing cache reads while a big context stays big        | 17 calls x C x cached     | $0.15 per prompt at 400k, $0.30 at 800k |

The last row is why a lower compaction threshold pays for itself: a 17-call prompt on a 800k context costs
$0.30 in cache reads alone, so a summary that costs $0.04 is repaid within about one prompt.

pi's built-in compaction cannot do the third row. Its summariser serialises the conversation to text (tool
results truncated to 2000 characters) and disables cache writes, so it never reads the prompt cache. This
extension instead replays the exact transcript of the last request and appends one user message asking for
the summary, so the provider serves the whole prefix from its cache.

## What it does

1. **Floor.** Below `minContextTokens` (default 100k) it does nothing.
2. **Threshold compaction.** When a prompt finishes (`agent_settled`) and the context is at least
   `compactAtTokens` (default 300k, per-model overridable), it compacts using the cache-hitting summary.
   Deciding between prompts, not mid-run, is deliberate: `ctx.compact()` aborts a run in progress, and the
   prefix of the request that just finished is entirely cached.
3. **Lazy stubbing.** On the first request after an idle gap longer than the cache lifetime plus
   `stubbing.graceSeconds`, old tool results are replaced by a stub naming the tool and its arguments, so the
   model can re-run it. The newest 12 tool uses are never touched, and only if it clears at least 20k tokens
   and 30% of the context. The stubbed ids are persisted in the session and applied identically on every
   later request, so the prefix stays stable and the following calls hit the cache again.
4. **Idle summary.** While idle, at `min(0.9 x lifetime, lifetime - 60s)` after the last request, it compacts
   with a cache-hitting summary, but only if the context is at least `idleSummary.minContextTokens` (250k)
   and the lifetime is at most `idleSummary.maximumTtlSeconds` (2h). It refuses if it fires more than 60s
   late, if a newer request exists, or if the agent is busy.
5. **Keepalive (off by default).** Re-sends the last request with a one-token output cap before expiry,
   capped at the break-even count: the most pings whose cost does not exceed one cold miss.

`/hot-idle` shows the context size, the lifetime and where it came from, the next scheduled action, the number
of stubbed results and the money ledger. Every action is also a `hot-idle-action` entry in the session.

### When the cache-hitting summary is skipped

It falls back to pi's own summary when it cannot be cheaper:

- the cache already expired or its lifetime is unknown;
- less than `summary.minimumCacheReadFraction` (0.8) of the context was in the last request, for example
  right after ten large tool results landed in one turn;
- an earlier cache-hitting summary in this session read less than that fraction from the cache. The summary is
  still kept (redoing it would pay twice) but later ones are disabled for the session.

## Settings

Under `hotIdleCompaction` in `~/.pi/agent/settings.json` or `.pi/settings.json`. Every key is optional.

| Key                                      | Default | Meaning |
| ---------------------------------------- | ------- | ------- |
| `enabled`                                | `true`  | Master switch |
| `ttlSeconds`                             | model's `promptCache` | Cache lifetime override for all models |
| `minContextTokens`                       | 100000  | Do nothing below this |
| `compactAtTokens`                        | 300000  | Threshold compaction |
| `perModel["provider/model"]`             | none    | `{ compactAtTokens?, ttlSeconds? }` |
| `summary.maxOutputTokens`                | 8000    | Summary length cap |
| `summary.minimumCacheReadFraction`       | 0.8     | Required cached share of the summary prefix |
| `stubbing.enabled`                       | `true`  | |
| `stubbing.graceSeconds`                  | 60      | Idle beyond lifetime + this before stubbing |
| `stubbing.keepMostRecentToolUses`        | 12      | Never stubbed |
| `stubbing.minimumTokensCleared`          | 20000   | |
| `stubbing.minimumFractionOfContextCleared` | 0.3   | |
| `idleSummary.enabled`                    | `true`  | |
| `idleSummary.minContextTokens`           | 250000  | |
| `idleSummary.maximumTtlSeconds`          | 7200    | Longer lifetimes are rarely outlasted by idle gaps |
| `idleSummary.lateToleranceSeconds`       | 60      | Refuse when firing later than this |
| `keepalive.enabled`                      | `false` | |
| `keepalive.maximumPings`                 | none    | Cap below the break-even count |

```json
{
  "hotIdleCompaction": {
    "ttlSeconds": 600,
    "compactAtTokens": 250000,
    "perModel": {
      "openrouter-gateway/deepseek/deepseek-v4-pro-0813": { "compactAtTokens": 200000 }
    }
  }
}
```

## Measured prompt-cache lifetimes

`scripts/measure-provider-cache-ttl` writes a fresh ~30k-token prefix to a pinned OpenRouter provider, waits a
gap, resends it and records `cached_tokens`. See the results section below.

Snapshot taken 2026-10-23 about 35 minutes into an 8 hour run (started 05:24 UTC). Both providers were pinned
with `provider: { order: [...], allow_fallbacks: false }`, and the `provider` field of every response named
the pinned provider. The "control" is an immediate resend that proves the provider caches at all. Cache hits
come in 256-token blocks, so "cached" is slightly under the prompt size.

| Model / provider                      | gap (min) | cached after gap | verdict      |
| ------------------------------------- | --------- | ---------------- | ------------ |
| DeepSeek V4 Pro / StreamLake          | 5         | 28672 of 29472   | still cached |
| DeepSeek V4 Pro / StreamLake          | 10        | 28672 of 29382   | still cached |
| DeepSeek V4 Pro / StreamLake          | 30        | 28672 of 29531   | still cached |
| DeepSeek V4.1 Flash / DeepInfra       | 5         | 29312 of 29331   | still cached |
| DeepSeek V4.1 Flash / DeepInfra       | 10        | 29312 of 29391   | still cached |
| DeepSeek V4.1 Flash / DeepInfra       | 30        | 29440 of 29470   | still cached |
| both                                  | 60 to 480 | pending          | pending      |

The long gaps finish about 13:25 UTC. Regenerate this table with
`scripts/summarise-cache-ttl-results results/pro-streamlake.json results/flash-deepinfra.json`.
The 480 minute StreamLake control missed (0 cached), so that one gap is inconclusive and needs a re-run.

Until the long gaps are in, treat any lifetime above 30 minutes as unmeasured and set `ttlSeconds` yourself.

## Verified live

`scripts/live-verify` against DeepSeek V4 Pro through an agentgateway, with a simulated 120s lifetime so the
scenarios finish in minutes (the 600s lifetime for the threshold run). Context built by reading ~11k-token
files one per turn.

| Scenario | What happened |
| -------- | ------------- |
| Threshold compaction (`threshold`) | Context 116167 tokens at settle; the summary request read 114688 cached tokens of a 116353 token prefix (98.6%), cost $0.0045. |
| Idle summary (`idle-summary`) | The timer fired 60s after the last request; the summary read 69632 of 70756 prefix tokens from cache (98.4%), cost $0.0032, against about $0.047 to send the same context uncached. |
| Stubbing (`stubbing`) | After 140s idle, 5 of 8 old tool results were stubbed. The request after resume was 34932 tokens instead of about 93k, the model correctly reported the stubbed output as removed, and the next two requests read 36864 cached tokens with only 154 and 179 uncached: the stubbed prefix is stable. |

Two measurements to keep in mind. First, pi's own summary of the same synthetic transcript cost $0.0051
because its serialiser truncates tool results to 2000 characters, so on tool-heavy transcripts the saving
over pi's own summary is quality (the summary sees everything) more than money; on conversations dominated
by prose the cache-hitting summary is the cheaper one. Second, `toolChoice: "none"` on the summary request
makes the provider render the prompt without tool definitions, which misses the cache entirely; the request
tells the model not to call tools instead.


## Compared with Claude Code

Claude Code
([`idleCompaction`](https://code.claude.com/docs/en/settings-reference#idlecompaction),
[prompt caching](https://code.claude.com/docs/en/prompt-caching)) compacts a conversation that has been idle
about 54 minutes, when it is on the one-hour cache TTL and the context has reached 200k tokens (floor 100k).
This extension does the same with the timing derived from the model's own lifetime
(`min(0.9 x lifetime, lifetime - 60s)`), and adds what Claude Code does separately and without documentation:
the stubbing here corresponds to the time-based microcompact visible in the 2.1.307 binary (after about 65
minutes idle the first request clears old tool results, keeping the last 12, only if it frees at least 20k
tokens). Those two numbers were read from the binary, not from the docs.

Differences: the lifetime is per model and configurable instead of fixed at one hour; the threshold
compaction is cost-model driven for providers with a cheap cached read; keepalive is capped by break-even
instead of unbounded.

## Development

```
nix develop        # node 24, biome
npm install
npm test           # node --test, no build step
npm run typecheck
npm run format
```

`scripts/live-verify` drives a real pi process over RPC against a real model (it spends money); it needs an
agent directory containing the provider configuration to use.

## License

MIT
