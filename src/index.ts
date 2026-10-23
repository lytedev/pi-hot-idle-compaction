import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ACTION_ENTRY_TYPE,
  type ActionKind,
  type ActionRecord,
  readActionRecords,
  readStubbedToolCallIds,
  STUB_ENTRY_TYPE,
  type StubRecord,
  totalsOf,
} from "./action-ledger.ts";
import {
  prefixTokensOf,
  SUMMARY_INSTRUCTION,
  sendCacheHittingRequest,
  textOf,
} from "./cache-hitting-request.ts";
import { ConversationCapture } from "./conversation-capture.ts";
import {
  breakEvenKeepalivePingCount,
  coldMissCostDollars,
  keepalivePingCostDollars,
  type ModelPrices,
  stubbedResumeCostDollars,
} from "./cost-model.ts";
import {
  decideThresholdCompaction,
  decideWhetherScheduledSummaryMayRun,
  judgeSummaryCacheRead,
  planIdleSummary,
  planKeepalivePing,
  predictWhetherCachedSummaryCanHit,
} from "./policy.ts";
import {
  compactAtTokensForModel,
  type HotIdleSettings,
  parseSettings,
  SETTINGS_KEY,
  ttlSecondsForModel,
} from "./settings.ts";
import {
  applyStubs,
  collectToolUsesOldestFirst,
  planToolResultStubbing,
  type StubbableMessage,
} from "./stubbing.ts";

const MILLISECONDS_PER_SECOND = 1000;
const FALLBACK_CHARACTERS_PER_TOKEN = 3;

type ScheduledAction = {
  kind: "idle-summary" | "keepalive-ping";
  fireAtEpochMilliseconds: number;
  timer: ReturnType<typeof setTimeout>;
};

function pricesOf(model: Model<Api>): ModelPrices {
  return {
    uncachedInputDollarsPerMillionTokens: model.cost.input,
    cachedReadDollarsPerMillionTokens: model.cost.cacheRead,
    cacheWriteDollarsPerMillionTokens: model.cost.cacheWrite,
    outputDollarsPerMillionTokens: model.cost.output,
  };
}

function modelKeyOf(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function declaredTtlSecondsOf(model: Model<Api>): number | undefined {
  return model.promptCache?.short ?? model.promptCache?.long;
}

function charactersInContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (sum, block) => sum + (block?.type === "text" ? String(block.text).length : 1000),
    0,
  );
}

function formatDollars(dollars: number): string {
  return `$${dollars.toFixed(dollars < 0.1 ? 4 : 2)}`;
}

function formatClockTime(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toLocaleTimeString();
}

export default function hotIdleCompaction(pi: ExtensionAPI) {
  const capture = new ConversationCapture();
  let stubbedToolCallIds = new Set<string>();
  let lastCacheTouchEpochMilliseconds: number | undefined;
  let scheduledAction: ScheduledAction | undefined;
  let keepalivePingsSentSinceActivity = 0;
  let originOfCompactionWeStarted: "idle-summary" | "threshold-compaction" | undefined;
  let compactionStartedByUsIsInFlight = false;
  let cachedSummariesDisabledBecause: string | undefined;
  let keepaliveDisabledBecause: string | undefined;
  let lastDeclinedReason: string | undefined;

  function settings(): HotIdleSettings {
    return parseSettings((pi.getSettings() as Record<string, unknown>)[SETTINGS_KEY]);
  }

  function ttlSecondsFor(model: Model<Api>): number | undefined {
    return ttlSecondsForModel(settings(), modelKeyOf(model), declaredTtlSecondsOf(model));
  }

  function recordAction(record: ActionRecord, context: ExtensionContext) {
    pi.appendEntry(ACTION_ENTRY_TYPE, record);
    if (context.hasUI) {
      context.ui.notify(
        `hot-idle: ${record.kind} (${record.detail}); cost ${formatDollars(record.actualCostDollars)}, est. saved ${formatDollars(record.estimatedSavedDollars)}`,
        "info",
      );
    }
  }

  function restoreStateFromSession(context: ExtensionContext) {
    const branch = context.sessionManager.getBranch();
    stubbedToolCallIds = readStubbedToolCallIds(branch);
    lastCacheTouchEpochMilliseconds = undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastCacheTouchEpochMilliseconds = entry.message.timestamp;
        break;
      }
    }
  }

  function cancelScheduledAction() {
    if (scheduledAction) clearTimeout(scheduledAction.timer);
    scheduledAction = undefined;
  }

  function schedule(
    kind: ScheduledAction["kind"],
    fireAtEpochMilliseconds: number,
    context: ExtensionContext,
  ) {
    cancelScheduledAction();
    const delay = Math.max(0, fireAtEpochMilliseconds - Date.now());
    const scheduledForActivity = lastCacheTouchEpochMilliseconds;
    scheduledAction = {
      kind,
      fireAtEpochMilliseconds,
      timer: setTimeout(() => {
        scheduledAction = undefined;
        void runScheduledAction(kind, fireAtEpochMilliseconds, scheduledForActivity, context);
      }, delay),
    };
    scheduledAction.timer.unref?.();
  }

  function planNextScheduledAction(context: ExtensionContext) {
    cancelScheduledAction();
    const model = context.model;
    if (!model || lastCacheTouchEpochMilliseconds === undefined) return;
    const currentSettings = settings();
    const contextTokens = context.getContextUsage()?.tokens;
    if (contextTokens === null || contextTokens === undefined) {
      lastDeclinedReason = "context size unknown until the next response";
      return;
    }
    const ttlSeconds = ttlSecondsFor(model);

    const summaryPlan = planIdleSummary({
      lastActivityEpochMilliseconds: lastCacheTouchEpochMilliseconds,
      ttlSeconds,
      contextTokens,
      settings: currentSettings,
    });
    if (summaryPlan.action === "schedule" && cachedSummariesDisabledBecause === undefined) {
      lastDeclinedReason = undefined;
      schedule("idle-summary", summaryPlan.fireAtEpochMilliseconds, context);
      return;
    }
    lastDeclinedReason =
      summaryPlan.action === "skip" ? summaryPlan.reason : cachedSummariesDisabledBecause;

    if (keepaliveDisabledBecause !== undefined || contextTokens < currentSettings.minContextTokens)
      return;
    const pingPlan = planKeepalivePing({
      lastCacheTouchEpochMilliseconds,
      ttlSeconds,
      pingsAlreadySent: keepalivePingsSentSinceActivity,
      breakEvenPingCount: breakEvenKeepalivePingCount(pricesOf(model), contextTokens),
      settings: currentSettings,
    });
    if (pingPlan.action === "ping") {
      schedule("keepalive-ping", pingPlan.atEpochMilliseconds, context);
    } else if (currentSettings.keepalive.enabled) {
      lastDeclinedReason = pingPlan.reason;
    }
  }

  async function runScheduledAction(
    kind: ScheduledAction["kind"],
    scheduledForEpochMilliseconds: number,
    activityWhenScheduled: number | undefined,
    context: ExtensionContext,
  ) {
    const currentSettings = settings();
    const permission = decideWhetherScheduledSummaryMayRun({
      nowEpochMilliseconds: Date.now(),
      scheduledForEpochMilliseconds,
      lateToleranceSeconds: currentSettings.idleSummary.lateToleranceSeconds,
      agentIsIdle: context.isIdle(),
      messagesArePending: context.hasPendingMessages(),
      lastActivityEpochMillisecondsWhenScheduled: activityWhenScheduled ?? 0,
      lastActivityEpochMillisecondsNow: lastCacheTouchEpochMilliseconds ?? 0,
    });
    if (permission.action === "refuse") {
      lastDeclinedReason = `${kind} refused: ${permission.reason}`;
      return;
    }
    if (kind === "idle-summary") {
      startCompaction("idle-summary", context);
    } else {
      await sendKeepalivePing(context);
    }
  }

  function startCompaction(
    origin: "idle-summary" | "threshold-compaction",
    context: ExtensionContext,
  ) {
    if (compactionStartedByUsIsInFlight) return;
    compactionStartedByUsIsInFlight = true;
    originOfCompactionWeStarted = origin;
    context.compact({
      onComplete: () => {
        compactionStartedByUsIsInFlight = false;
        originOfCompactionWeStarted = undefined;
      },
      onError: (error) => {
        compactionStartedByUsIsInFlight = false;
        originOfCompactionWeStarted = undefined;
        lastDeclinedReason = `${origin} failed: ${error.message}`;
      },
    });
  }

  async function sendKeepalivePing(context: ExtensionContext) {
    const model = context.model;
    const transcript = capture.transcriptThatNextRequestWouldStartWith();
    if (!model || !transcript) return;
    const outcome = await sendCacheHittingRequest({
      context,
      model,
      transcript,
      appendedUserInstruction: undefined,
      maximumOutputTokens: 1,
      thinkingLevel: context.thinkingLevel,
      signal: undefined,
    });
    if (outcome.kind === "failed") {
      keepaliveDisabledBecause = `ping failed: ${outcome.reason}`;
      return;
    }
    const currentSettings = settings();
    const verdict = judgeSummaryCacheRead({
      cacheReadTokens: outcome.usage.cacheRead,
      contextTokensSentAsPrefix: outcome.prefixTokensSent,
      minimumCacheReadFraction: currentSettings.summary.minimumCacheReadFraction,
    });
    lastCacheTouchEpochMilliseconds = Date.now();
    keepalivePingsSentSinceActivity += 1;
    if (!verdict.usable) {
      keepaliveDisabledBecause = `ping missed the cache: ${verdict.reason}`;
    }
    const prices = pricesOf(model);
    recordAction(
      {
        kind: "keepalive-ping",
        atEpochMilliseconds: Date.now(),
        contextTokens: outcome.prefixTokensSent,
        actualCostDollars: outcome.usage.cost.total,
        estimatedSavedDollars: 0,
        cacheReadTokens: outcome.usage.cacheRead,
        detail: `ping ${keepalivePingsSentSinceActivity}, expected ${formatDollars(keepalivePingCostDollars(prices, outcome.prefixTokensSent))}`,
      },
      context,
    );
    planNextScheduledAction(context);
  }

  pi.on("session_start", (_event, context) => {
    capture.forget();
    restoreStateFromSession(context);
    cachedSummariesDisabledBecause = undefined;
    keepaliveDisabledBecause = undefined;
  });

  pi.on("session_tree", (_event, context) => {
    restoreStateFromSession(context);
  });

  pi.on("session_shutdown", () => {
    cancelScheduledAction();
  });

  pi.on("agent_start", () => {
    cancelScheduledAction();
    keepalivePingsSentSinceActivity = 0;
  });

  pi.on("context", (event, context) => {
    const currentSettings = settings();
    const model = context.model;
    if (!currentSettings.enabled || !model) return;

    if (lastCacheTouchEpochMilliseconds !== undefined) {
      const charactersInContext = JSON.stringify(event.messages).length;
      const contextTokens =
        context.getContextUsage()?.tokens ??
        Math.ceil(charactersInContext / FALLBACK_CHARACTERS_PER_TOKEN);
      const tokensPerCharacterMeasuredOnThisContext = contextTokens / charactersInContext;
      const stubbableMessages = event.messages as StubbableMessage[];
      const plan = planToolResultStubbing({
        toolUsesOldestFirst: collectToolUsesOldestFirst(stubbableMessages, (message) =>
          Math.ceil(
            charactersInContent((message as { content?: unknown }).content) *
              tokensPerCharacterMeasuredOnThisContext,
          ),
        ),
        alreadyStubbedToolCallIds: stubbedToolCallIds,
        contextTokens,
        idleMilliseconds: Date.now() - lastCacheTouchEpochMilliseconds,
        ttlSeconds: ttlSecondsFor(model),
        settings: currentSettings,
      });
      if (plan.action === "stub") {
        for (const toolCallId of plan.toolCallIdsToStub) stubbedToolCallIds.add(toolCallId);
        const record: StubRecord = {
          atEpochMilliseconds: Date.now(),
          toolCallIds: plan.toolCallIdsToStub,
        };
        pi.appendEntry(STUB_ENTRY_TYPE, record);
        const prices = pricesOf(model);
        const fractionRemoved = plan.tokensCleared / contextTokens;
        recordAction(
          {
            kind: "stubbing",
            atEpochMilliseconds: Date.now(),
            contextTokens,
            actualCostDollars: 0,
            estimatedSavedDollars:
              coldMissCostDollars(prices, contextTokens) -
              stubbedResumeCostDollars(prices, contextTokens, fractionRemoved),
            detail: `stubbed ${plan.toolCallIdsToStub.length} old tool results, ${plan.tokensCleared} of ${contextTokens} tokens`,
          },
          context,
        );
      }
    }

    if (stubbedToolCallIds.size === 0) return;
    return {
      messages: applyStubs(
        event.messages as StubbableMessage[],
        stubbedToolCallIds,
      ) as AgentMessage[],
    };
  });

  pi.on("context_with_system", (event) => {
    capture.recordRequestAboutToBeSent(event.messages);
  });

  pi.on("message_end", (event) => {
    capture.recordMessageFinished(event.message);
    if (event.message.role === "assistant") lastCacheTouchEpochMilliseconds = Date.now();
  });

  pi.on("agent_settled", (event, context) => {
    const currentSettings = settings();
    const model = context.model;
    if (!currentSettings.enabled || !model) return;
    const contextTokens = context.getContextUsage()?.tokens;
    if (!event.aborted && contextTokens !== null && contextTokens !== undefined) {
      const decision = decideThresholdCompaction({
        contextTokens,
        minContextTokens: currentSettings.minContextTokens,
        compactAtTokens: compactAtTokensForModel(currentSettings, modelKeyOf(model)),
      });
      if (decision.action === "compact") {
        startCompaction("threshold-compaction", context);
        return;
      }
    }
    planNextScheduledAction(context);
  });

  pi.on("session_before_compact", async (event, context) => {
    const currentSettings = settings();
    const model = context.model;
    if (!currentSettings.enabled || !model) return;
    if (event.preparation.tokensBefore < currentSettings.minContextTokens) return;
    if (cachedSummariesDisabledBecause !== undefined) return;

    const transcript = capture.transcriptThatNextRequestWouldStartWith();
    if (!transcript || lastCacheTouchEpochMilliseconds === undefined) return;
    const prediction = predictWhetherCachedSummaryCanHit({
      tokensInLastRequestPrefix: capture.tokensInLastRequestPrefix(),
      contextTokens: event.preparation.tokensBefore,
      minimumCacheReadFraction: currentSettings.summary.minimumCacheReadFraction,
      idleMilliseconds: Date.now() - lastCacheTouchEpochMilliseconds,
      ttlSeconds: ttlSecondsFor(model),
    });
    if (!prediction.worthAttempting) {
      lastDeclinedReason = `used pi's own summary: ${prediction.reason}`;
      return;
    }

    const outcome = await sendCacheHittingRequest({
      context,
      model,
      transcript,
      appendedUserInstruction: SUMMARY_INSTRUCTION,
      maximumOutputTokens: currentSettings.summary.maxOutputTokens,
      thinkingLevel: context.thinkingLevel,
      signal: event.signal,
    });
    if (outcome.kind === "failed") {
      lastDeclinedReason = `cache-hitting summary failed (${outcome.reason}); fell back to pi's summary`;
      return;
    }
    const summary = textOf(outcome.message);
    if (summary === "") {
      lastDeclinedReason = "cache-hitting summary was empty; fell back to pi's summary";
      return;
    }

    const verdict = judgeSummaryCacheRead({
      cacheReadTokens: outcome.usage.cacheRead,
      contextTokensSentAsPrefix: outcome.prefixTokensSent,
      minimumCacheReadFraction: currentSettings.summary.minimumCacheReadFraction,
    });
    if (!verdict.usable) {
      cachedSummariesDisabledBecause = verdict.reason;
    }

    const origin: ActionKind = originOfCompactionWeStarted ?? "pi-compaction-with-cached-summary";
    const prices = pricesOf(model);
    recordAction(
      {
        kind: origin,
        atEpochMilliseconds: Date.now(),
        contextTokens: outcome.prefixTokensSent,
        actualCostDollars: outcome.usage.cost.total,
        estimatedSavedDollars: Math.max(
          0,
          coldMissCostDollars(prices, outcome.prefixTokensSent) - outcome.usage.cost.total,
        ),
        cacheReadTokens: outcome.usage.cacheRead,
        detail: verdict.usable
          ? `summary read ${outcome.usage.cacheRead} of ${prefixTokensOf(outcome.usage)} prefix tokens from cache`
          : `summary kept but cache-hitting summaries are now disabled for this session: ${verdict.reason}`,
      },
      context,
    );

    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: outcome.usage,
        details: { hotIdleCompaction: { origin, cacheReadTokens: outcome.usage.cacheRead } },
      },
    };
  });

  pi.on("session_compact", (_event, context) => {
    capture.forget();
    stubbedToolCallIds = readStubbedToolCallIds(context.sessionManager.getBranch());
  });

  pi.registerCommand("hot-idle", {
    description: "Show prompt-cache aware compaction status",
    handler: async (_args, context) => {
      const currentSettings = settings();
      const model = context.model;
      const lines: string[] = [];
      const contextUsage = context.getContextUsage();
      lines.push(`enabled: ${currentSettings.enabled}`);
      lines.push(
        `context: ${contextUsage?.tokens ?? "unknown"} tokens (floor ${currentSettings.minContextTokens})`,
      );
      if (model) {
        const ttlSeconds = ttlSecondsFor(model);
        lines.push(`model: ${modelKeyOf(model)}`);
        lines.push(
          `prompt cache lifetime: ${ttlSeconds === undefined ? "unknown (set ttlSeconds)" : `${ttlSeconds}s`}`,
        );
        lines.push(
          `compaction threshold: ${compactAtTokensForModel(currentSettings, modelKeyOf(model))} tokens`,
        );
      }
      if (lastCacheTouchEpochMilliseconds !== undefined) {
        lines.push(
          `idle for: ${Math.round((Date.now() - lastCacheTouchEpochMilliseconds) / MILLISECONDS_PER_SECOND)}s`,
        );
      }
      lines.push(
        scheduledAction
          ? `next action: ${scheduledAction.kind} at ${formatClockTime(scheduledAction.fireAtEpochMilliseconds)}`
          : `next action: none${lastDeclinedReason ? ` (${lastDeclinedReason})` : ""}`,
      );
      lines.push(`stubbed tool results: ${stubbedToolCallIds.size}`);
      if (cachedSummariesDisabledBecause)
        lines.push(`cached summaries disabled: ${cachedSummariesDisabledBecause}`);
      if (keepaliveDisabledBecause) lines.push(`keepalive disabled: ${keepaliveDisabledBecause}`);
      const totals = totalsOf(readActionRecords(context.sessionManager.getBranch()));
      lines.push(
        `actions this branch: ${totals.actionCount}, cost ${formatDollars(totals.actualCostDollars)}, estimated saved ${formatDollars(totals.estimatedSavedDollars)}`,
      );
      const text = lines.join("\n");
      if (context.hasUI) context.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
