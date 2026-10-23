export const OBSERVATION_ENTRY_TYPE = "hot-idle-observation";

export type CacheObservation = {
  gapSeconds: number;
  hit: boolean;
  prefixTokens: number;
};

export type ObservedCacheBehaviour = {
  observationCount: number;
  longestGapWithAHitSeconds: number | undefined;
  shortestGapWithAMissSeconds: number | undefined;
};

export function summariseObservations(
  observations: readonly CacheObservation[],
): ObservedCacheBehaviour {
  const hitGaps = observations.filter((observation) => observation.hit).map((o) => o.gapSeconds);
  const missGaps = observations.filter((observation) => !observation.hit).map((o) => o.gapSeconds);
  return {
    observationCount: observations.length,
    longestGapWithAHitSeconds: hitGaps.length > 0 ? Math.max(...hitGaps) : undefined,
    shortestGapWithAMissSeconds: missGaps.length > 0 ? Math.min(...missGaps) : undefined,
  };
}

export function judgeObservation(input: {
  gapSeconds: number;
  tokensInPreviousRequestPrefix: number | undefined;
  cacheReadTokens: number;
  minimumPrefixTokensWorthJudging: number;
  prefixWasIntentionallyChanged: boolean;
}): CacheObservation | undefined {
  const previousPrefix = input.tokensInPreviousRequestPrefix;
  if (previousPrefix === undefined || input.prefixWasIntentionallyChanged) return undefined;
  if (previousPrefix < input.minimumPrefixTokensWorthJudging) return undefined;
  return {
    gapSeconds: input.gapSeconds,
    hit: input.cacheReadTokens >= previousPrefix / 2,
    prefixTokens: previousPrefix,
  };
}

function formatMinutes(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`;
}

export function describeObservedBehaviour(observed: ObservedCacheBehaviour): string {
  if (observed.observationCount === 0) return "observed: nothing yet";
  const hits =
    observed.longestGapWithAHitSeconds === undefined
      ? "no cache hits yet"
      : `cache hits after gaps up to ${formatMinutes(observed.longestGapWithAHitSeconds)}`;
  const misses =
    observed.shortestGapWithAMissSeconds === undefined
      ? "no misses yet"
      : `misses after gaps from ${formatMinutes(observed.shortestGapWithAMissSeconds)}`;
  return `observed over ${observed.observationCount} requests: ${hits}, ${misses}`;
}
