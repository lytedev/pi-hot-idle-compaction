import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SUMMARY_INSTRUCTION = `The conversation above is about to be compacted: it will be replaced by the summary you write now, followed by only the most recent messages. Do not call any tools. Reply with only the summary, in exactly this format.

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements the user stated]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Facts, identifiers, paths and commands needed to continue without re-reading anything]

Keep every concrete detail that would otherwise have to be rediscovered: file paths, function names, error messages, exact commands and their outcomes.`;

export type CacheHittingRequestOutcome =
  | { kind: "completed"; message: AssistantMessage; usage: Usage; prefixTokensSent: number }
  | { kind: "failed"; reason: string };

export function prefixTokensOf(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export async function sendCacheHittingRequest(input: {
  context: ExtensionContext;
  model: Model<Api>;
  transcript: AgentMessage[];
  appendedUserInstruction: string | undefined;
  maximumOutputTokens: number;
  thinkingLevel: ThinkingLevel | "off" | undefined;
  signal: AbortSignal | undefined;
}): Promise<CacheHittingRequestOutcome> {
  const messages = convertToLlm(input.transcript);
  if (input.appendedUserInstruction !== undefined) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: input.appendedUserInstruction }],
      timestamp: Date.now(),
    });
  }
  try {
    const stream = input.context.modelRegistry.streamSimple(
      input.model,
      { messages },
      {
        maxTokens: input.maximumOutputTokens,
        sessionId: input.context.sessionManager.getSessionId(),
        reasoning:
          input.thinkingLevel === undefined || input.thinkingLevel === "off"
            ? undefined
            : input.thinkingLevel,
        signal: input.signal,
      },
    );
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        kind: "failed",
        reason: message.errorMessage ?? `request ended with ${message.stopReason}`,
      };
    }
    return {
      kind: "completed",
      message,
      usage: message.usage,
      prefixTokensSent: prefixTokensOf(message.usage),
    };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
