import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import OpenAI from "openai";

const DEFAULT_PROVIDER = "codex";

export function getLlmProvider() {
  return process.env.LLM_PROVIDER || DEFAULT_PROVIDER;
}

export function getDefaultModelForProvider(provider = getLlmProvider()) {
  return provider === "codex" ? "gpt-4o" : "openai/gpt-5.4-nano";
}

export function readCodexOAuthToken() {
  const authPath = path.join(homedir(), ".codex", "auth.json");

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const token = auth.access_token
      || auth.api_key
      || auth.token
      || auth.OPENAI_API_KEY
      || auth.tokens?.access_token
      || auth.tokens?.api_key
      || auth.tokens?.token;
    if (!token) {
      throw new Error("No token field found in ~/.codex/auth.json");
    }
    return token;
  } catch (error) {
    throw new Error(`Codex OAuth token not available (${error.message}). Run "codex login" first.`);
  }
}

export function getProviderApiKey(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not direct API key access.");
  }
  if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
  return process.env.OPENROUTER_API_KEY;
}

export function getProviderClientConfig(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not OpenAI client config.");
  }

  if (provider === "deepseek") {
    return {
      baseURL: "https://api.deepseek.com",
      apiKey: getProviderApiKey(provider),
    };
  }

  return {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: getProviderApiKey(provider),
  };
}

export function getChatCompletionsEndpoint(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not direct chat completions.");
  }
  if (provider === "deepseek") return "https://api.deepseek.com/chat/completions";
  return "https://openrouter.ai/api/v1/chat/completions";
}

export function createLlmClient(provider = getLlmProvider()) {
  return new OpenAI(getProviderClientConfig(provider));
}

function findExecutableOnPath(binName) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [binName], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function resolveCodexLaunch() {
  const configured = process.env.CODEX_PATH?.trim();
  if (configured) {
    if (process.platform === "win32") {
      if (/\.exe$/i.test(configured)) {
        return { command: configured, viaCmd: false };
      }

      const siblingExe = configured.replace(/\.(cmd|bat|ps1)$/i, ".exe");
      if (siblingExe !== configured && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };

      const codexExe = findExecutableOnPath("codex.exe");
      if (codexExe) return { command: codexExe, viaCmd: false };

      if (/\.(cmd|bat)$/i.test(configured)) {
        return { command: configured, viaCmd: true };
      }
    }

    return { command: configured, viaCmd: false };
  }

  if (process.platform === "win32") {
    const codexExe = findExecutableOnPath("codex.exe");
    if (codexExe) return { command: codexExe, viaCmd: false };

    const codexAny = findExecutableOnPath("codex");
    if (codexAny && /\.exe$/i.test(codexAny)) return { command: codexAny, viaCmd: false };

    const codexCmd = findExecutableOnPath("codex.cmd");
    if (codexCmd) {
      const siblingExe = codexCmd.replace(/\.cmd$/i, ".exe");
      if (siblingExe !== codexCmd && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };
      return { command: codexCmd, viaCmd: true };
    }
  }

  return { command: "codex", viaCmd: false };
}

function extractCodexMessage(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  let lastStructuredError = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item?.text) {
        return event.item.text;
      }
      if (event.type === "message" && event.role === "assistant" && event.content) {
        return typeof event.content === "string"
          ? event.content
          : event.content.map((c) => c.text || "").join("\n");
      }
      if (!lastStructuredError && event.type === "item.completed" && event.item?.type === "error" && event.item?.message) {
        lastStructuredError = event.item.message;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return lastStructuredError || output.trim();
}

function killChildProcess(child) {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // Fall through to best-effort child kill.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Best-effort cleanup only.
  }
}

export function runCodexExec(model, prompt, {
  timeoutMs = 180000,
  cwd = process.cwd(),
  config = {},
  sandbox = "read-only",
  skipGitRepoCheck = true,
  outputSchemaPath = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const { command, viaCmd } = resolveCodexLaunch();
    const args = [
      "exec",
      "--model",
      model,
    ];

    if (outputSchemaPath) {
      args.push("--output-schema", outputSchemaPath);
    }

    args.push(
      "--sandbox",
      sandbox,
      "--json",
      "-",
    );

    if (skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    for (const [key, value] of Object.entries(config)) {
      args.push("-c", `${key}=${value}`);
    }

    const spawnCommand = viaCmd ? (process.env.ComSpec || "cmd.exe") : command;
    const spawnArgs = viaCmd ? ["/d", "/c", command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      env: { ...process.env },
      windowsHide: true,
      cwd,
    });

    child.stdin.end(prompt, "utf8");

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      killChildProcess(child);
      reject(new Error(`Codex CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
    child.stderr.on("data", (data) => stderrChunks.push(data.toString()));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (killed) return;

      const output = stdoutChunks.join("");
      const stderr = stderrChunks.join("").trim();
      if (code !== 0) {
        reject(new Error(stderr || extractCodexMessage(output) || `Codex CLI exited with code ${code}`));
        return;
      }

      resolve(extractCodexMessage(output));
    });

    child.on("error", (err) => reject(err));
  });
}
