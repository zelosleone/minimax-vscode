// Local-only harness to A/B compare OLD vs NEW provideTokenCount logic.
// Mirrors src/providers/MiniMaxProvider.ts#provideTokenCount exactly.
// Run with: node scripts/test_provide_token_count.js

const assert = require("node:assert/strict");

class FakeTextPart { constructor(value) { this.value = value; } }
class FakeDataPart { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } }
class FakeToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
class FakeToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }

class TokenCounter {
  constructor() { this.charsPerToken = 4; }
  estimateTokens(text) {
    if (!text || text.length === 0) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }
}

function oldCount(content, tokenCounter) {
  let tokens = 0;
  for (const part of content) {
    if (part instanceof FakeTextPart) {
      tokens += tokenCounter.estimateTokens(part.value);
    } else if (part instanceof FakeDataPart) {
      tokens += Math.ceil(part.data.length / 4);
    }
  }
  return tokens;
}

function newCount(content, tokenCounter) {
  let tokens = 0;
  for (const part of content) {
    if (part instanceof FakeTextPart) {
      tokens += tokenCounter.estimateTokens(part.value);
    } else if (part instanceof FakeToolCallPart) {
      const serialized = JSON.stringify({
        id: part.callId,
        name: part.name,
        arguments: part.input ?? {},
      });
      tokens += tokenCounter.estimateTokens(serialized);
    } else if (part instanceof FakeToolResultPart) {
      try {
        const serialized = JSON.stringify(part.content);
        tokens += tokenCounter.estimateTokens(serialized);
      } catch {
        tokens += Math.ceil(String(part.content).length / 4);
      }
    } else if (part instanceof FakeDataPart) {
      if (part.mimeType.startsWith("image/")) {
        tokens += 1500;
      } else {
        tokens += Math.ceil(part.data.length / 4);
      }
    }
  }
  return tokens;
}

const tc = new TokenCounter();

const textOnly = [new FakeTextPart("Hello, world! This is a short user message.")];

const toolCallMsg = [
  new FakeTextPart("Let me read the file."),
  new FakeToolCallPart("call_abc123", "read_file", { path: "/tmp/example.txt", encoding: "utf-8" }),
];

const bigToolResult = "x".repeat(40_000);
const toolResultMsg = [new FakeToolResultPart("call_abc123", [new FakeTextPart(bigToolResult)])];

const imageBytes = Buffer.alloc(50_000, 0xAB);
const imageMsg = [new FakeTextPart("What is in this image?"), new FakeDataPart(imageBytes, "image/png")];

const jsonBytes = Buffer.from('{"hello":"world"}');
const dataMsg = [new FakeDataPart(jsonBytes, "application/json")];

const combined = [
  new FakeTextPart("Please analyze this PNG and check the file."),
  new FakeDataPart(imageBytes, "image/png"),
  new FakeToolCallPart("call_1", "read_file", { path: "/tmp/foo.txt" }),
  new FakeToolResultPart("call_1", [new FakeTextPart("contents of foo.txt")]),
];

function ab(label, content) {
  const oldN = oldCount(content, tc);
  const newN = newCount(content, tc);
  console.log(label.padEnd(28) + "  old=" + String(oldN).padStart(7) + "  new=" + String(newN).padStart(7) + "  delta=" + (newN - oldN));
  return { oldN: oldN, newN: newN };
}

console.log("=== provideTokenCount A/B (chars-per-token = 4) ===");
const r1 = ab("text only", textOnly);
const r2 = ab("tool call (assistant)", toolCallMsg);
const r3 = ab("tool result (user)", toolResultMsg);
const r4 = ab("image attachment", imageMsg);
const r5 = ab("non-image data part", dataMsg);
const r6 = ab("combined realistic", combined);

console.log("\n=== Assertions ===");

assert.equal(r1.newN, r1.oldN, "text-only count must be unchanged");
console.log("OK  text-only: " + r1.newN + " tokens (unchanged)");

// Tool call message contains a text part too. Old counted the text (24 chars / 4 = 6).
// New adds the serialized tool-call JSON on top.
assert.equal(r2.oldN, 6, "old code counts only the text part");
const expectedToolCallOnly = Math.ceil(
  JSON.stringify({ id: "call_abc123", name: "read_file", arguments: { path: "/tmp/example.txt", encoding: "utf-8" } }).length / 4
);
assert.equal(r2.newN, 6 + expectedToolCallOnly, "new must add tool-call JSON delta of " + expectedToolCallOnly);
console.log("OK  tool-call delta: +" + (r2.newN - r2.oldN) + " tokens (expected +" + expectedToolCallOnly + ")");

// Tool result message has no text part. Old returns 0. New counts the serialized result.
assert.equal(r3.oldN, 0, "old code dropped tool results");
// Note: JSON.stringify on FakeTextPart instances won't include "value" without toJSON.
// Derive expected from the shape VS Code's real serializer would produce.
const expectedResultTokens = Math.ceil(JSON.stringify([{ value: bigToolResult }]).length / 4);
assert.equal(r3.newN, expectedResultTokens, "tool result count must match expected; got " + r3.newN + ", want " + expectedResultTokens);
console.log("OK  tool-result: " + r3.newN + " tokens (was 0, expected " + expectedResultTokens + ")");

// Image: old counted base64 bytes (way too high), new uses 1500 flat for image MIME.
assert.ok(r4.oldN > 10000, "old image count should be huge, got " + r4.oldN);
assert.equal(r4.newN, 1500 + Math.ceil("What is in this image?".length / 4),
  "new image count must be 1500 + text; got " + r4.newN);
console.log("OK  image: " + r4.newN + " tokens (was " + r4.oldN + ", now flat 1500 + text)");

assert.equal(r5.newN, r5.oldN, "non-image data part count must be unchanged");
console.log("OK  non-image data part: " + r5.newN + " tokens (unchanged)");

assert.ok(r6.newN > 1500, "combined must include image");
console.log("OK  combined realistic: " + r6.newN + " tokens");

assert.equal(newCount([], tc), 0, "empty content must return 0");
console.log("OK  empty content: 0 tokens");

const emptyInput = [new FakeToolCallPart("c1", "ping", {})];
const r8 = newCount(emptyInput, tc);
assert.ok(r8 > 0, "tool call with empty input must still count id + name");
console.log("OK  empty-input tool call: " + r8 + " tokens");

const circular = {}; circular.self = circular;
const circularMsg = [new FakeToolResultPart("c1", [circular])];
const r9 = newCount(circularMsg, tc);
assert.ok(r9 >= 0 && r9 < 100, "circular ref must not throw and must return small number");
console.log("OK  circular-ref tool result: " + r9 + " tokens (fallback path)");

console.log("\n=== ALL ASSERTIONS PASSED ===");
console.log("\nKey findings:");
console.log("- Tool calls now contribute ~" + (r2.newN - r2.oldN) + " tokens each (was 0)");
console.log("- 40KB tool result now contributes " + r3.newN + " tokens (was 0)");
console.log("- Single image now contributes ~1500 tokens (was " + (r4.oldN - Math.ceil("What is in this image?".length / 4)) + ")");