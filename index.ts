import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ponytail: fast zero-token local syntax validators using host tools (bun, python3, bash)
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

function resolveJevApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  try {
    const configPath = join(homedir(), ".pi/agent/pi-jev.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
      if (cfg.apiKeyFile) {
        const keyFilePath = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
        if (existsSync(keyFilePath)) {
          return readFileSync(keyFilePath, "utf8").trim();
        }
      }
    }
  } catch {}
  return undefined;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  toolUsed: string;
}

export function validateSyntax(filePath: string): ValidationResult {
  if (!existsSync(filePath)) {
    return { valid: true, toolUsed: "none" };
  }

  const ext = extname(filePath).toLowerCase();

  // 1. JSON validation
  if (ext === ".json") {
    try {
      const content = readFileSync(filePath, "utf8");
      JSON.parse(content);
      return { valid: true, toolUsed: "JSON.parse" };
    } catch (err: any) {
      return {
        valid: false,
        error: `JSON parse error: ${err.message}`,
        toolUsed: "JSON.parse",
      };
    }
  }

  // 2. TypeScript / JavaScript / JSX / TSX validation via Bun or Node
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    try {
      // bun build --no-bundle is sub-20ms and pinpoint accurate
      execSync(`/Users/samlyndon/.bun/bin/bun build --no-bundle "${filePath}"`, {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 2000,
      });
      return { valid: true, toolUsed: "bun" };
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      return {
        valid: false,
        error: msg,
        toolUsed: "bun",
      };
    }
  }

  // 3. Python validation via py_compile or ruff
  if (ext === ".py") {
    try {
      execSync(`python3 -m py_compile "${filePath}"`, {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 2000,
      });
      return { valid: true, toolUsed: "python3 -m py_compile" };
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      return {
        valid: false,
        error: msg,
        toolUsed: "python3 -m py_compile",
      };
    }
  }

  // 4. Shell script validation via bash -n
  if ([".sh", ".bash", ".zsh"].includes(ext)) {
    try {
      execSync(`bash -n "${filePath}"`, {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 1000,
      });
      return { valid: true, toolUsed: "bash -n" };
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      return {
        valid: false,
        error: msg,
        toolUsed: "bash -n",
      };
    }
  }

  return { valid: true, toolUsed: "passthrough" };
}

const CRITICAL_FILE_PATTERNS = [
  /settings\.json$/i,
  /auth\.json$/i,
  /\.env(\..+)?$/i,
  /AGENTS\.md$/i,
  /CLAUDE\.md$/i,
  /orchestrator-guard\.ts$/i,
];

export async function checkCriticalFileRiskWithJev(
  filePath: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ damageRisk: number; advice?: string } | null> {
  const fileName = basename(filePath);
  const isCritical = CRITICAL_FILE_PATTERNS.some((p) => p.test(fileName));
  if (!isCritical) return null;

  let snippet = "";
  try {
    snippet = readFileSync(filePath, "utf8").slice(0, 3000);
  } catch {
    return null;
  }

  const body = {
    state: `File: ${fileName}\nContent excerpt:\n${snippet}`,
    model: JEV_MODEL,
    questions: {
      damage_risk: {
        type: "noul",
        instructions:
          "Does this configuration or instruction file contain high-risk modifications that could break system authentication, wipe data, or violate safety protocols?",
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });

    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const damageRisk = json?.answers?.damage_risk?.noul ?? 0.0;
    return { damageRisk };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function (pi: ExtensionAPI) {
  const jevApiKey = resolveJevApiKey();

  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    // Only inspect file mutations
    if (event.toolName !== "edit" && event.toolName !== "write") {
      return;
    }

    const input = event.input as { path?: string } | undefined;
    const targetPath = input?.path;
    if (!targetPath) return;

    // Resolve relative path against cwd if needed
    const resolvedPath = targetPath.startsWith("/")
      ? targetPath
      : join(ctx.cwd || process.cwd(), targetPath);

    // 1. Fast Deterministic Syntax Check
    const validation = validateSyntax(resolvedPath);

    let syntaxWarning = "";
    if (!validation.valid && validation.error) {
      syntaxWarning = `\n\n⚠️ [AUTO-VALIDATOR ALERT]: Syntax check failed (${validation.toolUsed}) immediately after ${event.toolName}:\n\`\`\`\n${validation.error}\n\`\`\`\nPlease repair this syntax error before continuing to prevent broken runtime state.\n`;
      ctx.ui?.notify?.(
        `[Auto-Validator] Syntax error caught in ${basename(resolvedPath)} (${validation.toolUsed})`,
        "error",
      );
    }

    // 2. TypeSafe Jev Risk Audit for Critical Config Files
    let jevWarning = "";
    if (validation.valid && jevApiKey) {
      try {
        const jevRisk = await checkCriticalFileRiskWithJev(resolvedPath, jevApiKey, ctx.signal);
        if (jevRisk && jevRisk.damageRisk > 0.75) {
          const pct = Math.round(jevRisk.damageRisk * 100);
          jevWarning = `\n\n🛡️ [Jev Safety Notice]: High-risk alteration detected on critical system file ${basename(resolvedPath)} (${pct}% risk probability). Verify credentials and invariants carefully.\n`;
        }
      } catch {}
    }

    // If either warning fired, append to model-visible tool result
    if (syntaxWarning || jevWarning) {
      if (Array.isArray(event.content)) {
        const modifiedContent = event.content.map((block) => {
          if (block.type === "text" && typeof block.text === "string") {
            return {
              ...block,
              text: `${block.text}${syntaxWarning}${jevWarning}`,
            };
          }
          return block;
        });
        return { content: modifiedContent };
      }
    }
  });
}
