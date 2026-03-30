import { spawn } from "child_process";
import OpenAI from "openai";
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

  // ─── Step 1: Pre-fetch screening data in-process ───────────
  const candidates = await getTopCandidates({ limit: 5 });
  if (!candidates?.candidates?.length) {
    return { content: "No eligible candidates found this cycle.", userMessage: goal };
  }

  // Study top LPers for the best candidate
  const top = candidates.candidates[0];
  const [study, tokenInfo] = await Promise.all([
    studyTopLPers({ pool_address: top.pool_address }).catch(() => null),
    getTokenInfo({ mint: top.base_mint }).catch(() => null),
  ]);

  // ─── Step 2: Build Codex prompt with pre-fetched data ──────
  const dataBlock = [
    `CANDIDATES:\n${JSON.stringify(candidates.candidates, null, 2)}`,
    study ? `\nTOP LPER STUDY (${top.name}):\n${JSON.stringify(study, null, 2)}` : "",
    tokenInfo ? `\nTOKEN INFO (${top.name}):\n${JSON.stringify(tokenInfo, null, 2)}` : "",
  ].join("\n");

  const decisionPrompt = `${systemPrompt}

${dataBlock}

---
TASK:
${goal}

IMPORTANT: You must respond with a JSON deployment plan. If you recommend deploying, respond with ONLY a JSON block like:
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
{ "action": "skip", "reasoning": "<why>" }
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
function runCodexExec(model, prompt) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const codexBin = process.env.CODEX_PATH || "/c/Users/fciaf/AppData/Roaming/npm/codex";

    const child = spawn(codexBin, [
      "exec",
      "--model", model,
      "-c", "model_reasoning_effort=\"high\"",
      "--full-auto",
      "--skip-git-repo-check",
      "-C", process.cwd(),
      "-",  // read prompt from stdin
    ], {
      timeout: 180000,
      env: { ...process.env },
      shell: true,
    });

    // Pipe the prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", (data) => chunks.push(data.toString()));
    child.stderr.on("data", (data) => log("codex", data.toString().trim()));

    child.on("close", (code) => {
      const output = chunks.join("");
      if (code !== 0 && !output) {
        reject(new Error(`Codex CLI exited with code ${code}`));
        return;
      }
      // Try to extract the last assistant message from JSONL output
      try {
        const lines = output.trim().split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const event = JSON.parse(lines[i]);
          if (event.type === "message" && event.role === "assistant" && event.content) {
            resolve(typeof event.content === "string"
              ? event.content
              : event.content.map(c => c.text || "").join("\n"));
            return;
          }
        }
      } catch {
        // Not JSON — use raw output
      }
      resolve(output);
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
  // Route to Codex CLI when codexScreening is enabled for SCREENER agent
  if (config.llm.codexScreening && agentType === "SCREENER") {
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
      log("agent", `Codex CLI failed (${err.message}), falling back to OpenRouter`);
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

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient errors; fallback model on 2nd failure
      const FALLBACK_MODEL = "deepseek/deepseek-v3.2-speciale";
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
          // On 2nd failure, switch to fallback model
          if (attempt >= 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Primary model failed (${status}), switching to fallback ${FALLBACK_MODEL}`);
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
          log("agent", "Empty response, retrying...");
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
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

  const FALLBACK_MODEL = "deepseek/deepseek-v3.2-speciale";
  const modelsToTry = [model || DEFAULT_MODEL, FALLBACK_MODEL];

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
      if (tryModel !== FALLBACK_MODEL && (status === 402 || status === 429 || status === 502 || status === 503 || status === 504 || status === 529)) {
        log("agent", `Light chat primary failed (${status}), trying fallback ${FALLBACK_MODEL}`);
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
