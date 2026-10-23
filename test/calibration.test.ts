import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  describeObservedBehaviour,
  judgeObservation,
  summariseObservations,
} from "../src/calibration.ts";

const judgeable = {
  gapSeconds: 600,
  tokensInPreviousRequestPrefix: 50_000,
  cacheReadTokens: 49_000,
  minimumPrefixTokensWorthJudging: 2_000,
  prefixWasIntentionallyChanged: false,
};

describe("passive calibration", () => {
  test("a_request_that_read_most_of_the_previous_prefix_from_cache_is_a_hit", () => {
    assert.equal(
      judgeObservation(judgeable)?.hit,
      true,
      "49000 of 50000 cached must count as a hit",
    );
  });

  test("a_request_that_read_almost_nothing_from_cache_is_a_miss", () => {
    assert.equal(
      judgeObservation({ ...judgeable, cacheReadTokens: 0 })?.hit,
      false,
      "0 cached must count as a miss",
    );
  });

  test("a_request_after_stubbing_or_compaction_is_not_judged_because_the_prefix_changed_on_purpose", () => {
    assert.equal(
      judgeObservation({ ...judgeable, prefixWasIntentionallyChanged: true }),
      undefined,
      "an intentional change says nothing about the cache lifetime",
    );
  });

  test("a_prefix_below_the_provider_minimum_cacheable_size_is_not_judged", () => {
    assert.equal(
      judgeObservation({ ...judgeable, tokensInPreviousRequestPrefix: 500 }),
      undefined,
      "tiny prefixes miss for reasons unrelated to lifetime",
    );
  });

  test("the_first_request_of_a_process_is_not_judged", () => {
    assert.equal(
      judgeObservation({ ...judgeable, tokensInPreviousRequestPrefix: undefined }),
      undefined,
      "no previous prefix exists to compare with",
    );
  });

  test("the_summary_reports_the_longest_hit_gap_and_the_shortest_miss_gap", () => {
    const observed = summariseObservations([
      { gapSeconds: 60, hit: true, prefixTokens: 9000 },
      { gapSeconds: 900, hit: true, prefixTokens: 9000 },
      { gapSeconds: 4000, hit: false, prefixTokens: 9000 },
      { gapSeconds: 7000, hit: false, prefixTokens: 9000 },
    ]);
    assert.equal(observed.longestGapWithAHitSeconds, 900, "the longest gap that still hit is 900s");
    assert.equal(
      observed.shortestGapWithAMissSeconds,
      4000,
      "the shortest gap that missed is 4000s",
    );
  });

  test("the_description_names_hits_and_misses_in_minutes", () => {
    const text = describeObservedBehaviour(
      summariseObservations([
        { gapSeconds: 900, hit: true, prefixTokens: 9000 },
        { gapSeconds: 4200, hit: false, prefixTokens: 9000 },
      ]),
    );
    assert.match(text, /hits after gaps up to 15\.0 min/, `hit gap missing from: ${text}`);
    assert.match(text, /misses after gaps from 70\.0 min/, `miss gap missing from: ${text}`);
  });
});
