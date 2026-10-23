import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyStubs,
  planToolResultStubbing,
  type StubbableMessage,
  stubTextFor,
  type ToolUseCandidate,
} from "../src/stubbing.ts";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings.ts";

const MINUTE = 60_000;
const oneHourTtlSeconds = 3600;
const idleBeyondExpiry = 62 * MINUTE;

function toolUses(count: number, tokensEach: number): ToolUseCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    toolCallId: `call-${index}`,
    toolName: "read",
    resultTokens: tokensEach,
  }));
}

function plan(overrides: Partial<Parameters<typeof planToolResultStubbing>[0]> = {}) {
  return planToolResultStubbing({
    toolUsesOldestFirst: toolUses(40, 5_000),
    alreadyStubbedToolCallIds: new Set(),
    contextTokens: 250_000,
    idleMilliseconds: idleBeyondExpiry,
    ttlSeconds: oneHourTtlSeconds,
    settings: DEFAULT_SETTINGS,
    ...overrides,
  });
}

describe("planning tool result stubbing", () => {
  test("stubbing_never_touches_the_twelve_most_recent_tool_uses", () => {
    const result = plan();
    assert.equal(
      result.action,
      "stub",
      `40 tool uses of 5000 tokens must be stubbable but the plan was ${JSON.stringify(result)}`,
    );
    if (result.action !== "stub") return;
    const protectedIds = Array.from({ length: 12 }, (_, offset) => `call-${28 + offset}`);
    for (const protectedId of protectedIds) {
      assert.ok(
        !result.toolCallIdsToStub.includes(protectedId),
        `${protectedId} is among the 12 newest and must be kept but was stubbed`,
      );
    }
    assert.equal(result.toolCallIdsToStub.length, 28, "every older tool use must be stubbed");
  });

  test("nothing_is_stubbed_before_the_cache_lifetime_plus_the_grace_period_has_passed", () => {
    const result = plan({ idleMilliseconds: 60 * MINUTE + 59_000 });
    assert.equal(
      result.action,
      "none",
      `3659s idle is inside 3600s + 60s grace but the plan was ${JSON.stringify(result)}`,
    );
  });

  test("stubbing_starts_once_idle_time_exceeds_the_lifetime_plus_the_grace_period", () => {
    assert.equal(
      plan({ idleMilliseconds: 61 * MINUTE + 1 }).action,
      "stub",
      "just beyond 3660s idle must allow stubbing",
    );
  });

  test("nothing_is_stubbed_when_it_would_clear_fewer_than_twenty_thousand_tokens", () => {
    const result = plan({ toolUsesOldestFirst: toolUses(15, 5_000), contextTokens: 100_000 });
    assert.equal(
      result.action,
      "none",
      `3 old tool uses clear only 15000 tokens but the plan was ${JSON.stringify(result)}`,
    );
  });

  test("nothing_is_stubbed_when_it_would_clear_less_than_thirty_percent_of_the_context", () => {
    const result = plan({ toolUsesOldestFirst: toolUses(40, 1_000), contextTokens: 400_000 });
    assert.equal(
      result.action,
      "none",
      `28000 of 400000 tokens is 7% but the plan was ${JSON.stringify(result)}`,
    );
  });

  test("nothing_is_stubbed_below_the_minimum_context_floor", () => {
    const result = plan({ contextTokens: 90_000, toolUsesOldestFirst: toolUses(40, 2_500) });
    assert.equal(
      result.action,
      "none",
      `90000 tokens is under the 100000 floor but the plan was ${JSON.stringify(result)}`,
    );
  });

  test("nothing_is_stubbed_when_the_cache_lifetime_is_unknown", () => {
    assert.equal(
      plan({ ttlSeconds: undefined }).action,
      "none",
      "without a lifetime there is no way to know the cache expired",
    );
  });

  test("tool_uses_that_are_already_stubbed_are_not_counted_toward_the_tokens_cleared", () => {
    const alreadyStubbedToolCallIds = new Set(
      Array.from({ length: 20 }, (_, index) => `call-${index}`),
    );
    const result = plan({ alreadyStubbedToolCallIds, contextTokens: 250_000 });
    assert.equal(
      result.action,
      "none",
      `only 8 unstubbed old uses (40000 tokens, 16% of 250000) remain; if the 20 stubbed ones were recounted it would be 56% and stub, but the plan was ${JSON.stringify(result)}`,
    );
  });

  test("a_custom_number_of_recent_tool_uses_to_keep_is_honoured", () => {
    const result = plan({
      settings: parseSettings({ stubbing: { keepMostRecentToolUses: 30 } }),
      contextTokens: 150_000,
    });
    assert.equal(
      result.action,
      "stub",
      `10 old uses of 5000 tokens are 33% of 150000 but the plan was ${JSON.stringify(result)}`,
    );
    if (result.action !== "stub") return;
    assert.equal(
      result.toolCallIdsToStub.length,
      10,
      "with 30 kept out of 40, exactly the 10 oldest are stubbed",
    );
  });
});

describe("applying stubs to a transcript", () => {
  const transcript: StubbableMessage[] = [
    { role: "user", content: "look at the file" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "read",
      content: [{ type: "text", text: "file a contents" }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-b", name: "bash", arguments: { command: "ls" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "bash",
      content: [{ type: "text", text: "listing" }],
    },
  ];

  test("a_stubbed_result_names_the_tool_and_its_arguments_so_the_model_can_re_run_it", () => {
    const stubbed = applyStubs(transcript, new Set(["call-a"]));
    const text = JSON.stringify((stubbed[2] as { content: unknown }).content);
    assert.ok(
      text.includes("read") && text.includes('{\\"path\\":\\"a.ts\\"}'),
      `the stub must name the read tool and its path argument but was ${text}`,
    );
  });

  test("results_that_are_not_in_the_stub_set_are_returned_unchanged", () => {
    const stubbed = applyStubs(transcript, new Set(["call-a"]));
    assert.equal(
      stubbed[4],
      transcript[4],
      "the bash result was not stubbed and must be the identical object",
    );
  });

  test("applying_the_same_stub_set_twice_produces_byte_identical_transcripts_so_the_prefix_stays_stable", () => {
    const first = JSON.stringify(applyStubs(transcript, new Set(["call-a", "call-b"])));
    const second = JSON.stringify(applyStubs(transcript, new Set(["call-b", "call-a"])));
    assert.equal(
      first,
      second,
      "stubbing must not depend on set insertion order, time, or anything but the ids and transcript",
    );
  });

  test("the_input_transcript_is_never_mutated", () => {
    const before = JSON.stringify(transcript);
    applyStubs(transcript, new Set(["call-a"]));
    assert.equal(
      JSON.stringify(transcript),
      before,
      "the stored session messages must stay intact",
    );
  });

  test("very_long_arguments_are_truncated_in_the_stub_text", () => {
    const text = stubTextFor("bash", JSON.stringify({ command: "x".repeat(5000) }));
    assert.ok(text.length < 700, `the stub must stay small but was ${text.length} characters`);
  });
});
