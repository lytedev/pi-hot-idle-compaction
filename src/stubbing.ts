import type { HotIdleSettings } from "./settings.ts";

const MILLISECONDS_PER_SECOND = 1000;
const MAXIMUM_ARGUMENT_CHARACTERS_IN_STUB = 300;
const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;

export type ToolUseCandidate = {
  toolCallId: string;
  toolName: string;
  resultTokens: number;
};

export type StubbingPlan =
  | { action: "stub"; toolCallIdsToStub: string[]; tokensCleared: number }
  | { action: "none"; reason: string };

export function stubTextFor(toolName: string, argumentsJson: string): string {
  const shownArguments =
    argumentsJson.length > MAXIMUM_ARGUMENT_CHARACTERS_IN_STUB
      ? `${argumentsJson.slice(0, MAXIMUM_ARGUMENT_CHARACTERS_IN_STUB)}...`
      : argumentsJson;
  return `[Output of the ${toolName} tool call with arguments ${shownArguments} was removed to save tokens while you were away. Run the same tool call again if you still need it.]`;
}

export function estimateStubTokens(toolName: string, argumentsJson: string): number {
  return Math.ceil(stubTextFor(toolName, argumentsJson).length / APPROXIMATE_CHARACTERS_PER_TOKEN);
}

export function planToolResultStubbing(input: {
  toolUsesOldestFirst: ToolUseCandidate[];
  alreadyStubbedToolCallIds: ReadonlySet<string>;
  contextTokens: number;
  idleMilliseconds: number;
  ttlSeconds: number | undefined;
  settings: HotIdleSettings;
}): StubbingPlan {
  const { settings, ttlSeconds } = input;
  if (!settings.enabled || !settings.stubbing.enabled) {
    return { action: "none", reason: "stubbing is disabled" };
  }
  if (ttlSeconds === undefined) {
    return { action: "none", reason: "the prompt cache lifetime of this model is unknown" };
  }
  if (input.contextTokens < settings.minContextTokens) {
    return {
      action: "none",
      reason: `context is below the ${settings.minContextTokens} token floor`,
    };
  }
  const idleBeyondWhichCacheIsGoneMilliseconds =
    (ttlSeconds + settings.stubbing.graceSeconds) * MILLISECONDS_PER_SECOND;
  if (input.idleMilliseconds <= idleBeyondWhichCacheIsGoneMilliseconds) {
    return {
      action: "none",
      reason: "the prompt cache has not been idle long enough to have expired",
    };
  }

  const countOfOldToolUses = Math.max(
    0,
    input.toolUsesOldestFirst.length - settings.stubbing.keepMostRecentToolUses,
  );
  const oldToolUses = input.toolUsesOldestFirst
    .slice(0, countOfOldToolUses)
    .filter((toolUse) => !input.alreadyStubbedToolCallIds.has(toolUse.toolCallId));
  const tokensCleared = oldToolUses.reduce((sum, toolUse) => sum + toolUse.resultTokens, 0);

  if (tokensCleared < settings.stubbing.minimumTokensCleared) {
    return {
      action: "none",
      reason: `stubbing would clear only ${tokensCleared} tokens, under the ${settings.stubbing.minimumTokensCleared} token minimum`,
    };
  }
  const fractionCleared = tokensCleared / input.contextTokens;
  if (fractionCleared < settings.stubbing.minimumFractionOfContextCleared) {
    return {
      action: "none",
      reason: `stubbing would clear ${(fractionCleared * 100).toFixed(1)}% of the context, under the ${(settings.stubbing.minimumFractionOfContextCleared * 100).toFixed(0)}% minimum`,
    };
  }
  return {
    action: "stub",
    toolCallIdsToStub: oldToolUses.map((toolUse) => toolUse.toolCallId),
    tokensCleared,
  };
}

export type TextBlock = { type: "text"; text: string };
export type StubbableMessage =
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown;
      [field: string]: unknown;
    }
  | {
      role: "assistant";
      content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }>;
      [field: string]: unknown;
    }
  | { role: string; [field: string]: unknown };

export function collectToolUsesOldestFirst(
  messages: readonly StubbableMessage[],
  estimateResultTokens: (message: StubbableMessage) => number,
): ToolUseCandidate[] {
  const candidates: ToolUseCandidate[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      const toolResult = message as Extract<StubbableMessage, { role: "toolResult" }>;
      candidates.push({
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        resultTokens: estimateResultTokens(message),
      });
    }
  }
  return candidates;
}

export function applyStubs<Message extends StubbableMessage>(
  messages: readonly Message[],
  stubbedToolCallIds: ReadonlySet<string>,
): Message[] {
  if (stubbedToolCallIds.size === 0) return [...messages];

  const argumentsJsonByToolCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const assistant = message as Extract<StubbableMessage, { role: "assistant" }>;
    for (const block of assistant.content) {
      if (block.type === "toolCall" && block.id !== undefined) {
        argumentsJsonByToolCallId.set(block.id, JSON.stringify(block.arguments ?? {}));
      }
    }
  }

  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const toolResult = message as Extract<StubbableMessage, { role: "toolResult" }>;
    if (!stubbedToolCallIds.has(toolResult.toolCallId)) return message;
    const stub: TextBlock = {
      type: "text",
      text: stubTextFor(
        toolResult.toolName,
        argumentsJsonByToolCallId.get(toolResult.toolCallId) ?? "{}",
      ),
    };
    return { ...message, content: [stub] };
  });
}
