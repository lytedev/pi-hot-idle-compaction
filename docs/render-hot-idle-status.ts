// Regenerates docs/hot-idle-status.svg from the real /hot-idle output of a real pi session
// against the offline fake provider. No network, no cost. Then render the PNG with:
//   nix shell nixpkgs#librsvg nixpkgs#dejavu_fonts -c rsvg-convert docs/hot-idle-status.svg -o docs/hot-idle-status.png
//
//   node docs/render-hot-idle-status.ts > docs/hot-idle-status.svg
import { ManualClock, settleMicrotasks, startSession } from "../test/harness.ts";

const clock = new ManualClock();
const harness = await startSession({
  settings: {
    ttlSeconds: 3600,
    minContextTokens: 1_000,
    compactAtTokens: 1_000_000,
    idleSummary: { enabled: true, minContextTokens: 1_000 },
    stubbing: { enabled: false },
  },
  cacheLifetimeSecondsOfFakeProvider: 3600,
  clock,
});

async function work(toolUses: number, prompt: string) {
  for (let index = 0; index < toolUses; index++) {
    harness.scriptedReplies.push({
      kind: "tool",
      toolName: "bigtool",
      argument: `${index}${"x".repeat(4000)}`,
    });
  }
  harness.scriptedReplies.push({ kind: "text", text: "done" });
  await harness.session.prompt(prompt);
  await settleMicrotasks();
}

await work(6, "first task");
await clock.jumpSecondsThenFireEverythingDue(600);
await work(3, "second task");
await clock.advanceSeconds(3300);
await settleMicrotasks();

const lines: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
await harness.session.prompt("/hot-idle");
await settleMicrotasks();
console.log = realLog;
harness.session.dispose();

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const lineHeight = 22;
const output = ["/hot-idle", ...lines.flatMap((block) => block.split("\n"))];
const widthCharacters = Math.max(...output.map((line) => line.length));
const width = Math.ceil(widthCharacters * 9.6) + 48;
const height = output.length * lineHeight + 48;
const text = output
  .map(
    (line, index) =>
      `<text x="24" y="${36 + index * lineHeight}" fill="${index === 0 ? "#7ee787" : "#d4d4d4"}">${escape(index === 0 ? `> ${line}` : line)}</text>`,
  )
  .join("\n");
console.log(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans Mono, monospace" font-size="16">\n<rect width="100%" height="100%" rx="10" fill="#1e1e1e"/>\n${text}\n</svg>`,
);
process.exit(0);
