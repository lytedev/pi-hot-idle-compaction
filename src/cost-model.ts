export type ModelPrices = {
  uncachedInputDollarsPerMillionTokens: number;
  cachedReadDollarsPerMillionTokens: number;
  cacheWriteDollarsPerMillionTokens: number;
  outputDollarsPerMillionTokens: number;
};

const TOKENS_PER_MILLION = 1_000_000;

function dollarsForTokens(tokens: number, dollarsPerMillionTokens: number): number {
  return (tokens * dollarsPerMillionTokens) / TOKENS_PER_MILLION;
}

export function pricePerMillionTokensToRewriteAColdPrefix(prices: ModelPrices): number {
  return Math.max(
    prices.uncachedInputDollarsPerMillionTokens,
    prices.cacheWriteDollarsPerMillionTokens,
  );
}

export function coldMissCostDollars(prices: ModelPrices, contextTokens: number): number {
  return dollarsForTokens(contextTokens, pricePerMillionTokensToRewriteAColdPrefix(prices));
}

export function stubbedResumeCostDollars(
  prices: ModelPrices,
  contextTokens: number,
  fractionOfContextRemoved: number,
): number {
  return coldMissCostDollars(prices, contextTokens * (1 - fractionOfContextRemoved));
}

export function cacheHittingSummaryCostDollars(
  prices: ModelPrices,
  contextTokens: number,
  summaryInstructionTokens: number,
  summaryOutputTokens: number,
): number {
  return (
    dollarsForTokens(contextTokens, prices.cachedReadDollarsPerMillionTokens) +
    dollarsForTokens(summaryInstructionTokens, prices.uncachedInputDollarsPerMillionTokens) +
    dollarsForTokens(summaryOutputTokens, prices.outputDollarsPerMillionTokens)
  );
}

export function keepalivePingCostDollars(prices: ModelPrices, contextTokens: number): number {
  const oneOutputToken = 1;
  return (
    dollarsForTokens(contextTokens, prices.cachedReadDollarsPerMillionTokens) +
    dollarsForTokens(oneOutputToken, prices.outputDollarsPerMillionTokens)
  );
}

export function breakEvenKeepalivePingCount(prices: ModelPrices, contextTokens: number): number {
  const pingCost = keepalivePingCostDollars(prices, contextTokens);
  if (pingCost <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(coldMissCostDollars(prices, contextTokens) / pingCost);
}

export function cacheReadCostPerPromptDollars(
  prices: ModelPrices,
  contextTokens: number,
  modelCallsPerPrompt: number,
): number {
  return (
    modelCallsPerPrompt * dollarsForTokens(contextTokens, prices.cachedReadDollarsPerMillionTokens)
  );
}
