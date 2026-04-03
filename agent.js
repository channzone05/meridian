import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions, getActiveBin } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getMemoryContext } from "./memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getLpOverviewSummary } from "./tools/lp-overview.js";
import { getTopCandidates, fetchDynamicFee } from "./tools/screening.js";
import { studyTopLPers } from "./tools/study.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";

// Configurable LLM provider: "openrouter" (default) or "deepseek"
const provider = process.env.LLM_PROVIDER || "openrouter";
const client = new OpenAI({
  baseURL: provider === "deepseek"
    ? "https://api.deepseek.com"
    : "https://openrouter.ai/api/v1",
  apiKey: provider === "deepseek"
    ? process.env.DEEPSEEK_API_KEY
    : process.env.OPENROUTER_API_KEY,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openai/gpt-5.4-nano";
const CODEX_SCREENING_SCHEMA_PATH = fileURLToPath(new URL("./tools/codex-screening-plan.schema.json", import.meta.url));

export function isCodexScreenerEnabled() {
  return Boolean(config.llm.codexScreening);
}

export function getScreenerModelLabel() {
  return isCodexScreenerEnabled()
    ? `codex/${config.llm.codexModel || "gpt-5.4"}`
    : config.llm.screeningModel;
}

export async function screenerLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = []) {
  return agentLoop(goal, maxSteps, sessionHistory, "SCREENER", config.llm.screeningModel);
}

function getRolePrimaryModel(agentType) {
  if (agentType === "SCREENER") return config.llm.screeningModel;
  if (agentType === "MANAGER") return config.llm.managementModel;
  return config.llm.generalModel;
}

function getRoleFallbackModel(agentType, primaryModel) {
  const configuredFallback = agentType === "SCREENER"
    ? config.llm.screeningFallbackModel
    : agentType === "MANAGER"
      ? config.llm.managementFallbackModel
      : config.llm.generalFallbackModel;

  if (configuredFallback && configuredFallback !== primaryModel) {
    return configuredFallback;
  }

  const rolePrimary = getRolePrimaryModel(agentType);
  if (rolePrimary && rolePrimary !== primaryModel) {
    return rolePrimary;
  }

  return null;
}

/**
 * Codex CLI-based agent loop for screening.
 * Pre-fetches screening data in-process, sends it to Codex for analysis,
 * then executes deployment decisions through executeTool.
 *
 * Flow: gather data → Codex analyzes → parse JSON decision → execute deploy
 *
 * @param {string} goal - The original screening goal
 * @param {number} maxSteps - Unused (kept for interface parity)
 * @param {string} systemPrompt - Full system prompt with portfolio/LP context
 * @returns {Promise<{content: string, userMessage: string}>}
 */
async function codexAgentLoop(goal, maxSteps, systemPrompt) {
  const model = config.llm.codexModel || "gpt-5.4";
  log("agent", `Codex screening via CLI (model: ${model})`);

  // ─── Step 1: Pre-fetch ALL screening data in-process ───────
  const candidates = await getTopCandidates({ limit: 5 });
  if (!candidates?.candidates?.length) {
    return { content: "No eligible candidates found this cycle.", userMessage: goal };
  }

  // Enrich ALL candidates with the same data the cron path uses
  const { checkSmartWalletsOnPool } = await import("./smart-wallets.js");
  const { getTokenHolders, getTokenNarrative } = await import("./tools/token.js");
  const { fetchOkxPriceInfo, fetchOkxDexSignal } = await import("./tools/okx.js");
  const { recallForPool } = await import("./pool-memory.js");

  const enriched = await Promise.all(candidates.candidates.map(async (c) => {
    const mint = c.base_mint || c.base?.mint;
    const [study, sw, holders, narrative, poolMem, tokenInfo, okxData, okxSignal] = await Promise.allSettled([
      studyTopLPers({ pool_address: c.pool }).catch(() => null),
      checkSmartWalletsOnPool({ pool_address: c.pool }),
      mint ? getTokenHolders({ mint }) : null,
      mint ? getTokenNarrative({ mint }) : null,
      recallForPool(c.pool),
      mint ? getTokenInfo({ query: mint }).catch(() => null) : null,
      mint ? fetchOkxPriceInfo(mint) : null,
      mint ? fetchOkxDexSignal(mint) : null,
    ]);

    const data = { ...c };
    const val = (r) => r.status === "fulfilled" ? r.value : null;
    if (val(study)) data._study = val(study);
    data._smart_wallets = val(sw)?.in_pool?.length || 0;
    const h = val(holders);
    if (h) {
      data._global_fees_sol = h.global_fees_sol;
      data._top_10_real_holders_pct = h.top_10_real_holders_pct;
      data._bundlers_pct = h.bundlers_pct;
    }
    if (val(narrative)?.narrative) data._narrative = val(narrative).narrative.slice(0, 300);
    if (val(poolMem)) data._pool_memory = val(poolMem);
    if (val(tokenInfo)) data._token_info = val(tokenInfo);
    const okx = val(okxData);
    if (okx) {
      data._ath_proximity_pct = okx.ath_proximity_pct;
      data._momentum = { change_5m: okx.change_5m, change_1h: okx.change_1h, change_4h: okx.change_4h };
    }
    if (val(okxSignal)) data._okx_signal = val(okxSignal);
    return data;
  }));

  // ─── Step 2: Build Codex prompt with pre-fetched data ──────
  const dataBlock = `CANDIDATES (fully enriched — all safety fields included):\n${JSON.stringify(enriched, null, 2)}`;

  // Strip tool-call instructions from prompt — Codex can't call our tools,
  // data is already pre-fetched above. This prevents Codex from trying to
  // execute tool calls via shell and hanging.
  const analysisPrompt = systemPrompt
    .replace(/Call\s+(get_top_candidates|study_top_lpers|get_pool_detail|get_pool_memory|check_smart_wallets_on_pool|get_token_holders|get_token_narrative|deploy_position|get_active_bin|get_wallet_balance|update_config|close_position|swap_token|claim_fees|get_position_pnl|set_position_note|remember_fact|recall_memory|forget_fact|get_my_positions|discover_pools|add_lesson|self_update)[^.]*\./gi, "")
    .replace(/\b(SCREEN|STUDY|DEPLOY|MEMORY):\s*Use\s+\w+/g, "")
    .replace(/You have access to these tools[\s\S]*?(?=\n\n)/g, "")
    .replace(/Available tools[\s\S]*?(?=\n\n)/g, "");

  const decisionPrompt = `${analysisPrompt}

YOU ARE IN ANALYSIS-ONLY MODE. You CANNOT call any tools or run any commands.
All data has been pre-fetched for you below. Analyze it and respond with JSON only.

${dataBlock}

---
TASK:
${goal}

OKX signal interpretation:
- latest_signal_age_min lower = fresher wallet interest
- signal_count_30m / signal_count_2h and signal_amount_usd_30m / signal_amount_usd_2h measure recent wallet conviction
- latest_sold_ratio_percent lower = signal wallets are still holding; higher = signal more exhausted
- Use OKX signal as confirmation only, never as a standalone deploy trigger
- Missing OKX signal is neutral, not a hard fail

IMPORTANT: You must respond with a JSON deployment plan. Do NOT try to call any tools or run any commands. If you recommend deploying, respond with ONLY a JSON block like:
\`\`\`json
{
  "action": "deploy",
  "pool_address": "<address>",
  "pool_name": "<name>",
  "base_mint": "<mint>",
  "strategy": "bid_ask" | "spot",
  "price_range_pct": <number>,
  "amount_sol": <number>,
  "sol_split_pct": <number or null>,
  "reasoning": "<brief explanation>"
}
\`\`\`
If no candidate is suitable, respond with:
\`\`\`json
{
  "action": "skip",
  "pool_address": null,
  "pool_name": null,
  "base_mint": null,
  "strategy": null,
  "price_range_pct": null,
  "amount_sol": null,
  "sol_split_pct": null,
  "reasoning": "<why>"
}
\`\`\``;

  // ─── Step 3: Send to Codex CLI ─────────────────────────────
  const codexResponse = await runCodexExec(model, decisionPrompt);
  log("agent", `Codex response: ${codexResponse.slice(0, 500)}`);

  // ─── Step 4: Parse decision and execute ────────────────────
  const jsonMatch = codexResponse.match(/```json\s*([\s\S]*?)```/) || codexResponse.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    log("agent", "Codex returned no parseable JSON, returning text response");
    return { content: codexResponse, userMessage: goal };
  }

  let plan;
  try {
    plan = JSON.parse(jsonMatch[1]);
  } catch {
    log("agent", "Failed to parse Codex JSON decision");
    return { content: codexResponse, userMessage: goal };
  }

  if (plan.action === "skip") {
    const msg = `Codex screening: SKIP — ${plan.reasoning}`;
    log("agent", msg);
    return { content: msg, userMessage: goal };
  }

  if (plan.action === "deploy") {
    const requiredDeployFields = ["pool_address", "pool_name", "base_mint", "strategy", "price_range_pct", "amount_sol"];
    const missingFields = requiredDeployFields.filter((field) => plan[field] == null);
    if (missingFields.length) {
      log("agent", `Codex deploy plan missing required fields: ${missingFields.join(", ")}`);
      return { content: codexResponse, userMessage: goal };
    }

    log("agent", `Codex recommends deploy: ${plan.pool_name} (${plan.strategy}, range ${plan.price_range_pct}%)`);

    const deployArgs = {
      pool_address: plan.pool_address,
      pool_name: plan.pool_name,
      base_mint: plan.base_mint,
      strategy: plan.strategy || "bid_ask",
      price_range_pct: plan.price_range_pct,
      amount_sol: plan.amount_sol,
      ...(plan.sol_split_pct != null && { sol_split_pct: plan.sol_split_pct }),
    };

    const result = await executeTool("deploy_position", deployArgs);
    const summary = result.error || result.blocked
      ? `Codex screening: deploy blocked — ${result.reason || result.error}`
      : `Codex screening: deployed ${plan.amount_sol} SOL to ${plan.pool_name} (${plan.strategy}, range ${plan.price_range_pct}%). Reasoning: ${plan.reasoning}`;

    return { content: summary, userMessage: goal };
  }

  return { content: codexResponse, userMessage: goal };
}

/**
 * Spawn `codex exec` and return its text output.
 * Pipes prompt via stdin (using "-") to avoid ENAMETOOLONG on large prompts.
 */
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
        return { command: configured };
      }

      const siblingExe = configured.replace(/\.(cmd|bat|ps1)$/i, ".exe");
      if (siblingExe !== configured && existsSync(siblingExe)) {
        return { command: siblingExe };
      }

      const codexExe = findExecutableOnPath("codex.exe");
      if (codexExe) return { command: codexExe };
    }

    return {
      command: configured,
    };
  }

  if (process.platform === "win32") {
    const codexExe = findExecutableOnPath("codex.exe");
    if (codexExe) return { command: codexExe };

    const codexAny = findExecutableOnPath("codex");
    if (codexAny && /\.exe$/i.test(codexAny)) return { command: codexAny };

    const codexCmd = findExecutableOnPath("codex.cmd");
    if (codexCmd) {
      const siblingExe = codexCmd.replace(/\.cmd$/i, ".exe");
      if (siblingExe !== codexCmd && existsSync(siblingExe)) return { command: siblingExe };
    }
  }

  return { command: "codex" };
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

function runCodexExec(model, prompt) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const { command } = resolveCodexLaunch();
    const args = [
      "exec",
      "--model",
      model,
      "--output-schema",
      CODEX_SCREENING_SCHEMA_PATH,
      "--sandbox",
      "read-only",
      "-c",
      "model_reasoning_effort=high",
      "--skip-git-repo-check",
      "--json",
      "-",
    ];

    const child = spawn(command, args, {
      env: { ...process.env },
      windowsHide: true,
      cwd: process.cwd(),
    });

    child.stdin.end(prompt, "utf8");

    // Manual kill timer — spawn timeout doesn't work reliably on Windows
    const TIMEOUT_MS = 180000;
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      killChildProcess(child);
      reject(new Error(`Codex CLI timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderrChunks.push(text);
      const trimmed = text.trim();
      if (trimmed) log("codex", trimmed);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (killed) return;

      const output = stdoutChunks.join("");
      const stderr = stderrChunks.join("").trim();
      const lines = output.trim().split(/\r?\n/).filter(Boolean);
      let lastStructuredError = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item?.text) {
            resolve(event.item.text);
            return;
          }
          if (event.type === "message" && event.role === "assistant" && event.content) {
            resolve(typeof event.content === "string"
              ? event.content
              : event.content.map((c) => c.text || "").join("\n"));
            return;
          }
          if (!lastStructuredError && event.type === "item.completed" && event.item?.type === "error" && event.item?.message) {
            lastStructuredError = event.item.message;
          }
        } catch {
          // Ignore non-JSON lines and keep scanning.
        }
      }

      if (code !== 0) {
        reject(new Error(stderr || lastStructuredError || `Codex CLI exited with code ${code}`));
        return;
      }

      resolve(output || stderr || "");
    });

    child.on("error", (err) => reject(err));
  });
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null) {
  // When enabled, Codex CLI fully replaces the normal screener model path.
  if (isCodexScreenerEnabled() && agentType === "SCREENER") {
    const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
    const stateSummary = getStateSummary();
    const lessons = getLessonsForPrompt({ agentType });
    const perfSummary = getPerformanceSummary();
    const memoryContext = getMemoryContext();
    const signalWeights = getWeightsSummary() || null;
    let systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, memoryContext, signalWeights);
    const lpSummary = await getLpOverviewSummary().catch(() => null);
    if (lpSummary) {
      systemPrompt += `\n\nLP AGENT PERFORMANCE (real data from LP Agent API — use this for accurate PnL):\n${lpSummary}\n`;
    }
    try {
      return await codexAgentLoop(goal, maxSteps, systemPrompt);
    } catch (err) {
      log("agent", `Codex CLI failed (${err.message}), falling back to screening model ${config.llm.screeningModel}`);
    }
  }

  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const memoryContext = getMemoryContext();
  const signalWeights = agentType === "SCREENER" ? (getWeightsSummary() || null) : null;
  let systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, memoryContext, signalWeights);

  // Append verified on-chain LP performance from LP Agent API
  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    systemPrompt += `\n\nLP AGENT PERFORMANCE (real data from LP Agent API — use this for accurate PnL):\n${lpSummary}\n`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,          // inject prior conversation turns
    { role: "user", content: goal },
  ];
  let consecutiveEmptyResponses = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || getRolePrimaryModel(agentType) || DEFAULT_MODEL;
      const fallbackModel = getRoleFallbackModel(agentType, activeModel);

      // Retry up to 3 times on transient errors; optional configured fallback on 2nd failure
      const RETRYABLE = new Set([402, 408, 429, 502, 503, 504, 529]);
      let response;
      let usedModel = activeModel;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools,
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: config.llm.maxTokens,
          });
          if (response.choices?.length) break;
          // Response body error (some providers return errors inline)
          const errCode = response.error?.code || response.error?.status;
          if (RETRYABLE.has(errCode)) {
            throw Object.assign(new Error(response.error?.message || `Provider error ${errCode}`), { status: errCode });
          }
          break; // non-retryable response error
        } catch (apiErr) {
          const status = apiErr.status || apiErr.statusCode;
          if (!RETRYABLE.has(status)) throw apiErr;
          // On 2nd failure, switch to configured fallback if one exists.
          if (attempt >= 1 && fallbackModel && usedModel !== fallbackModel) {
            usedModel = fallbackModel;
            log("agent", `Primary model failed (${status}), switching to fallback ${fallbackModel}`);
          } else {
            const wait = (attempt + 1) * 5000;
            log("agent", `Provider error ${status}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
          response = null; // ensure we retry
        }
      }

      if (!response?.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response?.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          consecutiveEmptyResponses += 1;
          if (consecutiveEmptyResponses >= 3) {
            throw new Error(`Model returned ${consecutiveEmptyResponses} empty responses in a row`);
          }
          log("agent", `Empty response, retrying (${consecutiveEmptyResponses}/3)...`);
          continue;
        }
        consecutiveEmptyResponses = 0;
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      consecutiveEmptyResponses = 0;
      // On-chain write operations must run sequentially to avoid blockhash
      // expiry from parallel Solana transactions competing for block space.
      // Read-only tools can still run in parallel for speed.
      const WRITE_TOOLS = new Set(["deploy_position", "close_position", "claim_fees", "swap_token"]);
      const writeCalls = msg.tool_calls.filter(tc => WRITE_TOOLS.has(tc.function.name));
      const readCalls = msg.tool_calls.filter(tc => !WRITE_TOOLS.has(tc.function.name));

      // Run read-only calls in parallel
      const readResults = await Promise.all(readCalls.map(async (toolCall) => {
        const functionName = toolCall.function.name;
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }
        const result = await executeTool(functionName, functionArgs);
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      // Run write calls sequentially
      const writeResults = [];
      for (const toolCall of writeCalls) {
        const functionName = toolCall.function.name;
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }
        const result = await executeTool(functionName, functionArgs);
        writeResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      // Merge results in original call order
      const resultMap = new Map([...readResults, ...writeResults].map(r => [r.tool_call_id, r]));
      const toolResults = msg.tool_calls.map(tc => resultMap.get(tc.id));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

/**
 * Lightweight chat — uses nuggets-cached context instead of fetching from chain.
 * First attempts a single LLM call with no tools. If the LLM says it needs tools
 * (by including "[NEED_TOOLS]" in its response), escalates to full agentLoop.
 *
 * Typical response time: ~1-3s vs ~15-30s for full agentLoop.
 */
export async function lightChat(goal, sessionHistory = [], model = null) {
  const stateSummary = getStateSummary();
  const memoryContext = getMemoryContext();
  const perfSummary = getPerformanceSummary();

  // Build a lightweight context from cached/local data only — no RPC calls
  const contextParts = [
    `You are a DLMM liquidity agent assistant. Answer the user's question using the context below.`,
    `If you need LIVE on-chain data (current prices, exact PnL, execute transactions) that isn't in the context, respond with exactly "[NEED_TOOLS]" and nothing else.`,
    `For general questions, explanations, strategy discussion, or anything answerable from context — just answer directly.`,
  ];

  if (stateSummary) contextParts.push(`\nCURRENT STATE:\n${stateSummary}`);
  if (memoryContext) contextParts.push(`\nMEMORY (from nuggets):\n${memoryContext}`);
  if (perfSummary) {
    contextParts.push(`\nPERFORMANCE: ${perfSummary.total_positions_closed} closed, win rate ${perfSummary.win_rate_pct}%, avg PnL ${perfSummary.avg_pnl_pct}%`);
  }

  // Append verified on-chain LP performance from LP Agent API
  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    contextParts.push(`\nLP AGENT PERFORMANCE (verified on-chain data):\n${lpSummary}`);
  }

  const messages = [
    { role: "system", content: contextParts.join("\n") },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const primaryModel = model || getRolePrimaryModel("GENERAL") || DEFAULT_MODEL;
  const fallbackModel = getRoleFallbackModel("GENERAL", primaryModel);
  const modelsToTry = fallbackModel ? [primaryModel, fallbackModel] : [primaryModel];

  for (const tryModel of modelsToTry) {
    try {
      const response = await client.chat.completions.create({
        model: tryModel,
        messages,
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content || content.trim().includes("[NEED_TOOLS]")) {
        log("agent", "Light chat escalating to full agent loop");
        return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
      }

      log("agent", `Light chat answered directly (${tryModel})`);
      return { content, userMessage: goal };
    } catch (e) {
      const status = e.status || e.statusCode;
      if (fallbackModel && tryModel !== fallbackModel && (status === 402 || status === 429 || status === 502 || status === 503 || status === 504 || status === 529)) {
        log("agent", `Light chat primary failed (${status}), trying fallback ${fallbackModel}`);
        continue;
      }
      log("agent", `Light chat failed (${e.message}), falling back to full agent loop`);
      return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

