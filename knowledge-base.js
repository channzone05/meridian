/**
 * Knowledge Base — LLM-maintained markdown wiki.
 *
 * The agent writes and maintains interlinked markdown articles about tokens,
 * strategies, market regimes, and pool behaviors. Auto-maintained INDEX.md
 * and CONCEPTS.md replace the need for RAG at this scale.
 *
 * Existing JSON systems (lessons.json, pool-memory.json, nuggets) remain
 * the structured data sources. The KB is a synthesis layer on top.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getKbDir() {
  return path.resolve(__dirname, config.knowledgeBase?.dir || "./knowledge");
}

// ─── File I/O ──────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * List all .md articles, optionally filtered by category (subdirectory).
 */
export function listArticles(category = null) {
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return [];

  const articles = [];
  const searchDir = category ? path.join(kbDir, category) : kbDir;
  if (!searchDir.startsWith(kbDir)) return []; // prevent path traversal
  if (!fs.existsSync(searchDir)) return [];

  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Skip visuals directory in listings
        if (entry.name === "visuals") continue;
        walk(path.join(dir, entry.name), path.join(rel, entry.name));
      } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "CONCEPTS.md") {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, "utf8");
          const title = extractTitle(content) || entry.name.replace(".md", "");
          const summary = extractSummary(content);
          articles.push({
            path: path.join(rel, entry.name),
            title,
            summary,
            updated: stat.mtime.toISOString(),
            words: content.trim().split(/\s+/).filter(Boolean).length,
          });
        } catch { /* skip unreadable files */ }
      }
    }
  };

  walk(searchDir, category || "");
  articles.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return articles;
}

/**
 * Read an article by its relative path within the KB directory.
 */
export function readArticle(articlePath) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: `Article not found: ${articlePath}` };
  }

  return {
    path: articlePath,
    content: fs.readFileSync(fullPath, "utf8"),
    updated: fs.statSync(fullPath).mtime.toISOString(),
  };
}

/**
 * Write or update an article. Creates parent directories as needed.
 * Auto-updates the INDEX.md entry for this article.
 */
export function writeArticle(articlePath, content) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  // Enforce max articles
  const maxArticles = config.knowledgeBase?.maxArticles || 500;
  const existing = listArticles();
  const isNew = !fs.existsSync(fullPath);
  if (isNew && existing.length >= maxArticles) {
    return { error: `KB at capacity (${maxArticles} articles). Delete old articles first.` };
  }

  ensureDir(path.dirname(fullPath));
  fs.writeFileSync(fullPath, content);
  log("kb", `${isNew ? "Created" : "Updated"} article: ${articlePath}`);

  // Update index entry for this article
  updateIndexEntry(articlePath, content);

  return { success: true, path: articlePath, created: isNew };
}

/**
 * Delete an article and remove its INDEX.md entry.
 */
export function deleteArticle(articlePath) {
  const kbDir = getKbDir();
  const fullPath = path.join(kbDir, articlePath);

  if (!fullPath.startsWith(kbDir)) {
    return { error: "Invalid path — must be within knowledge directory" };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: `Article not found: ${articlePath}` };
  }

  fs.unlinkSync(fullPath);
  removeIndexEntry(articlePath);
  log("kb", `Deleted article: ${articlePath}`);
  return { success: true, path: articlePath };
}

/**
 * Full-text search across all articles. Returns matching file paths + context lines.
 */
export function searchArticles(query) {
  if (!query) return { error: "query required" };

  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return { results: [], total: 0 };

  const queryLower = query.toLowerCase();
  const results = [];

  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "visuals") continue;
        walk(path.join(dir, entry.name), path.join(rel, entry.name));
      } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "CONCEPTS.md") {
        const filePath = path.join(dir, entry.name);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const lines = content.split("\n");
          const matchedLines = [];

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
              matchedLines.push({ line: i + 1, text: lines[i].trim() });
            }
          }

          if (matchedLines.length > 0) {
            results.push({
              path: path.join(rel, entry.name),
              title: extractTitle(content) || entry.name.replace(".md", ""),
              matches: matchedLines.length,
              matchedLines: matchedLines.slice(0, 5), // Top 5 matches
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  };

  walk(kbDir, "");
  results.sort((a, b) => b.matches - a.matches);
  return { results: results.slice(0, 20), total: results.length };
}

// ─── Index Management ──────────────────────────────────────────

/**
 * Update a single entry in INDEX.md when an article is written.
 */
function updateIndexEntry(articlePath, content) {
  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  const title = extractTitle(content) || articlePath.replace(".md", "");
  const summary = extractSummary(content);
  const entry = `- [${title}](${articlePath}) — ${summary}`;

  let indexContent = "";
  if (fs.existsSync(indexPath)) {
    indexContent = fs.readFileSync(indexPath, "utf8");
  } else {
    indexContent = "# Knowledge Base Index\n\nAuto-maintained index of all articles.\n\n";
  }

  // Replace existing entry or append
  const entryPattern = new RegExp(`^- \\[.*?\\]\\(${escapeRegex(articlePath)}\\).*$`, "m");
  if (entryPattern.test(indexContent)) {
    indexContent = indexContent.replace(entryPattern, entry);
  } else {
    indexContent = indexContent.trimEnd() + "\n" + entry + "\n";
  }

  ensureDir(kbDir);
  fs.writeFileSync(indexPath, indexContent);
}

/**
 * Remove an entry from INDEX.md when an article is deleted.
 */
function removeIndexEntry(articlePath) {
  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) return;

  let indexContent = fs.readFileSync(indexPath, "utf8");
  const entryPattern = new RegExp(`^- \\[.*?\\]\\(${escapeRegex(articlePath)}\\).*\\n?`, "m");
  indexContent = indexContent.replace(entryPattern, "");
  fs.writeFileSync(indexPath, indexContent);
}

/**
 * Full rebuild of INDEX.md by scanning all articles.
 */
export function rebuildIndex() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  const articles = listArticles();
  const categories = {};

  for (const article of articles) {
    const cat = path.dirname(article.path) || "root";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(article);
  }

  let content = "# Knowledge Base Index\n\nAuto-maintained index of all articles.\n";

  for (const [cat, arts] of Object.entries(categories).sort()) {
    const label = cat === "." ? "General" : cat.charAt(0).toUpperCase() + cat.slice(1);
    content += `\n## ${label}\n\n`;
    for (const a of arts) {
      content += `- [${a.title}](${a.path}) — ${a.summary} *(${a.words} words, updated ${a.updated.slice(0, 10)})*\n`;
    }
  }

  fs.writeFileSync(path.join(kbDir, "INDEX.md"), content);
  log("kb", `Rebuilt INDEX.md (${articles.length} articles)`);
  return { articles: articles.length };
}

/**
 * Full rebuild of CONCEPTS.md by scanning all articles for [[backlinks]].
 */
export function rebuildConcepts() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  const articles = listArticles();
  const concepts = {};

  // Scan for [[concept]] style links (deduplicate per article)
  const linkPattern = /\[\[([^\]]+)\]\]/g;

  for (const article of articles) {
    const fullPath = path.join(kbDir, article.path);
    try {
      const fileContent = fs.readFileSync(fullPath, "utf8");
      let match;
      while ((match = linkPattern.exec(fileContent)) !== null) {
        const concept = match[1].trim();
        if (!concepts[concept]) concepts[concept] = new Set();
        concepts[concept].add(article.path);
      }
    } catch { /* skip unreadable files */ }
  }

  let content = "# Concepts\n\nRecurring themes and their backlinks across the knowledge base.\n";

  const sorted = Object.entries(concepts).sort((a, b) => b[1].size - a[1].size);
  for (const [concept, refs] of sorted) {
    content += `\n### ${concept}\n`;
    content += `Referenced in ${refs.size} article(s):\n`;
    for (const ref of refs) {
      content += `- [${ref}](${ref})\n`;
    }
  }

  fs.writeFileSync(path.join(kbDir, "CONCEPTS.md"), content);
  log("kb", `Rebuilt CONCEPTS.md (${sorted.length} concepts)`);
  return { concepts: sorted.length };
}

// ─── Migration ─────────────────────────���───────────────────────

/**
 * One-time migration from existing JSON data to initial KB articles.
 * Idempotent — skips articles that already exist.
 */
export async function migrateFromJson() {
  const kbDir = getKbDir();
  ensureDir(kbDir);

  let created = 0;
  let skipped = 0;

  // 1. Migrate lessons.json → knowledge/lessons/
  try {
    const lessonsPath = path.join(__dirname, "lessons.json");
    if (fs.existsSync(lessonsPath)) {
      const data = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
      const lessons = data.lessons || [];

      if (lessons.length > 0) {
        // Group lessons by tags
        const groups = {};
        for (const lesson of lessons) {
          const tag = (lesson.tags && lesson.tags[0]) || "general";
          if (!groups[tag]) groups[tag] = [];
          groups[tag].push(lesson);
        }

        for (const [tag, tagLessons] of Object.entries(groups)) {
          const slug = tag.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || "uncategorized";
          const articlePath = `lessons/${slug}.md`;
          const fullPath = path.join(kbDir, articlePath);

          if (fs.existsSync(fullPath)) { skipped++; continue; }

          let content = `# Lessons: ${tag}\n\n`;
          content += `*Migrated from lessons.json — ${tagLessons.length} lessons*\n\n`;

          for (const l of tagLessons) {
            content += `- ${l.rule}`;
            if (l.pnl_pct != null) content += ` *(PnL: ${l.pnl_pct}%)*`;
            if (l.pool) content += ` — pool: ${l.pool}`;
            content += `\n`;
          }

          const result = writeArticle(articlePath, content);
          if (result.success) created++; else skipped++;
        }
      }

      // Migrate performance data
      const perf = data.performance || [];
      if (perf.length > 0) {
        const perfPath = "performance/historical-summary.md";
        const fullPerfPath = path.join(kbDir, perfPath);

        if (!fs.existsSync(fullPerfPath)) {
          const wins = perf.filter(p => (p.pnl_pct ?? 0) >= 0);
          const losses = perf.filter(p => (p.pnl_pct ?? 0) < 0);
          const avgPnl = perf.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / perf.length;

          let content = `# Historical Performance Summary\n\n`;
          content += `*Migrated from lessons.json — ${perf.length} closed positions*\n\n`;
          content += `## Overview\n\n`;
          content += `- Total positions: ${perf.length}\n`;
          content += `- Wins: ${wins.length} (${((wins.length / perf.length) * 100).toFixed(0)}%)\n`;
          content += `- Losses: ${losses.length}\n`;
          content += `- Average PnL: ${avgPnl.toFixed(2)}%\n\n`;

          content += `## Recent Closes\n\n`;
          for (const p of perf.slice(-10)) {
            content += `- ${p.pool_name || p.pool || "unknown"}: ${(p.pnl_pct ?? 0).toFixed(1)}% PnL, ${p.close_reason || "manual"}\n`;
          }

          const perfResult = writeArticle(perfPath, content);
          if (perfResult.success) created++; else skipped++;
        } else { skipped++; }
      }
    }
  } catch (e) {
    log("kb", `Lessons migration error: ${e.message}`);
  }

  // 2. Migrate pool-memory.json → knowledge/pools/
  try {
    const poolMemPath = path.join(__dirname, "pool-memory.json");
    if (fs.existsSync(poolMemPath)) {
      const pools = JSON.parse(fs.readFileSync(poolMemPath, "utf8"));

      for (const [addr, pool] of Object.entries(pools)) {
        if ((pool.total_deploys || 0) < 2) continue; // Only migrate pools with history

        const slug = (pool.name || addr.slice(0, 8)).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || addr.slice(0, 8);
        const articlePath = `pools/${slug}.md`;
        const fullPath = path.join(kbDir, articlePath);

        if (fs.existsSync(fullPath)) { skipped++; continue; }

        let content = `# Pool: ${pool.name || addr.slice(0, 8)}\n\n`;
        content += `**Address:** \`${addr}\`\n`;
        if (pool.base_mint) content += `**Base Mint:** \`${pool.base_mint}\`\n`;
        content += `\n## Deploy History\n\n`;
        content += `- Total deploys: ${pool.total_deploys}\n`;
        content += `- Average PnL: ${pool.avg_pnl_pct}%\n`;
        content += `- Win rate: ${((pool.win_rate || 0) * 100).toFixed(0)}%\n`;
        content += `- Last outcome: ${pool.last_outcome || "unknown"}\n\n`;

        if (pool.deploys?.length > 0) {
          content += `## Deploy Details\n\n`;
          for (const d of pool.deploys.slice(-5)) {
            content += `- ${d.closed_at?.slice(0, 10) || "?"}: PnL ${d.pnl_pct ?? "?"}%, held ${d.minutes_held ?? "?"}min, strategy: ${d.strategy || "?"}, reason: ${d.close_reason || "?"}\n`;
          }
        }

        if (pool.notes?.length > 0) {
          content += `\n## Notes\n\n`;
          for (const n of pool.notes) {
            content += `- ${n.added_at?.slice(0, 10) || "?"}: ${n.note}\n`;
          }
        }

        const poolResult = writeArticle(articlePath, content);
        if (poolResult.success) created++; else skipped++;
      }
    }
  } catch (e) {
    log("kb", `Pool memory migration error: ${e.message}`);
  }

  // 3. Migrate nuggets facts → knowledge/strategies/ and knowledge/patterns/
  try {
    const { getShelf } = await import("./memory.js");
    const shelf = getShelf();

    for (const nuggetName of ["strategies", "patterns"]) {
      try {
        const nugget = shelf.get(nuggetName);
        if (!nugget) continue;
        const facts = nugget.facts();
        if (facts.length === 0) continue;

        const articlePath = `${nuggetName}/compiled-from-nuggets.md`;
        const fullPath = path.join(kbDir, articlePath);

        if (fs.existsSync(fullPath)) { skipped++; continue; }

        let content = `# ${nuggetName.charAt(0).toUpperCase() + nuggetName.slice(1)}: Compiled from Memory\n\n`;
        content += `*Migrated from Nuggets holographic memory — ${facts.length} facts*\n\n`;

        for (const f of facts) {
          content += `- **${f.key}**: ${f.value}`;
          if (f.hits > 1) content += ` *(recalled ${f.hits}x)*`;
          content += `\n`;
        }

        const nuggetResult = writeArticle(articlePath, content);
        if (nuggetResult.success) created++; else skipped++;
      } catch { /* nugget may not exist */ }
    }
  } catch (e) {
    log("kb", `Nuggets migration error: ${e.message}`);
  }

  // 4. Rebuild indexes
  rebuildIndex();
  rebuildConcepts();

  log("kb", `Migration complete: ${created} articles created, ${skipped} skipped`);
  return { created, skipped };
}

// ─── Stats & Prompt ────────────────────────────────────────────

/**
 * Get KB statistics.
 */
export function getKbStats() {
  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) {
    return { totalArticles: 0, totalWords: 0, categories: {}, lastUpdated: null };
  }

  const articles = listArticles();
  const categories = {};
  let totalWords = 0;
  let lastUpdated = null;

  for (const a of articles) {
    const cat = path.dirname(a.path) || "root";
    categories[cat] = (categories[cat] || 0) + 1;
    totalWords += a.words;
    if (!lastUpdated || a.updated > lastUpdated) lastUpdated = a.updated;
  }

  return {
    totalArticles: articles.length,
    totalWords,
    categories,
    lastUpdated,
  };
}

/**
 * Short summary for system prompt injection.
 * Returns null if KB is empty or disabled.
 */
export function getKbSummaryForPrompt() {
  if (!config.knowledgeBase?.enabled) return null;

  const kbDir = getKbDir();
  const indexPath = path.join(kbDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) return null;

  const stats = getKbStats();
  if (stats.totalArticles === 0) return null;

  // Read INDEX.md (truncated if large)
  const indexContent = fs.readFileSync(indexPath, "utf8");
  const truncated = indexContent.length > 3000
    ? indexContent.slice(0, 3000) + "\n...(truncated, use kb_read for full index)"
    : indexContent;

  return `Knowledge Base: ${stats.totalArticles} articles, ${stats.totalWords} words across ${Object.keys(stats.categories).length} categories.
Last updated: ${stats.lastUpdated?.slice(0, 10) || "never"}
Use kb_read, kb_search, and kb_list tools to explore. Use kb_write to add observations.

${truncated}`;
}

// ─── Observation Filing ────────────────────────────────────────

let _lastFileTime = 0;
const FILE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check if observations should be filed after a management cycle.
 * Returns a goal string for the agent if filing is needed, null otherwise.
 */
export function shouldFileObservations() {
  if (!config.knowledgeBase?.enabled || !config.knowledgeBase?.autoFile) return null;
  if (Date.now() - _lastFileTime < FILE_COOLDOWN_MS) return null;

  const kbDir = getKbDir();
  if (!fs.existsSync(kbDir)) return null;

  _lastFileTime = Date.now();
  return `KNOWLEDGE BASE FILING: Review recent management cycle results. If there were notable events (position closes, significant PnL changes, new patterns observed), file observations into the knowledge base using kb_write. Update existing articles if relevant, or create new ones. Keep articles concise and interlinked using [[concept]] syntax. Skip filing if nothing notable happened.`;
}

// ─── Helpers ───────────────────────────────────────────────────

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractSummary(content) {
  // First non-empty, non-heading line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("*Migrated")) {
      return trimmed.slice(0, 120);
    }
  }
  return "";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
