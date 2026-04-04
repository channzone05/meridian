import { readFileSync } from "fs";
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
    const token = auth.access_token || auth.api_key || auth.token;
    if (!token) {
      throw new Error("No token field found in ~/.codex/auth.json");
    }
    return token;
  } catch (error) {
    throw new Error(`Codex OAuth token not available (${error.message}). Run "codex login" first.`);
  }
}

export function getProviderApiKey(provider = getLlmProvider()) {
  if (provider === "codex") return readCodexOAuthToken();
  if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
  return process.env.OPENROUTER_API_KEY;
}

export function getProviderClientConfig(provider = getLlmProvider()) {
  if (provider === "codex") {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: getProviderApiKey(provider),
    };
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
  if (provider === "codex") return "https://api.openai.com/v1/chat/completions";
  if (provider === "deepseek") return "https://api.deepseek.com/chat/completions";
  return "https://openrouter.ai/api/v1/chat/completions";
}

export function createLlmClient(provider = getLlmProvider()) {
  return new OpenAI(getProviderClientConfig(provider));
}
