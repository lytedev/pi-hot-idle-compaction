# pi-hot-idle-compaction

> **100% AI-written software.** Every line of code, tests and documentation in this repository was written
> by AI coding agents, directed by a human maintainer. Licensed under the [MIT License](LICENSE).

A [pi](https://github.com/earendil-works/pi) extension that keeps long sessions cheap on providers whose
prompt cache expires. It summarises while the cache is still warm, drops stale tool output instead of paying
to re-read it, and can keep the cache alive for exactly as long as that is cheaper than missing it.

```
pi install npm:pi-hot-idle-compaction
```

Requires pi 1.4.0 or newer. It works with any provider that reports `cacheRead` token usage. Nothing here is
tuned to one provider: the cache lifetime and every threshold are settings, and
[Choosing your values](#choosing-your-values) explains how to pick them from your own prices.

## Why

A request that follows a long session re-sends the whole conversation. If the provider still holds it in its
prompt cache you pay the cached-read price; if the cache expired while you were away you pay the uncached
price for every token again.

Write `C` for the context size in tokens, `u` for the uncached input price, `r` for the cached-read price and
`o` for the output price (all per token). The cost of one return after a break:

| What happens on return                                    | Cost              |
| --------------------------------------------------------- | ----------------- |
| Cache expired, nothing done (cold miss)                   | `C*u`             |
| Old tool results stubbed on resume, fraction `f` removed  | `(1-f)*C*u`       |
| Summary sent before expiry and served from cache          | `C*r + S*u + O*o` |
| Cache read on each model call while the context stays big | `C*r` per call    |

`S` is the instruction appended to ask for the summary (a few hundred tokens) and `O` the summary length.
Worked example with DeepSeek V4 Pro prices from one provider (`u` = $0.66/M, `r` = $0.022/M, `o` = $1.98/M)
at `C` = 400k: a cold miss costs $0.26, stubbing 60% costs $0.11, a cache-hitting summary of 8k tokens costs
about $0.025, and each model call on that context costs $0.009 in cache reads, so a 17-call prompt costs
$0.15 in reads alone. Your numbers will differ; the shape is what matters. Because cache reads recur on every
call, a lower compaction threshold usually repays a cheap summary within about one prompt.

pi's built-in compaction cannot do the third row. Its summariser serialises the conversation to text (tool
results truncated to 2000 characters) and disables cache writes, so it never reads the prompt cache. This
extension instead replays the exact transcript of the last request and appends one user message asking for the
summary, so the provider serves the whole prefix from its cache.

## What it does

1. **Floor.** Below `minContextTokens` it does nothing.
2. **Threshold compaction.** When a prompt finishes (`agent_settled`) and the context is at least
   `compactAtTokens`, it compacts using the cache-hitting summary. Deciding between prompts is deliberate:
   `ctx.compact()` aborts a run in progress, and the prefix of the request that just finished is entirely
   cached.
3. **Lazy stubbing.** On the first request after an idle gap longer than the cache lifetime plus
   `stubbing.graceSeconds`, old tool results are replaced by a stub naming the tool and its arguments, so the
   model can re-run it. The newest `keepMostRecentToolUses` are never touched, and only if stubbing clears at
   least `minimumTokensCleared` tokens and `minimumFractionOfContextCleared` of the context. The stubbed ids are
   persisted in the session and applied identically on every later request, so the prefix stays stable and the
   following calls hit the cache again.
4. **Idle summary.** While idle, at `min(0.9 x lifetime, lifetime - 60s)` after the last request, it compacts
   with a cache-hitting summary, but only if the context is at least `summaryMinTokens` and the lifetime is at
   most `idleSummary.maximumTtlSeconds`. It refuses if it fires more than `idleSummary.lateToleranceSeconds`
   late (a sleeping laptop), if a newer request exists, or if the agent is busy.
5. **Keepalive (off by default).** Re-sends the last request with a one-token output cap before expiry, capped
   at the break-even count (the most pings whose total cost does not exceed one cold miss) and by
   `keepalive.maximumPings`.

`/hot-idle` shows the context size, the lifetime and where it came from, the next scheduled action, the
stubbed count, what the cache has actually done (below) and the money ledger. Every action is also a
`hot-idle-action` entry in the session.

### When the cache-hitting summary is skipped

It falls back to pi's own summary when it cannot be cheaper:

- the cache already expired;
- less than `summary.minimumCacheReadFraction` (0.8) of the context was in the last request, for example right
  after ten large tool results landed in one turn;
- an earlier cache-hitting summary in this session read less than that fraction from the cache. That summary
  is still kept (redoing it would pay twice) but later ones are disabled for the session.

## Cache lifetime

The extension needs to know how long your provider keeps a prefix. In order:

1. `hotIdleCompaction.perModel["provider/model"].ttlSeconds`, then `perProvider["provider"].ttlSeconds`, then
   the global `ttlSeconds`.
2. The model's own `promptCache` declaration in pi
   ([models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#prompt-cache-lifetimes)).
3. A guess of 300 seconds, the common short lifetime. `/hot-idle` says so when it is guessing.

Provider documentation is the best source. Failing that, watch `/hot-idle`: it passively records, for each
request, the idle gap before it and whether the provider served the previous prefix from cache, and reports
"cache hits after gaps up to X min, misses after gaps from Y min". It never changes a setting; set
`ttlSeconds` yourself from that evidence, rounding down.

## Settings

Under `hotIdleCompaction` in `~/.pi/agent/settings.json` or `.pi/settings.json`. Every key is optional.

| Key                                        | Default                     | Meaning                                            |
| ------------------------------------------ | --------------------------- | -------------------------------------------------- |
| `enabled`                                  | `true`                      | Master switch                                      |
| `ttlSeconds`                               | model declaration, else 300 | Cache lifetime                                     |
| `minContextTokens`                         | 100000                      | Do nothing below this                              |
| `compactAtTokens`                          | 300000                      | Threshold compaction                               |
| `summary.maxOutputTokens`                  | 8000                        | Summary length cap (`O`)                           |
| `summary.minimumCacheReadFraction`         | 0.8                         | Required cached share of the summary prefix        |
| `stubbing.enabled`                         | `true`                      |                                                    |
| `stubbing.graceSeconds`                    | 60                          | Idle beyond lifetime + this before stubbing        |
| `stubbing.keepMostRecentToolUses`          | 12                          | Never stubbed                                      |
| `stubbing.minimumTokensCleared`            | 20000                       |                                                    |
| `stubbing.minimumFractionOfContextCleared` | 0.3                         |                                                    |
| `idleSummary.enabled`                      | `true`                      |                                                    |
| `idleSummary.minContextTokens`             | 250000                      | `summaryMinTokens`                                 |
| `idleSummary.maximumTtlSeconds`            | 7200                        | Longer lifetimes are rarely outlasted by idle gaps |
| `idleSummary.lateToleranceSeconds`         | 60                          | Refuse when firing later than this                 |
| `keepalive.enabled`                        | `false`                     |                                                    |
| `keepalive.maximumPings`                   | none                        | Cap below the break-even count                     |

Eight of these can be overridden per provider (`perProvider["provider"]`) or per model
(`perModel["provider/model"]`, which wins): `ttlSeconds`, `minContextTokens`, `compactAtTokens`,
`summaryMinTokens`, `keepMostRecentToolUses`, `minimumTokensCleared`, `minimumFractionOfContextCleared` and
`keepaliveMaximumPings`. An unknown override key is an error, so typos are not silently ignored.

```json
{
  "hotIdleCompaction": {
    "ttlSeconds": 300,
    "compactAtTokens": 250000,
    "perProvider": { "my-gateway": { "ttlSeconds": 3600 } },
    "perModel": {
      "my-gateway/big-model": { "compactAtTokens": 200000, "keepMostRecentToolUses": 8 }
    }
  }
}
```

## Choosing your values

Everything below uses `C`, `u`, `r`, `o` from [Why](#why).

- **`ttlSeconds`**: from your provider's documentation or the `/hot-idle` observations. Too long is the costly
  error: the extension then believes a dead cache is warm, so summaries cost `C*u` instead of `C*r`. When
  unsure, pick the shorter value.
- **`minContextTokens`**: below this nothing is worth doing. A cold miss costs `C*u`, so choose the context
  size where `C*u` stops mattering to you. If a miss at 100k costs a tenth of a cent, raise it.
- **`compactAtTokens`**: compaction pays when the cache reads it avoids exceed its cost. A summary costs about
  `C*r + O*o + S*u` and shrinks the context from `C` to about `C'` (summary plus kept tail). Each following
  model call saves `(C-C')*r`, so it repays after `(C*r + O*o + S*u) / ((C-C')*r)` calls, which is a few
  calls when `u/r` is large. Models with expensive reads or many calls per prompt want a lower threshold.
  Never exceed the model's context window minus pi's `reserveTokens`.
- **`summaryMinTokens`** (`idleSummary.minContextTokens`): the idle summary replaces a possible cold miss, so
  it is worth its cost `C*r + O*o + S*u` only when `C*u` is clearly larger: roughly when `u/r > 3` and `C*u`
  exceeds what you care about. Default 250k.
- **`stubbing.keepMostRecentToolUses`**: what the model is most likely still working from. Raise it for tasks
  that revisit recent files.
- **`stubbing.minimumTokensCleared` / `minimumFractionOfContextCleared`**: stubbing breaks the prefix, so the
  whole stubbed context is rewritten at `(1-f)*C*u`. It only beats keeping everything (a cold miss at `C*u`)
  by `f*C*u`; below your noise floor it is not worth the lost detail. These two stop small, low-value stubs.
- **`keepalive.maximumPings`**: a ping costs about `C*r`; the break-even count is `C*u / (C*r)`, about `u/r`
  pings. Keepalive only pays if you return before that many lifetimes pass, so cap it at the number of
  lifetimes you realistically leave a session idle (a lunch break is 12 pings at a 5 minute lifetime).

## Compared with Claude Code

Claude Code
([`idleCompaction`](https://code.claude.com/docs/en/settings-reference#idlecompaction),
[prompt caching](https://code.claude.com/docs/en/prompt-caching)) compacts a conversation that has been idle
about 54 minutes, when it is on the one-hour cache lifetime and the context has reached 200k tokens (floor
100k). This extension does the same with the timing derived from the model's own lifetime
(`min(0.9 x lifetime, lifetime - 60s)`), and adds what Claude Code does separately: the stubbing here
corresponds to the time-based microcompact visible in the 2.1.307 binary (after about 65 minutes idle the
first request clears old tool results, keeping the last 12, only if it frees at least 20k tokens). Those
microcompact numbers were read from the binary, not from the documentation.

Differences: the lifetime is per provider or model and configurable instead of fixed at one hour, and
keepalive is capped by break-even instead of unbounded.

## herdr and Collie

[herdr](https://github.com/ogulcancelik/herdr)'s pi integration reports a pane as idle as soon as pi's agent
loop settles, and [Collie](https://github.com/AltanS/collie) mirrors that state to a phone. This extension does
real work while the loop is idle (idle summaries, threshold compaction, keepalive pings), so it announces each
piece as `herdr:working` on pi's extension event bus, `{ active: true, label }` when it starts and
`{ active: false }` when it ends, one pair per action. herdr counts these, so the pane shows working instead of
done while a summary runs. Where no listener exists the events do nothing. The extension opens no dialogs, so it
never needs `herdr:blocked`.

## Design notes

Things found while building this against a real OpenAI-compatible provider with automatic prefix caching.
They are properties of how pi and such providers behave, not measurements of any one provider's prices or
lifetimes.

- **Do not send `tool_choice: "none"` on the summary request.** Some providers render the prompt without the
  tool definitions when tool use is disabled, so the whole prefix differs and the cache misses completely. The
  summary instruction tells the model not to call tools instead.
- **`ctx.compact()` aborts a run in progress.** Called from `turn_end` it turned the in-flight request into an
  `aborted` error. Threshold compaction is therefore decided at `agent_settled`, between prompts, when the last
  request's prefix is also entirely cached. A single very long prompt can overshoot `compactAtTokens`; pi's own
  overflow recovery is the backstop.
- **The replay must end on a user message.** A request whose last message is an assistant message makes the
  provider continue it and answer with an empty stop. The summary instruction is therefore always appended as a
  user message.
- **A large uncached tail defeats the idea.** If ten large tool results land in one turn they are not in the
  cache, so a cache-hitting summary of that context reads almost nothing from it. `predictWhetherCachedSummaryCanHit`
  checks how much of the context was in the last request and falls back to pi's summariser otherwise.
- **pi's own summary can cost about the same on tool-heavy sessions.** Its serialiser truncates every tool
  result to 2000 characters, so when most of the context is tool output its summary request is small. The
  cache-hitting summary then wins on quality (it sees everything) rather than money. On conversations dominated
  by prose and code it is the cheaper one.
- **Token estimates for stubbing are calibrated on the session.** Each tool result's characters are scaled by
  `contextTokens / characters`, using pi's measured usage, because a fixed characters-per-token ratio was off
  by almost 2x on some text.
- **Cache hits are block-granular.** Providers report cached tokens in blocks (for example 256 or 128 tokens),
  so a fully cached prefix reads slightly less than its size; that is why the acceptance bar is a fraction
  (default 0.8), not equality.

## Testing

The test suite makes no network calls and costs nothing.

- `test/*.test.ts` unit-test the cost model and every decision as pure functions.
- `test/wire.integration.test.ts` runs a real pi session against a local fake chat-completions server that
  returns scripted `usage` including `cached_tokens`. It checks the wire format of the summary request:
  identical prefix, tool definitions present and unchanged, no `tool_choice`, final message a user instruction,
  and that a scripted cache miss disables later cache-hitting summaries.
- `test/extension.integration.test.ts` runs the real extension inside a real pi session
  (`createAgentSession`) against pi's faux provider, wrapped to simulate a prompt cache with a lifetime and
  driven by a manual clock. It checks that the summary request is the previous request's messages plus one
  instruction and reads the cache, that a miss disables later cache-hitting summaries, that stubs keep the
  newest tool uses and stay byte-identical on later requests, and that timers fire, cancel and refuse
  correctly.

```
nix develop        # node 24
npm install
npm test           # vp test (Vitest via Vite+)
npm run check      # vp check: format, lint and type checks
npm run format     # vp fmt
```

## License

MIT
