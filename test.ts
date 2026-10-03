import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import registerAutoValidate, {
  validateSyntax,
  resolveFilePath,
  checkCriticalFileRiskWithJev,
} from "./index.ts";

console.log("=== Testing pi-auto-validate extension (Hardened) ===");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autovalidate-test-"));

try {
  // 1. Hostile filename injection test (must not execute command)
  const hostileFile = path.join(testDir, "test$(touch INJECTION_MARKER).ts");
  fs.writeFileSync(hostileFile, "export const x = 42;");
  const hostileRes = validateSyntax(hostileFile);
  assert(hostileRes.valid, "Valid TS with hostile filename must pass");
  assert(
    !fs.existsSync(path.join(process.cwd(), "INJECTION_MARKER")) &&
      !fs.existsSync(path.join(testDir, "INJECTION_MARKER")),
    "Hostile filename must NOT trigger command injection",
  );
  console.log("✓ Hostile filename command injection safely mitigated");

  // 2. Python syntax test with local shadowing resistance
  const shadowScript = path.join(testDir, "py_compile.py");
  fs.writeFileSync(shadowScript, "raise SystemExit('Shadowed py_compile executed')");

  const pyValid = path.join(testDir, "valid.py");
  fs.writeFileSync(pyValid, "x = 10\nprint(x)\n");
  const pyRes = validateSyntax(pyValid);
  assert(pyRes.valid, "Valid Python must pass even with local py_compile.py present");

  const pyInvalid = path.join(testDir, "invalid.py");
  fs.writeFileSync(pyInvalid, "def foo(\n");
  const pyInvRes = validateSyntax(pyInvalid);
  assert(!pyInvRes.valid, "Invalid Python syntax must be caught");
  console.log("✓ Python syntax verification verified (isolated AST parser, zero module shadowing)");

  // 3. Strict Credential Exclusion Test
  const envFile = path.join(testDir, ".env");
  fs.writeFileSync(envFile, "SECRET_KEY=supersecret");
  const envAudit = await checkCriticalFileRiskWithJev(envFile, "mock-key");
  assert.equal(envAudit, null, ".env files must NEVER be sent to third-party APIs");

  const authFile = path.join(testDir, "auth.json");
  fs.writeFileSync(authFile, '{"apiKey": "secret"}');
  const authAudit = await checkCriticalFileRiskWithJev(authFile, "mock-key");
  assert.equal(authAudit, null, "auth.json files must NEVER be sent to third-party APIs");
  console.log("✓ Strict credential exclusions verified (secrets blocked from remote transmission)");

  // 4. JSON Syntax Test
  const jsonInvalid = path.join(testDir, "broken.json");
  fs.writeFileSync(jsonInvalid, '{"unclosed": ');
  const jsonRes = validateSyntax(jsonInvalid);
  assert(!jsonRes.valid, "Broken JSON must be detected");
  console.log("✓ JSON syntax validation verified");

  // 5. Path Resolution Test
  const resolvedHome = resolveFilePath("~/test.json");
  assert(resolvedHome.startsWith(os.homedir()), "Tilde path must resolve to homedir");
  console.log("✓ Path resolution with ~ expansion verified");

  // Windows absolute paths must not be joined onto cwd (regression: C:\x\y.py -> cwd\C:\x\y.py)
  assert.equal(resolveFilePath("C:\\x\\y.py", "/cwd", path.win32.isAbsolute), "C:\\x\\y.py");
  assert.equal(resolveFilePath("rel.py", "/cwd", path.win32.isAbsolute), path.join("/cwd", "rel.py"));
  console.log("✓ Windows absolute path resolution verified");

  console.log("\nALL TESTS PASSED! pi-auto-validate is fully hardened.");
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
