import assert from "node:assert/strict";
import { describe, test, vi } from "vite-plus/test";
import { type RecordedRequest, ManualClock, settleMicrotasks, startSession } from "./harness.ts";

const SIX_TOOL_CHARACTERS = "x".repeat(4_000);

const smallScaleSettings = {
  minContextTokens: 1_000,
  compactAtTokens: 1_000_000,
  ttlSeconds: 600,
  idleSummary: { enabled: false, minContextTokens: 1_000 },
  stubbing: {
    enabled: false,
    graceSeconds: 10,
    keepMostRecentToolUses: 3,
    minimumTokensCleared: 1_000,
    minimumFractionOfContextCleared: 0.2,
  },
};

function settingsWith(overrides: Record<string, unknown>) {
  return { ...smallScaleSettings, ...overrides };
}

function lastOf<T>(items: T[]): T {
  return items[items.length - 1];
}

async function runPromptWithToolUses(
  harness: Awaited<ReturnType<typeof startSession>>,
  toolUseCount: number,
  promptText = "do the work",
) {
  for (let index = 0; index < toolUseCount; index++) {
    harness.scriptedReplies.push({
      kind: "tool",
      toolName: "bigtool",
      argument: `${index}:${SIX_TOOL_CHARACTERS}`,
    });
  }
  harness.scriptedReplies.push({ kind: "text", text: "done" });
  await harness.session.prompt(promptText);
  await settleMicrotasks();
}

function summaryRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.endsWithUserSummaryInstruction);
}

function compactionEntries(harness: Awaited<ReturnType<typeof startSession>>) {
  return harness.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

function customEntries(harness: Awaited<ReturnType<typeof startSession>>, customType: string) {
  return harness.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === customType);
}

describe("threshold compaction", () => {
  test("threshold_compaction_sends_the_identical_prefix_of_the_last_request_plus_one_summarise_message", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ compactAtTokens: 5_000 }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);

    const summaries = summaryRequests(harness.requests);
    assert.equal(
      summaries.length,
      1,
      `exactly one summarise request was expected after crossing 5000 tokens but there were ${summaries.length}`,
    );
    const summary = summaries[0];
    const requestBeforeSummary = harness.requests[harness.requests.indexOf(summary) - 1];
    for (let index = 0; index < requestBeforeSummary.messages.length; index++) {
      assert.deepEqual(
        summary.messages[index],
        requestBeforeSummary.messages[index],
        `message ${index} of the summarise request must be byte-identical to the previous request so the provider cache is hit`,
      );
    }
    assert.equal(
      summary.messages.length,
      requestBeforeSummary.messages.length + 2,
      "the summarise request must add exactly the final assistant reply and one user instruction to the previous request",
    );
    assert.ok(
      summary.cacheReadTokens >= 0.8 * summary.totalPromptTokens,
      `the simulated provider cache should have served at least 80% of the ${summary.totalPromptTokens} token prefix but served ${summary.cacheReadTokens}`,
    );
    const compaction = compactionEntries(harness)[0] as { summary: string; fromHook?: boolean };
    assert.equal(
      compaction?.summary,
      "## Goal\nfake summary",
      "the compaction entry must carry the cache-hitting summary",
    );
    assert.equal(compaction?.fromHook, true, "the compaction must be marked as extension provided");
    harness.session.dispose();
  });

  test("nothing_is_compacted_while_the_context_stays_under_the_threshold", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ compactAtTokens: 500_000 }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    assert.equal(
      compactionEntries(harness).length,
      0,
      "under the threshold no compaction may happen",
    );
    harness.session.dispose();
  });

  test("a_low_reported_cache_read_keeps_the_summary_and_makes_the_next_compaction_use_pis_own_summariser", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ compactAtTokens: 500_000 }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    harness.forceNextRequestToMissTheCache();
    await harness.session.compact();
    await settleMicrotasks();
    assert.equal(
      summaryRequests(harness.requests).length,
      1,
      "the first compaction must try a cache-hitting summary",
    );
    assert.ok(
      summaryRequests(harness.requests)[0].cacheReadTokens <
        0.8 * summaryRequests(harness.requests)[0].totalPromptTokens,
      "the simulated provider was told to miss, so the summary request must have read little from cache",
    );
    assert.equal(
      compactionEntries(harness).length,
      1,
      "the summary must be kept even though it missed the cache, since redoing it would pay twice",
    );

    await runPromptWithToolUses(harness, 3, "more work");
    await harness.session.compact();
    await settleMicrotasks();
    assert.equal(
      summaryRequests(harness.requests).length,
      1,
      "after a miss, cache-hitting summaries are disabled so no second summarise-instruction request may be sent",
    );
    assert.equal(
      compactionEntries(harness).length,
      2,
      "the second compaction must still happen, through pi's own summariser",
    );
    harness.session.dispose();
  });

  test("an_expired_cache_makes_compaction_use_pis_own_summariser_instead_of_a_cold_full_context_request", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ compactAtTokens: 500_000 }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    await clock.jumpSecondsThenFireEverythingDue(601);
    await harness.session.compact();
    await settleMicrotasks();
    assert.equal(
      summaryRequests(harness.requests).length,
      0,
      "601s after the last request on a 600s lifetime the cache is gone, so no cache-hitting request may be sent",
    );
    assert.equal(compactionEntries(harness).length, 1, "pi's own compaction must still run");
    harness.session.dispose();
  });
});

describe("lazy stubbing", () => {
  const stubbingSettings = settingsWith({
    ttlSeconds: 120,
    stubbing: { ...smallScaleSettings.stubbing, enabled: true },
  });

  function toolResultTexts(request: RecordedRequest) {
    return request.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => JSON.stringify(message.content));
  }

  test("stubbing_keeps_the_newest_tool_uses_replaces_older_ones_with_stubs_naming_the_tool_and_stays_byte_stable", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: stubbingSettings,
      cacheLifetimeSecondsOfFakeProvider: 100_000,
      clock,
    });
    await runPromptWithToolUses(harness, 8);
    const requestsBeforeResume = harness.requests.length;

    await clock.jumpSecondsThenFireEverythingDue(200);
    harness.scriptedReplies.push({ kind: "text", text: "back" });
    await harness.session.prompt("i am back");
    await settleMicrotasks();
    harness.scriptedReplies.push({ kind: "text", text: "again" });
    await harness.session.prompt("once more");
    await settleMicrotasks();
    harness.scriptedReplies.push({ kind: "text", text: "and again" });
    await harness.session.prompt("a third time");
    await settleMicrotasks();

    const resume = harness.requests[requestsBeforeResume];
    const results = toolResultTexts(resume);
    assert.equal(
      results.length,
      8,
      "the transcript still has 8 tool results, only their content changes",
    );
    const stubbed = results.filter((text) => text.includes("was removed to save tokens"));
    assert.equal(
      stubbed.length,
      5,
      `8 tool uses minus the 3 newest must be stubbed but ${stubbed.length} were`,
    );
    assert.ok(
      stubbed.every((text) => text.includes("bigtool")),
      "every stub must name the tool so the model can re-run it",
    );
    for (const kept of results.slice(-3)) {
      assert.ok(
        kept.includes("xxxx"),
        "the three most recent tool results must keep their original content",
      );
    }

    const later = harness.requests.slice(requestsBeforeResume + 1);
    assert.equal(later.length, 2, "two requests are expected after the resume request");
    for (const request of later) {
      assert.deepEqual(
        toolResultTexts(request).slice(0, 8),
        results,
        "every later request must carry the byte-identical stubbed tool results so the prefix stays cacheable",
      );
    }
    assert.ok(
      later[1].cacheReadTokens >= 0.8 * later[0].totalPromptTokens,
      `after stubbing the following requests must hit the cache again: read ${later[1].cacheReadTokens} of a ${later[0].totalPromptTokens} token prefix`,
    );
    assert.equal(
      customEntries(harness, "hot-idle-stubs").length,
      1,
      "the stubbed ids must be persisted exactly once",
    );
    harness.session.dispose();
  });

  test("a_short_idle_gap_inside_the_cache_lifetime_stubs_nothing", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: stubbingSettings,
      cacheLifetimeSecondsOfFakeProvider: 100_000,
      clock,
    });
    await runPromptWithToolUses(harness, 8);
    await clock.jumpSecondsThenFireEverythingDue(100);
    harness.scriptedReplies.push({ kind: "text", text: "back" });
    await harness.session.prompt("quick follow up");
    await settleMicrotasks();
    const joined = lastOf(harness.requests)
      .messages.map((message) => JSON.stringify(message.content))
      .join();
    assert.ok(
      !joined.includes("was removed to save tokens"),
      "100s idle on a 120s lifetime must not stub anything",
    );
    harness.session.dispose();
  });

  test("stubbing_is_restored_from_the_session_so_a_restarted_pi_still_sends_the_same_stubs", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: stubbingSettings,
      cacheLifetimeSecondsOfFakeProvider: 100_000,
      clock,
    });
    await runPromptWithToolUses(harness, 8);
    await clock.jumpSecondsThenFireEverythingDue(200);
    harness.scriptedReplies.push({ kind: "text", text: "back" });
    await harness.session.prompt("i am back");
    await settleMicrotasks();
    const stubEntry = customEntries(harness, "hot-idle-stubs")[0] as {
      data: { toolCallIds: string[] };
    };
    assert.equal(
      stubEntry.data.toolCallIds.length,
      5,
      "the five stubbed tool call ids must be stored in the session file",
    );
    harness.session.dispose();
  });
});

describe("idle summary timer", () => {
  const idleSettings = settingsWith({
    idleSummary: { enabled: true, minContextTokens: 1_000, lateToleranceSeconds: 60 },
  });

  test("the_idle_summary_fires_at_ninety_percent_of_the_lifetime_and_not_before", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: idleSettings,
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    assert.equal(
      clock.pendingTimerCount(),
      1,
      "one idle summary timer must be pending after the run settles",
    );
    await clock.advanceSeconds(539);
    assert.equal(
      summaryRequests(harness.requests).length,
      0,
      "539s into a 600s lifetime it is too early",
    );
    await clock.advanceSeconds(2);
    await settleMicrotasks();
    assert.equal(
      summaryRequests(harness.requests).length,
      1,
      "at 540s (90% of 600s) the idle summary must be requested",
    );
    const summary = summaryRequests(harness.requests)[0];
    assert.ok(
      summary.cacheReadTokens >= 0.8 * summary.totalPromptTokens,
      "the idle summary must be served from the cache",
    );
    harness.session.dispose();
  });

  test("an_idle_summary_that_fires_more_than_sixty_seconds_late_is_refused", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: idleSettings,
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    await clock.jumpSecondsThenFireEverythingDue(700);
    assert.equal(
      summaryRequests(harness.requests).length,
      0,
      "waking 160s after the scheduled time (a sleeping laptop) must not summarise on a dead cache",
    );
    assert.equal(compactionEntries(harness).length, 0, "no compaction may happen either");
    harness.session.dispose();
  });

  test("new_activity_cancels_the_pending_idle_summary_and_schedules_a_fresh_one", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: idleSettings,
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    await clock.advanceSeconds(300);
    harness.scriptedReplies.push({ kind: "text", text: "more" });
    await harness.session.prompt("keep going");
    await settleMicrotasks();
    assert.equal(
      clock.pendingTimerCount(),
      1,
      "exactly one timer must be pending, the stale one cancelled",
    );
    await clock.advanceSeconds(300);
    assert.equal(
      summaryRequests(harness.requests).length,
      0,
      "600s after the first run but only 300s after the second, nothing may fire yet",
    );
    harness.session.dispose();
  });

  test("a_context_below_the_idle_summary_minimum_schedules_nothing", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ idleSummary: { enabled: true, minContextTokens: 900_000 } }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    assert.equal(
      clock.pendingTimerCount(),
      0,
      "below idleSummary.minContextTokens no timer may be scheduled",
    );
    harness.session.dispose();
  });
});

describe("keepalive", () => {
  test("pings_are_sent_before_expiry_and_stop_at_the_configured_cap", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({
        keepalive: { enabled: true, maximumPings: 2 },
        idleSummary: { enabled: false },
      }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    const requestsBeforePings = harness.requests.length;
    for (let round = 0; round < 5; round++) await clock.advanceSeconds(541);
    await settleMicrotasks();
    const pings = harness.requests.length - requestsBeforePings;
    assert.equal(pings, 2, `keepalive.maximumPings is 2 but ${pings} pings were sent`);
    const ping = harness.requests[requestsBeforePings];
    assert.ok(
      ping.cacheReadTokens >= 0.8 * ping.totalPromptTokens,
      "a ping must be served from the cache it is keeping alive",
    );
    harness.session.dispose();
  });

  test("keepalive_sends_nothing_by_default", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ idleSummary: { enabled: false } }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 6);
    const before = harness.requests.length;
    await clock.advanceSeconds(5_000);
    assert.equal(
      harness.requests.length,
      before,
      "no requests may be sent while idle unless keepalive is enabled",
    );
    harness.session.dispose();
  });
});

describe("/hot-idle and passive calibration", () => {
  async function statusText(harness: Awaited<ReturnType<typeof startSession>>) {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(" "));
    });
    await harness.session.prompt("/hot-idle");
    await settleMicrotasks();
    spy.mockRestore();
    return logged.join("\n");
  }

  test("without_any_configured_or_declared_lifetime_the_status_says_the_five_minute_value_is_a_guess", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: {},
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    const text = await statusText(harness);
    assert.match(
      text,
      /prompt cache lifetime: 300s \(A GUESS/,
      `the fallback must be flagged as a guess in:\n${text}`,
    );
    harness.session.dispose();
  });

  test("a_configured_lifetime_is_reported_as_coming_from_settings", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: { ttlSeconds: 900 },
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    const text = await statusText(harness);
    assert.match(
      text,
      /prompt cache lifetime: 900s \(from your hotIdleCompaction settings\)/,
      `source missing in:\n${text}`,
    );
    harness.session.dispose();
  });

  test("observed_hits_and_misses_after_gaps_are_recorded_and_shown", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({ idleSummary: { enabled: false } }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    await runPromptWithToolUses(harness, 3);
    await clock.jumpSecondsThenFireEverythingDue(300);
    harness.scriptedReplies.push({ kind: "text", text: "a" });
    await harness.session.prompt("after five minutes");
    await settleMicrotasks();
    await clock.jumpSecondsThenFireEverythingDue(1_200);
    harness.scriptedReplies.push({ kind: "text", text: "b" });
    await harness.session.prompt("after twenty minutes");
    await settleMicrotasks();

    const text = await statusText(harness);
    assert.match(
      text,
      /cache hits after gaps up to 5\.0 min/,
      `the 300s hit must be reported in:\n${text}`,
    );
    assert.match(
      text,
      /misses after gaps from 20\.0 min/,
      `the 1200s miss must be reported in:\n${text}`,
    );
    harness.session.dispose();
  });
});

describe("herdr and collie integration", () => {
  test("background_work_is_announced_as_herdr_working_with_every_start_matched_by_a_stop", async () => {
    const clock = new ManualClock();
    const harness = await startSession({
      settings: settingsWith({
        idleSummary: { enabled: true, minContextTokens: 1_000 },
        keepalive: { enabled: true, maximumPings: 1 },
      }),
      cacheLifetimeSecondsOfFakeProvider: 600,
      clock,
    });
    const announcements: { active: boolean; label?: string }[] = [];
    harness.events.on("herdr:working", (payload) => announcements.push(payload as never));
    await runPromptWithToolUses(harness, 6);
    await clock.advanceSeconds(541);
    await settleMicrotasks();
    assert.ok(
      summaryRequests(harness.requests).length >= 1,
      "the idle summary must have run for this test to mean anything",
    );
    const starts = announcements.filter((announcement) => announcement.active);
    const stops = announcements.filter((announcement) => !announcement.active);
    assert.ok(
      starts.length >= 1,
      "the idle summary happens while pi's agent loop is idle, so herdr and Collie only see it if it is announced as working",
    );
    assert.equal(
      starts.length,
      stops.length,
      "herdr counts working announcements, so each start needs exactly one stop or the pane would show working forever",
    );
    assert.ok(
      starts.every((announcement) => typeof announcement.label === "string"),
      "starts carry a label that herdr can show",
    );
    harness.session.dispose();
  });
});
