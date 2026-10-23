import type { AgentMessage } from "@earendil-works/pi-agent-core";

export class ConversationCapture {
  #lastRequestMessages: AgentMessage[] | undefined;
  #messagesSinceLastRequest: AgentMessage[] = [];
  #tokensInLastRequestPrefix: number | undefined;

  recordRequestAboutToBeSent(messagesIncludingSystem: readonly AgentMessage[]): void {
    this.#lastRequestMessages = [...messagesIncludingSystem];
    this.#messagesSinceLastRequest = [];
  }

  recordMessageFinished(message: AgentMessage): void {
    this.#messagesSinceLastRequest.push(message);
    const requestSucceeded =
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted";
    if (requestSucceeded) {
      const { input, cacheRead, cacheWrite } = message.usage;
      this.#tokensInLastRequestPrefix = input + cacheRead + cacheWrite;
    }
  }

  tokensInLastRequestPrefix(): number | undefined {
    return this.#tokensInLastRequestPrefix;
  }

  forget(): void {
    this.#lastRequestMessages = undefined;
    this.#messagesSinceLastRequest = [];
    this.#tokensInLastRequestPrefix = undefined;
  }

  hasCapturedRequest(): boolean {
    return this.#lastRequestMessages !== undefined;
  }

  transcriptThatNextRequestWouldStartWith(): AgentMessage[] | undefined {
    if (this.#lastRequestMessages === undefined) return undefined;
    return [...this.#lastRequestMessages, ...this.#messagesSinceLastRequest];
  }
}
