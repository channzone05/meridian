import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getMemoryContext } from "./memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getLpOverviewSummary } from "./tools/lp-overview.js";
import { createLlmClient, getDefaultModelForProvider } from "./llm-provider.js";

const client = createLlmClient();

const DEFAULT_MODEL = process.env.LLM_MODEL || getDefaultModelForProvider();
export function getScreenerModelLabel() {
  return config.llm.screeningModel;
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
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null) {
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
