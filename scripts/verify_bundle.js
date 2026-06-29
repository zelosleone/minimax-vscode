// Verify the shipped out/extension.js bundle contains the patched logic.
const fs = require("fs");
const code = fs.readFileSync("out/extension.js", "utf8");
const markers = [
  ["LanguageModelToolCallPart", "tool-call branch present"],
  ["LanguageModelToolResultPart", "tool-result branch present"],
  ['startsWith("image/")', "image MIME detection present"],
  ['startsWith("image/")', "image MIME check"],
  ["provideTokenCount", "method still exported"],
];
for (const [m, desc] of markers) {
  console.log((code.includes(m) ? "FOUND    " : "MISSING  ") + m + "  -- " + desc);
}
console.log("\nBundle size: " + code.length + " bytes");