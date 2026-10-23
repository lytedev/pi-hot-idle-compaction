import type { HotIdleSettings } from "./settings.ts";

const MILLISECONDS_PER_SECOND = 1000;

export type ThresholdCompactionDecision =
  | { action: "compact"; reason: string }
  | { action: "none"; reason: string };

export function decideThresholdCompaction(input: {
  contextTokens: number;
  minContextTokens: number;
  compactAtTokens: number;
}): ThresholdCompactionDecision {
  if (input.contextTokens < input.minContextTokens) {
    return {
      action: "none",
      reason: `context of ${input.contextTokens} tokens is below the ${input.minContextTokens} token floor`,
    };
  }
  if (input.contextTokens < input.compactAtTokens) {
    return {
      action: "none",
      reason: `context of ${input.contextTokens} tokens has not reached the ${input.compactAtTokens} token threshold`,
    };
  }
  return {
    action: "compact",
    reason: `context of ${input.contextTokens} tokens reached the ${input.compactAtTokens} token threshold`,
  };
}

export type IdleSummaryPlan =
  | { action: "schedule"; fireAtEpochMilliseconds: number }
  | { action: "skip"; reason: string };

export function secondsAfterLastActivityToSummarise(ttlSeconds: number): number {
  return Math.min(0.9 * ttlSeconds, ttlSeconds - 60);
}

export function planIdleSummary(input: {
  lastActivityEpochMilliseconds: number;
  ttlSeconds: number | undefined;
  contextTokens: number;
  settings: HotIdleSettings;
}): IdleSummaryPlan {
  const { settings, ttlSeconds, contextTokens } = input;
  if (!settings.enabled || !settings.idleSummary.enabled) {
    return { action: "skip", reason: "idle summaries are disabled" };
  }
  if (ttlSeconds === undefined) {
    return { action: "skip", reason: "the prompt cache lifetime of this model is unknown" };
  }
  if (contextTokens < settings.minContextTokens) {
    return {
      action: "skip",
      reason: `context is below the ${settings.minContextTokens} token floor`,
    };
  }
  if (contextTokens < settings.idleSummary.minContextTokens) {
    return {
      action: "skip",
      reason: `context is below the ${settings.idleSummary.minContextTokens} token idle summary minimum`,
    };
  }
  if (ttlSeconds > settings.idleSummary.maximumTtlSeconds) {
    return {
      action: "skip",
      reason: `a ${ttlSeconds} second cache lifetime is longer than the ${settings.idleSummary.maximumTtlSeconds} seconds beyond which idle gaps rarely outlast it`,
    };
  }
  const secondsAfterActivity = secondsAfterLastActivityToSummarise(ttlSeconds);
  if (secondsAfterActivity <= 0) {
    return {
      action: "skip",
      reason: `a ${ttlSeconds} second cache lifetime is too short to summarise before it ends`,
    };
  }
  return {
    action: "schedule",
    fireAtEpochMilliseconds:
      input.lastActivityEpochMilliseconds + secondsAfterActivity * MILLISECONDS_PER_SECOND,
  };
}

export type IdleSummaryFiring = { action: "run" } | { action: "refuse"; reason: string };

export function decideWhetherScheduledSummaryMayRun(input: {
  nowEpochMilliseconds: number;
  scheduledForEpochMilliseconds: number;
  lateToleranceSeconds: number;
  agentIsIdle: boolean;
  messagesArePending: boolean;
  lastActivityEpochMillisecondsWhenScheduled: number;
  lastActivityEpochMillisecondsNow: number;
}): IdleSummaryFiring {
  const lateByMilliseconds = input.nowEpochMilliseconds - input.scheduledForEpochMilliseconds;
  if (lateByMilliseconds > input.lateToleranceSeconds * MILLISECONDS_PER_SECOND) {
    return {
      action: "refuse",
      reason: `fired ${Math.round(lateByMilliseconds / MILLISECONDS_PER_SECOND)} seconds late, so the cache has probably expired`,
    };
  }
  if (input.lastActivityEpochMillisecondsNow !== input.lastActivityEpochMillisecondsWhenScheduled) {
    return { action: "refuse", reason: "a newer request exists, so this schedule is stale" };
  }
  if (!input.agentIsIdle) {
    return { action: "refuse", reason: "the agent is not idle" };
  }
  if (input.messagesArePending) {
    return { action: "refuse", reason: "messages are queued for the agent" };
  }
  return { action: "run" };
}

export type SummaryCacheVerdict = { usable: true } | { usable: false; reason: string };

export function judgeSummaryCacheRead(input: {
  cacheReadTokens: number;
  contextTokensSentAsPrefix: number;
  minimumCacheReadFraction: number;
}): SummaryCacheVerdict {
  const requiredCacheReadTokens = input.minimumCacheReadFraction * input.contextTokensSentAsPrefix;
  if (input.cacheReadTokens >= requiredCacheReadTokens) {
    return { usable: true };
  }
  return {
    usable: false,
    reason: `summary request read ${input.cacheReadTokens} cached tokens but needed at least ${Math.ceil(requiredCacheReadTokens)} of the ${input.contextTokensSentAsPrefix} token prefix`,
  };
}

export type KeepalivePlan =
  | { action: "ping"; atEpochMilliseconds: number }
  | { action: "stop"; reason: string };

export function planKeepalivePing(input: {
  lastCacheTouchEpochMilliseconds: number;
  ttlSeconds: number | undefined;
  pingsAlreadySent: number;
  breakEvenPingCount: number;
  settings: HotIdleSettings;
}): KeepalivePlan {
  const { settings, ttlSeconds } = input;
  if (!settings.enabled || !settings.keepalive.enabled) {
    return { action: "stop", reason: "keepalive is disabled" };
  }
  if (ttlSeconds === undefined) {
    return { action: "stop", reason: "the prompt cache lifetime of this model is unknown" };
  }
  const secondsAfterTouch = secondsAfterLastActivityToSummarise(ttlSeconds);
  if (secondsAfterTouch <= 0) {
    return {
      action: "stop",
      reason: `a ${ttlSeconds} second cache lifetime is too short to refresh in time`,
    };
  }
  const pingLimit = Math.min(
    input.breakEvenPingCount,
    settings.keepalive.maximumPings ?? Number.POSITIVE_INFINITY,
  );
  if (input.pingsAlreadySent >= pingLimit) {
    return {
      action: "stop",
      reason: `${input.pingsAlreadySent} pings already sent, which reaches the limit of ${pingLimit} (the break-even count is ${input.breakEvenPingCount})`,
    };
  }
  return {
    action: "ping",
    atEpochMilliseconds:
      input.lastCacheTouchEpochMilliseconds + secondsAfterTouch * MILLISECONDS_PER_SECOND,
  };
}
