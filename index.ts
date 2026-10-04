import { homedir } from "node:os";
import { join, extname, basename, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ponytail: fast zero-token local syntax validators using host tools (bun, python3, bash)
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const MAX_VALIDATE_BYTES = 2 * 1024 * 1024; // 2MB safety guard

function resolveBunPath(): string {
  const homeBun = join(homedir(), ".bun/bin/bun");
  if (existsSync(homeBun)) return homeBun;
  return "bun";
}

// Windows: bare `bash` on PATH is often WSL's system32\bash.exe, which cannot read C:\ paths.
// Use Git Bash only (same search order as Pi's getShellConfig); null => skip the .sh check.
function resolveBashPath(): string | null {
  if (process.platform !== "win32") return "bash";
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    const gitBash = root && join(root, "Git", "bin", "bash.exe");
    if (gitBash && existsSync(gitBash)) return gitBash;
  }
  return null;
}

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

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { valid: true, toolUsed: "none" };
    }
    if (stat.size > MAX_VALIDATE_BYTES) {
      return { valid: true, toolUsed: "skipped_oversized" };
    }
  } catch {
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

  // 2. TypeScript / JavaScript / JSX / TSX validation via Bun (argv-based, immune to injection)
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    try {
      const bunBin = resolveBunPath();
      execFileSync(bunBin, ["build", "--no-bundle", filePath], {
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

  // 3. Python validation via ast.parse in isolated mode (-I)
  // Completely prevents local module shadowing and writes no __pycache__ bytecode
  if (ext === ".py") {
    try {
      execFileSync(
        // ponytail: win32 python3 is often a Store stub; use `python`
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read())", filePath],
        {
          stdio: "pipe",
          encoding: "utf8",
          timeout: 2000,
        },
      );
      return { valid: true, toolUsed: "python3 (ast.parse)" };
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      return {
        valid: false,
        error: msg,
        toolUsed: "python3 (ast.parse)",
      };
    }
  }

  // 4. Shell script validation via bash -n (argv-based, immune to injection)
  if ([".sh", ".bash"].includes(ext)) {
    const bashBin = resolveBashPath();
    if (!bashBin) return { valid: true, toolUsed: "none" };
    try {
      execFileSync(bashBin, ["-n", filePath], {
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

  if (ext === ".zsh") {
    try {
      execFileSync("zsh", ["-n", filePath], {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 1000,
      });
      return { valid: true, toolUsed: "zsh -n" };
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
      return {
        valid: false,
        error: msg,
        toolUsed: "zsh -n",
      };
    }
  }

  return { valid: true, toolUsed: "passthrough" };
}

// STRICT EXCLUSION: NEVER disclose secrets or credentials to any third-party API!
const STRICT_CREDENTIAL_EXCLUSIONS = [
  /\.env(\..+)?$/i,
  /auth.*\.json$/i,
  /.*secret.*/i,
  /.*token.*/i,
  /.*key.*/i,
  /.*credential.*/i,
  /\.pem$/i,
  /id_rsa/i,
];

// Only architecture / policy docs can be audited for systemic risk
const AUDITABLE_POLICY_FILES = [
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

  // Security Gate 1: If file could contain credentials, hard-refuse upload
  if (STRICT_CREDENTIAL_EXCLUSIONS.some((p) => p.test(fileName))) {
    return null;
  }

  // Security Gate 2: Only upload permitted policy/governance files
  const isAuditable = AUDITABLE_POLICY_FILES.some((p) => p.test(fileName));
  if (!isAuditable) return null;

  let snippet = "";
  try {
    snippet = readFileSync(filePath, "utf8").slice(0, 3000);
  } catch {
    return null;
  }

  const body = {
    state: `File: ${fileName}\nPolicy excerpt:\n${snippet}`,
    model: JEV_MODEL,
    questions: {
      damage_risk: {
        type: "noul",
        instructions:
          "Does this instruction or guard file contain modifications that would disable core agent safeguards, remove critical constraints, or violate safety protocols?",
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
    const noul = json?.answers?.damage_risk?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      return null;
    }
    return { damageRisk: noul };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors Pi's write/edit resolver (dist/utils/paths.js resolvePath with normalizeUnicodeSpaces +
// stripAtPrefix; not exported by the package) so we validate the exact file Pi mutated:
// `@x` -> `x`, `~`/`~/`/`~\` (win32) -> home, win32 `/c/x` -> `C:\x`, `C:x` -> drive-relative, file:// URLs.
export function resolveFilePath(targetPath: string, cwd = process.cwd(), platform: string = process.platform): string {
  const p = platform === "win32" ? win32 : posix;
  let t = targetPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (t.startsWith("@")) t = t.slice(1);
  if (platform === "win32") {
    const m = t.startsWith("/") && !t.startsWith("//") && !t.includes("\\")
      ? t.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
      : null;
    if (m) t = `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  const tilde = (s: string) =>
    s === "~" ? homedir() : s.startsWith("~/") || (platform === "win32" && s.startsWith("~\\")) ? p.join(homedir(), s.slice(2)) : s;
  t = tilde(t);
  if (/^file:\/\//.test(t)) t = fileURLToPath(t);
  return p.isAbsolute(t) ? p.resolve(t) : p.resolve(tilde(cwd), t);
}

export default function (pi: ExtensionAPI) {
  const jevApiKey = resolveJevApiKey();

  // Register command for visible UI discovery and status verification
  pi.registerCommand("auto-validate", {
    description: "Check status of deterministic syntax validators (bun, python, bash, json) and Jev guard",
    handler: async (_args, ctx) => {
      const jevStatus = jevApiKey ? "configured (System One)" : "unconfigured";
      ctx.ui?.notify?.(
        `[pi-auto-validate] Active: bun (TS/JS), python3 (ast.parse -I), bash/zsh (-n), JSON.parse | Jev: ${jevStatus}`,
        "info",
      );
    },
  });

  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    // Only inspect file mutations
    if (event.toolName !== "edit" && event.toolName !== "write") {
      return;
    }

    const input = event.input as { path?: string } | undefined;
    const targetPath = input?.path;
    if (!targetPath) return;

    // Resolve path properly with ~ and relative support
    const resolvedPath = resolveFilePath(targetPath, ctx.cwd || process.cwd());

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

    // 2. TypeSafe Jev Risk Audit for Policy Files (Credentials strictly excluded)
    let jevWarning = "";
    if (validation.valid && jevApiKey) {
      try {
        const jevRisk = await checkCriticalFileRiskWithJev(resolvedPath, jevApiKey, ctx.signal);
        if (jevRisk && jevRisk.damageRisk > 0.75) {
          const pct = Math.round(jevRisk.damageRisk * 100);
          jevWarning = `\n\n🛡️ [Jev Safety Notice]: High-risk alteration detected on governance policy file ${basename(resolvedPath)} (${pct}% risk probability). Verify constraints and invariants carefully.\n`;
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
