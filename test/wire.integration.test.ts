import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vite-plus/test";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHotIdleCompaction } from "../src/index.ts";
import { ManualClock, settleMicrotasks } from "./harness.ts";

type WireRequest = { body: any; promptTokens: number; cachedTokens: number };

async function readBody(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function startFakeChatCompletionsServer(script: {
  toolUsesBeforeAnswer: () => number | undefined;
  forceMiss: () => boolean;
}) {
  const requests: WireRequest[] = [];
  let previousMessages: string[] = [];
  let toolUsesSentThisPrompt = 0;
  const server: Server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    const messageStrings: string[] = body.messages.map((message: unknown) =>
      JSON.stringify(message),
    );
    let sharedCharacters = 0;
    for (let index = 0; index < Math.min(previousMessages.length, messageStrings.length); index++) {
      if (previousMessages[index] !== messageStrings[index]) break;
      sharedCharacters += messageStrings[index].length;
    }
    const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4) + 400;
    const cachedTokens = script.forceMiss()
      ? 0
      : Math.min(promptTokens, Math.ceil(sharedCharacters / 4));
    previousMessages = messageStrings;
    requests.push({ body, promptTokens, cachedTokens });

    const lastMessage = body.messages[body.messages.length - 1];
    const isSummary =
      lastMessage.role === "user" &&
      JSON.stringify(lastMessage.content).includes("about to be compacted");
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 20,
      total_tokens: promptTokens + 20,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    };
    if (lastMessage.role === "user" && !isSummary) toolUsesSentThisPrompt = 0;
    const wantsToolUse =
      Array.isArray(body.tools) &&
      !isSummary &&
      lastMessage.role !== "assistant" &&
      toolUsesSentThisPrompt < (script.toolUsesBeforeAnswer() ?? 0);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "x", object: "chat.completion.chunk", created: 1, model: "fake-model" };
    if (wantsToolUse) {
      toolUsesSentThisPrompt += 1;
      response.end(
        sse([
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      type: "function",
                      function: {
                        name: "bigtool",
                        arguments: JSON.stringify({ text: "y".repeat(4000) }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { ...base, choices: [], usage },
        ]),
      );
    } else {
      const text = isSummary ? "## Goal\nwire summary" : "done";
      response.end(
        sse([
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
            ],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...base, choices: [], usage },
        ]),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function startWireSession(
  settings: Record<string, unknown>,
  script: Parameters<typeof startFakeChatCompletionsServer>[0],
) {
  const server = await startFakeChatCompletionsServer(script);
  const directory = mkdtempSync(join(tmpdir(), "hot-idle-wire-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("fake", {
    baseUrl: server.baseUrl,
    apiKey: "not-a-real-key",
    api: "openai-completions",
    models: [
      {
        id: "fake-model",
        name: "Fake",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
        contextWindow: 2_000_000,
        maxTokens: 20_000,
      },
    ],
  } as never);
  const model = modelRuntime.getModels("fake")[0];
  const settingsManager = SettingsManager.inMemory({
    hotIdleCompaction: settings,
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 2000 },
  } as never);
  const clock = new ManualClock();
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
      createHotIdleCompaction(clock),
      (pi) => {
        pi.registerTool(
          defineTool({
            name: "bigtool",
            label: "Big",
            description: "big",
            parameters: Type.Object({ text: Type.String() }),
            async execute(_id, params) {
              return { content: [{ type: "text", text: params.text }], details: undefined };
            },
          }),
        );
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    tools: ["bigtool"],
  });
  await session.bindExtensions({});
  return { session, server, clock };
}

const settings = {
  ttlSeconds: 600,
  minContextTokens: 1_000,
  compactAtTokens: 1_000_000,
  idleSummary: { enabled: false },
};

describe("over the wire against a fake chat-completions server", () => {
  test("the_cache_hitting_summary_request_repeats_the_prefix_keeps_tool_definitions_appends_a_user_instruction_and_sets_no_tool_choice", async () => {
    let forceMiss = false;
    const { session, server } = await startWireSession(settings, {
      toolUsesBeforeAnswer: () => 5,
      forceMiss: () => forceMiss,
    });
    await session.prompt("work");
    await settleMicrotasks();
    const before = server.requests.length;
    await session.compact();
    await settleMicrotasks();
    const summary = server.requests[before];
    const previous = server.requests[before - 1];
    assert.ok(summary, "compaction must have sent a request");
    assert.ok(
      Array.isArray(summary.body.tools) &&
        summary.body.tools.some((tool: any) => tool.function?.name === "bigtool"),
      "the summary request must still declare the tools, since dropping them changes the rendered prompt and misses the provider cache",
    );
    assert.equal(
      summary.body.tool_choice,
      undefined,
      "tool_choice must not be sent: tool_choice none makes some providers render the prompt without tools",
    );
    assert.deepEqual(
      summary.body.tools,
      previous.body.tools,
      "tool definitions must be identical to the previous request",
    );
    previous.body.messages.forEach((message: unknown, index: number) => {
      assert.deepEqual(
        summary.body.messages[index],
        message,
        `message ${index} must repeat the previous request exactly`,
      );
    });
    const last = summary.body.messages[summary.body.messages.length - 1];
    assert.equal(
      last.role,
      "user",
      "the replay must end on a user message or the provider answers with an empty stop",
    );
    assert.match(
      JSON.stringify(last.content),
      /about to be compacted/,
      "the appended message must be the summary instruction",
    );
    assert.ok(
      summary.cachedTokens >= 0.8 * summary.promptTokens,
      `scripted usage should show the prefix cached: ${summary.cachedTokens} of ${summary.promptTokens}`,
    );
    session.dispose();
    server.close();
  });

  test("a_scripted_cache_miss_in_usage_disables_cache_hitting_summaries_for_the_rest_of_the_session", async () => {
    let forceMiss = false;
    const { session, server } = await startWireSession(settings, {
      toolUsesBeforeAnswer: () => 5,
      forceMiss: () => forceMiss,
    });
    await session.prompt("work");
    await settleMicrotasks();
    forceMiss = true;
    await session.compact();
    await settleMicrotasks();
    forceMiss = false;
    const instructionRequests = () =>
      server.requests.filter((request) =>
        JSON.stringify(request.body.messages.at(-1)).includes("about to be compacted"),
      ).length;
    assert.equal(
      instructionRequests(),
      1,
      "the first compaction must attempt a cache-hitting summary",
    );
    await session.prompt("more work");
    await settleMicrotasks();
    await session.prompt("even more work");
    await settleMicrotasks();
    await session.compact();
    await settleMicrotasks();
    assert.equal(
      instructionRequests(),
      1,
      "after usage reported a miss, no further instruction request may be sent",
    );
    session.dispose();
    server.close();
  });
});
