import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import {
  decideThresholdCompaction,
  decideWhetherScheduledSummaryMayRun,
  judgeSummaryCacheRead,
  planIdleSummary,
  planKeepalivePing,
  predictWhetherCachedSummaryCanHit,
  secondsAfterLastActivityToSummarise,
} from "../src/policy.ts";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings.ts";

const MINUTE = 60_000;
const lastActivity = 1_000_000_000_000;

describe("threshold compaction", () => {
  test("nothing_happens_below_the_minimum_context_even_when_the_threshold_is_lower", () => {
    const decision = decideThresholdCompaction({
      contextTokens: 50_000,
      minContextTokens: 100_000,
      compactAtTokens: 40_000,
    });
    assert.equal(
      decision.action,
      "none",
      `the floor must veto compaction but the decision was ${JSON.stringify(decision)}`,
    );
  });

  test("nothing_happens_between_the_floor_and_the_threshold", () => {
    const decision = decideThresholdCompaction({
      contextTokens: 200_000,
      minContextTokens: 100_000,
      compactAtTokens: 300_000,
    });
    assert.equal(
      decision.action,
      "none",
      `200000 is under the 300000 threshold but the decision was ${JSON.stringify(decision)}`,
    );
  });

  test("compaction_starts_exactly_when_the_context_reaches_the_threshold", () => {
    const decision = decideThresholdCompaction({
      contextTokens: 300_000,
      minContextTokens: 100_000,
      compactAtTokens: 300_000,
    });
    assert.equal(
      decision.action,
      "compact",
      `reaching the threshold exactly must compact but the decision was ${JSON.stringify(decision)}`,
    );
  });
});

describe("idle summary scheduling", () => {
  const bigContext = 400_000;

  test("on_a_one_hour_lifetime_the_summary_is_scheduled_fifty_four_minutes_after_the_last_activity", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      contextTokens: bigContext,
      settings: DEFAULT_SETTINGS,
    });
    assert.deepEqual(
      plan,
      { action: "schedule", fireAtEpochMilliseconds: lastActivity + 54 * MINUTE },
      `0.9 of 3600s is 54 minutes but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("on_a_five_minute_lifetime_the_sixty_second_margin_beats_ninety_percent", () => {
    assert.equal(
      secondsAfterLastActivityToSummarise(300),
      240,
      "min(270, 240) must be 240 seconds",
    );
  });

  test("a_lifetime_of_sixty_seconds_or_less_is_too_short_to_summarise_before_expiry", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 60,
      contextTokens: bigContext,
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(
      plan.action,
      "skip",
      `a 60 second lifetime leaves no safe margin but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_summary_is_scheduled_below_the_summary_minimum_context", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      contextTokens: 200_000,
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(
      plan.action,
      "skip",
      `200000 is under the 250000 idle summary minimum but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_summary_is_scheduled_below_the_global_floor_even_if_the_summary_minimum_is_lower", () => {
    const settings = parseSettings({ idleSummary: { minContextTokens: 10_000 } });
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      contextTokens: 50_000,
      settings,
    });
    assert.equal(
      plan.action,
      "skip",
      `50000 is under the 100000 global floor but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_summary_is_scheduled_when_the_cache_lifetime_is_unknown", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: undefined,
      contextTokens: bigContext,
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(
      plan.action,
      "skip",
      `an unknown lifetime gives no deadline but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_summary_is_scheduled_when_the_cache_lifetime_is_longer_than_the_configured_maximum", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 86_400,
      contextTokens: bigContext,
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(
      plan.action,
      "skip",
      `a 24 hour lifetime is over the 7200 second maximum but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_summary_is_scheduled_when_the_extension_is_disabled", () => {
    const plan = planIdleSummary({
      lastActivityEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      contextTokens: bigContext,
      settings: parseSettings({ enabled: false }),
    });
    assert.equal(
      plan.action,
      "skip",
      `the master switch must veto scheduling but the plan was ${JSON.stringify(plan)}`,
    );
  });
});

describe("whether a scheduled summary may run", () => {
  const onTimeAndQuiet = {
    nowEpochMilliseconds: lastActivity + 54 * MINUTE + 1000,
    scheduledForEpochMilliseconds: lastActivity + 54 * MINUTE,
    lateToleranceSeconds: 60,
    agentIsIdle: true,
    messagesArePending: false,
    lastActivityEpochMillisecondsWhenScheduled: lastActivity,
    lastActivityEpochMillisecondsNow: lastActivity,
  };

  test("an_on_time_summary_on_an_idle_agent_runs", () => {
    assert.equal(
      decideWhetherScheduledSummaryMayRun(onTimeAndQuiet).action,
      "run",
      "one second late on an idle agent must run",
    );
  });

  test("a_summary_firing_more_than_sixty_seconds_late_is_refused_because_the_cache_may_be_gone", () => {
    const decision = decideWhetherScheduledSummaryMayRun({
      ...onTimeAndQuiet,
      nowEpochMilliseconds: lastActivity + 54 * MINUTE + 61_000,
    });
    assert.equal(
      decision.action,
      "refuse",
      `61 seconds late exceeds the tolerance but the decision was ${JSON.stringify(decision)}`,
    );
  });

  test("a_summary_is_refused_when_a_newer_request_has_happened_since_it_was_scheduled", () => {
    const decision = decideWhetherScheduledSummaryMayRun({
      ...onTimeAndQuiet,
      lastActivityEpochMillisecondsNow: lastActivity + 10 * MINUTE,
    });
    assert.equal(
      decision.action,
      "refuse",
      `a stale schedule must not run but the decision was ${JSON.stringify(decision)}`,
    );
  });

  test("a_summary_is_refused_while_the_agent_is_busy", () => {
    assert.equal(
      decideWhetherScheduledSummaryMayRun({ ...onTimeAndQuiet, agentIsIdle: false }).action,
      "refuse",
      "a busy agent must veto the summary",
    );
  });

  test("a_summary_is_refused_while_messages_are_queued", () => {
    assert.equal(
      decideWhetherScheduledSummaryMayRun({ ...onTimeAndQuiet, messagesArePending: true }).action,
      "refuse",
      "queued messages must veto the summary",
    );
  });
});

describe("judging whether a summary request really hit the cache", () => {
  test("a_summary_that_read_ninety_percent_of_the_prefix_from_cache_is_usable", () => {
    const verdict = judgeSummaryCacheRead({
      cacheReadTokens: 360_000,
      contextTokensSentAsPrefix: 400_000,
      minimumCacheReadFraction: 0.8,
    });
    assert.equal(
      verdict.usable,
      true,
      `90% read is above the 80% requirement but the verdict was ${JSON.stringify(verdict)}`,
    );
  });

  test("a_summary_that_read_less_than_eighty_percent_from_cache_is_not_usable", () => {
    const verdict = judgeSummaryCacheRead({
      cacheReadTokens: 319_999,
      contextTokensSentAsPrefix: 400_000,
      minimumCacheReadFraction: 0.8,
    });
    assert.equal(
      verdict.usable,
      false,
      `319999 of 400000 is under 80% but the verdict was ${JSON.stringify(verdict)}`,
    );
  });
});

describe("keepalive planning", () => {
  const keepaliveOn = parseSettings({ keepalive: { enabled: true } });
  const planAfter = (
    pingsAlreadySent: number,
    breakEvenPingCount: number,
    settings = keepaliveOn,
  ) =>
    planKeepalivePing({
      lastCacheTouchEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      pingsAlreadySent,
      breakEvenPingCount,
      settings,
    });

  test("keepalive_is_off_by_default", () => {
    const plan = planKeepalivePing({
      lastCacheTouchEpochMilliseconds: lastActivity,
      ttlSeconds: 3600,
      pingsAlreadySent: 0,
      breakEvenPingCount: 30,
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(
      plan.action,
      "stop",
      `defaults must not ping but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("the_first_ping_is_scheduled_fifty_four_minutes_after_the_last_cache_touch", () => {
    assert.deepEqual(
      planAfter(0, 30),
      { action: "ping", atEpochMilliseconds: lastActivity + 54 * MINUTE },
      "pings follow the same 0.9 of the lifetime rule as summaries",
    );
  });

  test("pings_stop_once_the_break_even_count_has_been_sent", () => {
    const plan = planAfter(30, 30);
    assert.equal(
      plan.action,
      "stop",
      `30 pings sent with a break-even of 30 must stop but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("pings_continue_while_below_the_break_even_count", () => {
    assert.equal(planAfter(29, 30).action, "ping", "29 of 30 pings must still allow one more");
  });

  test("an_explicit_maximum_below_the_break_even_count_stops_pings_earlier", () => {
    const plan = planAfter(3, 30, parseSettings({ keepalive: { enabled: true, maximumPings: 3 } }));
    assert.equal(
      plan.action,
      "stop",
      `the configured cap of 3 must win over the break-even 30 but the plan was ${JSON.stringify(plan)}`,
    );
  });

  test("no_ping_is_planned_when_the_cache_lifetime_is_unknown", () => {
    const plan = planKeepalivePing({
      lastCacheTouchEpochMilliseconds: lastActivity,
      ttlSeconds: undefined,
      pingsAlreadySent: 0,
      breakEvenPingCount: 30,
      settings: keepaliveOn,
    });
    assert.equal(
      plan.action,
      "stop",
      `an unknown lifetime gives no deadline but the plan was ${JSON.stringify(plan)}`,
    );
  });
});

describe("predicting whether a cache-hitting summary can hit the cache", () => {
  const prediction = (
    overrides: Partial<Parameters<typeof predictWhetherCachedSummaryCanHit>[0]> = {},
  ) =>
    predictWhetherCachedSummaryCanHit({
      tokensInLastRequestPrefix: 380_000,
      contextTokens: 400_000,
      minimumCacheReadFraction: 0.8,
      idleMilliseconds: 10 * MINUTE,
      ttlSeconds: 3600,
      ...overrides,
    });

  test("a_context_that_is_ninety_five_percent_the_last_request_and_still_inside_the_lifetime_is_worth_attempting", () => {
    const result = prediction();
    assert.equal(
      result.worthAttempting,
      true,
      `380000 of 400000 tokens cached inside the lifetime must be attempted but was ${JSON.stringify(result)}`,
    );
  });

  test("a_context_that_just_gained_a_huge_uncached_tool_result_is_not_worth_attempting", () => {
    const result = prediction({ tokensInLastRequestPrefix: 2_000, contextTokens: 116_000 });
    assert.equal(
      result.worthAttempting,
      false,
      `only 2% was in the last request so a default summary is cheaper but was ${JSON.stringify(result)}`,
    );
  });

  test("a_cache_that_has_outlived_its_lifetime_is_not_worth_attempting", () => {
    const result = prediction({ idleMilliseconds: 3601 * 1000 });
    assert.equal(
      result.worthAttempting,
      false,
      `3601s idle on a 3600s lifetime means a cold prefix but was ${JSON.stringify(result)}`,
    );
  });

  test("an_unknown_lifetime_is_not_worth_attempting_because_expiry_cannot_be_ruled_out", () => {
    assert.equal(
      prediction({ ttlSeconds: undefined }).worthAttempting,
      false,
      "without a lifetime the cache may be gone",
    );
  });

  test("no_previous_request_means_nothing_can_be_cached", () => {
    assert.equal(
      prediction({ tokensInLastRequestPrefix: undefined }).worthAttempting,
      false,
      "a fresh process has no shared prefix",
    );
  });
});
