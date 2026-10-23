import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import {
  breakEvenKeepalivePingCount,
  cacheHittingSummaryCostDollars,
  cacheReadCostPerPromptDollars,
  coldMissCostDollars,
  keepalivePingCostDollars,
  type ModelPrices,
  stubbedResumeCostDollars,
} from "../src/cost-model.ts";

const deepseekProOnStreamLake: ModelPrices = {
  uncachedInputDollarsPerMillionTokens: 0.66,
  cachedReadDollarsPerMillionTokens: 0.022,
  cacheWriteDollarsPerMillionTokens: 0.66,
  outputDollarsPerMillionTokens: 1.98,
};

const anthropicStyleWithCacheWritePremium: ModelPrices = {
  uncachedInputDollarsPerMillionTokens: 3,
  cachedReadDollarsPerMillionTokens: 0.3,
  cacheWriteDollarsPerMillionTokens: 3.75,
  outputDollarsPerMillionTokens: 15,
};

describe("cost model", () => {
  test("a_cold_miss_on_four_hundred_thousand_tokens_costs_twenty_six_cents_at_deepseek_pro_prices", () => {
    const cost = coldMissCostDollars(deepseekProOnStreamLake, 400_000);
    assert.ok(
      Math.abs(cost - 0.264) < 1e-9,
      `400000 uncached tokens at $0.66 per million must cost $0.264 but the model said ${cost}`,
    );
  });

  test("a_cold_miss_is_priced_at_the_cache_write_price_when_writes_cost_more_than_uncached_input", () => {
    const cost = coldMissCostDollars(anthropicStyleWithCacheWritePremium, 1_000_000);
    assert.equal(
      cost,
      3.75,
      `rewriting a cold prefix must cost the $3.75 cache write price rather than the $3 input price but was ${cost}`,
    );
  });

  test("stubbing_sixty_percent_of_a_four_hundred_thousand_token_context_costs_eleven_cents_to_resume", () => {
    const cost = stubbedResumeCostDollars(deepseekProOnStreamLake, 400_000, 0.6);
    assert.ok(
      Math.abs(cost - 0.1056) < 1e-9,
      `the remaining 160000 tokens must be rewritten at $0.66 per million for $0.1056 but the model said ${cost}`,
    );
  });

  test("a_cache_hitting_summary_of_four_hundred_thousand_tokens_costs_about_four_cents", () => {
    const cost = cacheHittingSummaryCostDollars(deepseekProOnStreamLake, 400_000, 500, 8_000);
    assert.ok(
      cost > 0.024 && cost < 0.026,
      `400000 cached reads, 500 instruction tokens and 8000 output tokens must cost about $0.025 but the model said ${cost}`,
    );
  });

  test("a_cache_hitting_summary_is_cheaper_than_a_cold_miss_at_the_same_context_size", () => {
    const summary = cacheHittingSummaryCostDollars(deepseekProOnStreamLake, 400_000, 500, 8_000);
    const coldMiss = coldMissCostDollars(deepseekProOnStreamLake, 400_000);
    assert.ok(
      summary < coldMiss,
      `summary cost ${summary} must be below cold miss cost ${coldMiss}`,
    );
  });

  test("a_keepalive_ping_costs_one_cached_read_of_the_context_plus_one_output_token", () => {
    const cost = keepalivePingCostDollars(deepseekProOnStreamLake, 400_000);
    const expected = (400_000 * 0.022 + 1.98) / 1_000_000;
    assert.ok(Math.abs(cost - expected) < 1e-12, `expected ${expected} but the model said ${cost}`);
  });

  test("the_break_even_ping_count_is_the_most_pings_that_cost_no_more_than_one_cold_miss", () => {
    const pings = breakEvenKeepalivePingCount(deepseekProOnStreamLake, 400_000);
    const cost = keepalivePingCostDollars(deepseekProOnStreamLake, 400_000);
    const coldMiss = coldMissCostDollars(deepseekProOnStreamLake, 400_000);
    assert.ok(
      pings * cost <= coldMiss,
      `${pings} pings cost ${pings * cost} which exceeds the cold miss ${coldMiss}`,
    );
    assert.ok(
      (pings + 1) * cost > coldMiss,
      `one more ping (${pings + 1}) would still cost ${(pings + 1) * cost} which is within the cold miss ${coldMiss}, so ${pings} is not the maximum`,
    );
  });

  test("seventeen_cache_reads_of_eight_hundred_thousand_tokens_cost_thirty_cents_per_prompt", () => {
    const cost = cacheReadCostPerPromptDollars(deepseekProOnStreamLake, 800_000, 17);
    assert.ok(
      Math.abs(cost - 0.2992) < 1e-9,
      `expected $0.2992 per prompt but the model said ${cost}`,
    );
  });
});
