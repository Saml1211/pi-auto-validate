import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import registerAutoValidate, { validateSyntax } from "./index.ts";

console.log("=== Testing pi-auto-validate extension ===");

const tmpDir = "/tmp/pi-auto-validate-tests";
fs.mkdirSync(tmpDir, { recursive: true });

// 1. JSON Tests
const goodJson = path.join(tmpDir, "good.json");
const badJson = path.join(tmpDir, "bad.json");
fs.writeFileSync(goodJson, JSON.stringify({ a: 1, b: "ok" }));
fs.writeFileSync(badJson, '{"a": 1, "unclosed": ');

assert(validateSyntax(goodJson).valid, "Valid JSON must pass");
const resBadJson = validateSyntax(badJson);
assert(!resBadJson.valid, "Malformed JSON must fail");
assert(resBadJson.error?.includes("JSON parse error"), "Error message must report parse error");
console.log("✓ JSON syntax validation verified (clean pass + malformed caught)");

// 2. TypeScript / JavaScript Tests
const goodTs = path.join(tmpDir, "good.ts");
const badTs = path.join(tmpDir, "bad.ts");
fs.writeFileSync(goodTs, "const x: number = 42;\nexport default x;");
fs.writeFileSync(badTs, "const x: number = 42;\nconst y = {;");

assert(validateSyntax(goodTs).valid, "Valid TS must pass");
const resBadTs = validateSyntax(badTs);
assert(!resBadTs.valid, "Malformed TS must fail");
assert(resBadTs.error?.includes("error:"), "Error must report syntax error");
console.log("✓ TypeScript syntax validation verified via bun (clean pass + syntax error caught)");

// 3. Python Tests
const goodPy = path.join(tmpDir, "good.py");
const badPy = path.join(tmpDir, "bad.py");
fs.writeFileSync(goodPy, "def add(a: int, b: int) -> int:\n    return a + b\n");
fs.writeFileSync(badPy, "def add(a, b\n    return a + b\n");

assert(validateSyntax(goodPy).valid, "Valid Python must pass");
const resBadPy = validateSyntax(badPy);
assert(!resBadPy.valid, "Malformed Python must fail");
assert(resBadPy.error?.includes("SyntaxError"), "Python error must report SyntaxError");
console.log("✓ Python syntax validation verified (clean pass + syntax error caught)");

// 4. Shell Tests
const goodSh = path.join(tmpDir, "good.sh");
const badSh = path.join(tmpDir, "bad.sh");
fs.writeFileSync(goodSh, '#!/bin/bash\nif [ -z "$FOO" ]; then\n  echo "empty"\nfi\n');
fs.writeFileSync(badSh, '#!/bin/bash\nif [ -z "$FOO" ]; then\n  echo "missing fi"\n');

assert(validateSyntax(goodSh).valid, "Valid Shell must pass");
const resBadSh = validateSyntax(badSh);
assert(!resBadSh.valid, "Malformed Shell must fail");
assert(resBadSh.error?.includes("syntax error"), "Shell error must report syntax error");
console.log("✓ Shell script syntax validation verified via bash -n (clean pass + syntax error caught)");

// 5. Tool Result Hook Interception Test
const eventHandlers = new Map();
const registeredCommands = new Map();
const mockPi = {
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on(event: string, handler: any) {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(handler);
  },
};

registerAutoValidate(mockPi as any);
assert(registeredCommands.has("auto-validate"), "/auto-validate command must be registered");
console.log("✓ Slash command registration verified: '/auto-validate'");
const toolResultHandler = eventHandlers.get("tool_result")?.[0];
assert(toolResultHandler, "tool_result handler must be registered");

// Case 5a: Clean edit -> content remains clean
const cleanEvent: any = {
  toolName: "edit",
  input: { path: goodTs },
  content: [{ type: "text", text: "Successfully edited good.ts" }],
};
const cleanResult = await toolResultHandler(cleanEvent, { cwd: tmpDir });
assert.equal(cleanResult, undefined, "Clean edits should pass through unmodified");
console.log("✓ Clean edit passed through without false alerts");

// Case 5b: Broken edit -> alert injected into tool result content
const brokenEvent: any = {
  toolName: "edit",
  input: { path: badTs },
  content: [{ type: "text", text: "Successfully edited bad.ts" }],
};
const brokenResult = await toolResultHandler(brokenEvent, { cwd: tmpDir });
assert(brokenResult?.content, "Hook must return modified content for broken edits");
const alertText = brokenResult.content[0].text;
assert(alertText.includes("AUTO-VALIDATOR ALERT"), "Alert header must be present");
assert(alertText.includes("Syntax check failed"), "Must report syntax failure");
console.log("✓ Broken edit intercepted: AUTO-VALIDATOR ALERT successfully injected into tool result");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\nALL TESTS PASSED! pi-auto-validate is fully verified.");
