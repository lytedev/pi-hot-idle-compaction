import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  createFauxCore,
  createProvider,
  fauxText,
  type FauxResponseFactory,
  fauxToolCall,
  type Message,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Clock, createHotIdleCompaction } from "../src/index.ts";

export const CHARACTERS_PER_TOKEN = 4;

export class ManualClock implements Clock {
  currentEpochMilliseconds = 1_800_000_000_000;
  #timers: { id: number; fireAt: number; callback: () => void }[] = [];
  #nextId = 1;

  nowEpochMilliseconds(): number {
    return this.currentEpochMilliseconds;
  }
  startTimer(callback: () => void, delayMilliseconds: number): unknown {
    const id = this.#nextId++;
    this.#timers.push({ id, fireAt: this.currentEpochMilliseconds + delayMilliseconds, callback });
    return id;
  }
  cancelTimer(handle: unknown): void {
    this.#timers = this.#timers.filter((timer) => timer.id !== handle);
  }
  pendingTimerCount(): number {
    return this.#timers.length;
  }
  async jumpSecondsThenFireEverythingDue(seconds: number): Promise<void> {
    this.currentEpochMilliseconds += seconds * 1000;
    for (const due of this.#timers.filter(
      (timer) => timer.fireAt <= this.currentEpochMilliseconds,
    )) {
      this.#timers = this.#timers.filter((timer) => timer.id !== due.id);
      due.callback();
      await settleMicrotasks();
    }
  }
  async advanceSeconds(seconds: number): Promise<void> {
    const target = this.currentEpochMilliseconds + seconds * 1000;
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.fireAt <= target)
        .sort((first, second) => first.fireAt - second.fireAt)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((timer) => timer.id !== due.id);
      this.currentEpochMilliseconds = due.fireAt;
      due.callback();
      await settleMicrotasks();
    }
    this.currentEpochMilliseconds = target;
  }
}

export async function settleMicrotasks(): Promise<void> {
  for (let round = 0; round < 40; round++) await new Promise((resolve) => setImmediate(resolve));
}

export type RecordedRequest = {
  messages: Message[];
  endsWithUserSummaryInstruction: boolean;
  cacheReadTokens: number;
  totalPromptTokens: number;
};

export type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: "bigtool"; argument: string };

export async function startSession(input: {
  settings: Record<string, unknown>;
  cacheLifetimeSecondsOfFakeProvider: number;
  clock: ManualClock;
}) {
  const requests: RecordedRequest[] = [];
  const scriptedReplies: ScriptedReply[] = [];
  let forceMissOnNextRequest = false;

  const core = createFauxCore({
    models: [
      {
        id: "faux-cached",
        contextWindow: 2_000_000,
        maxTokens: 50_000,
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
      },
    ],
  });

  let cacheEpoch = 0;
  let previousRequestAtMilliseconds = 0;
  function wrapForSimulatedCacheLifetime(
    delegate: typeof core.streamSimple,
  ): typeof core.streamSimple {
    return (model, context, options) => {
      const now = input.clock.nowEpochMilliseconds();
      const cacheExpired =
        previousRequestAtMilliseconds !== 0 &&
        now - previousRequestAtMilliseconds > input.cacheLifetimeSecondsOfFakeProvider * 1000;
      if (cacheExpired || forceMissOnNextRequest) cacheEpoch += 1;
      forceMissOnNextRequest = false;
      previousRequestAtMilliseconds = now;
      const messages = JSON.parse(JSON.stringify(context.messages)) as Message[];
      const lastMessage = messages[messages.length - 1];
      const record: RecordedRequest = {
        messages,
        endsWithUserSummaryInstruction:
          lastMessage?.role === "user" &&
          JSON.stringify(lastMessage.content).includes("about to be compacted"),
        cacheReadTokens: 0,
        totalPromptTokens: 0,
      };
      requests.push(record);
      const stream = delegate(model, context, {
        ...options,
        sessionId: `${options?.sessionId}#${cacheEpoch}`,
      });
      void stream.result().then((message) => {
        record.cacheReadTokens = message.usage.cacheRead;
        record.totalPromptTokens = message.usage.input + message.usage.cacheRead;
      });
      return stream;
    };
  }

  const respond: FauxResponseFactory = (context) => {
    const lastMessage = context.messages[context.messages.length - 1];
    const lastText = JSON.stringify(lastMessage?.content ?? "");
    const isSummaryRequest =
      lastMessage?.role === "user" && lastText.includes("about to be compacted");
    const reply = isSummaryRequest ? undefined : scriptedReplies.shift();
    core.appendResponses([respond]);
    if (isSummaryRequest) return fauxAssistantMessage(fauxText("## Goal\nfake summary"));
    if (reply?.kind === "tool") {
      return fauxAssistantMessage(fauxToolCall(reply.toolName, { text: reply.argument }), {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage(fauxText(reply?.kind === "text" ? reply.text : "ok"));
  };
  core.setResponses([respond]);

  const provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: core.stream,
      streamSimple: wrapForSimulatedCacheLifetime(core.streamSimple),
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred,
    },
  });

  const directory = mkdtempSync(join(tmpdir(), "hot-idle-test-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider);

  const settingsManager = SettingsManager.inMemory({
    hotIdleCompaction: input.settings,
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 2000 },
  } as never);

  const bigTool = defineTool({
    name: "bigtool",
    label: "Big tool",
    description: "Returns the text it was given, repeated to be large",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.text.repeat(1) }], details: undefined };
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createHotIdleCompaction(input.clock),
      (pi) => {
        pi.registerTool(bigTool);
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: core.getModel("faux-cached"),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    tools: ["bigtool"],
  });
  await session.bindExtensions({});

  return {
    session,
    requests,
    scriptedReplies,
    forceNextRequestToMissTheCache() {
      forceMissOnNextRequest = true;
    },
  };
}
