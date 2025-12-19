import fetch from "node-fetch";
import Parser from "rss-parser";
import Redis from "ioredis";

/* ================== CONFIG (same baseline RSS) ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 10);

const RSS_URL = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(GEO)}`;
const parser = new Parser();

/* ================== ENRICHMENT SOURCE ==================
   We KEEP RSS as baseline, but enrich via SerpApi Trending Now.
   SerpApi engine: google_trends_trending_now :contentReference[oaicite:1]{index=1}
*/
const SERPAPI_KEY = process.env.SERPAPI_KEY;
if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");

const SERPAPI_URL =
  `https://serpapi.com/search.json?engine=google_trends_trending_now` +
  `&geo=${encodeURIComponent(GEO)}` +
  `&hl=el` +
  `&api_key=${encodeURIComponent(SERPAPI_KEY)}`;

/* ================== DIFF STATE (Redis) ================== */
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("Missing REDIS_URL");

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 8000,
  enableOfflineQueue: false,
  lazyConnect: true
});
redis.on("error", (e) => console.log("[redis]", e?.message || e));

const SEEN_KEY = `gt:prev_top10:${GEO}`;

const normalize = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

/* ================== Slack ================== */
async function postToSlack(blocks, text = "Google Trends") {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed: ${res.status} ${t}`);
  }
}

function relTimeFromMinutes(mins) {
  if (mins == null || Number.isNaN(Number(mins))) return "—";
  const m = Number(mins);
  if (m < 60) return `Started ${m} min ago`;
  const h = Math.round((m / 60) * 10) / 10; // 1 decimal
  return `Started ${h} hours ago`;
}

function exploreLink(q) {
  const url = `https://trends.google.com/trends/explore?geo=${GEO}&q=${encodeURIComponent(q)}`;
  return `<${url}|${q}>`;
}

/* ================== 1) Baseline: RSS ================== */
async function fetchTrendingRssTopN() {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml,application/xml,text/xml,*/*;q=0.9"
    },
    redirect: "follow"
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} | ${xml.slice(0, 140)}`);

  const feed = await parser.parseString(xml);
  // RSS items usually have title + link, we only need title baseline
  return (feed.items || []).slice(0, MAX_ITEMS).map((it) => ({
    title: String(it.title || "—")
  }));
}

/* ================== 2) Enrichment: SerpApi ================== */
async function fetchSerpApiTrendingNow() {
  const res = await fetch(SERPAPI_URL, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status} | ${text.slice(0, 140)}`);
  return JSON.parse(text);
}

function indexEnrichmentByTitle(serpJson) {
  // SerpApi returns structured data; fields vary slightly but commonly include:
  // query/title, search volume/traffic, time active, related queries, explore links. :contentReference[oaicite:2]{index=2}
  const items =
    serpJson?.trending_searches ||
    serpJson?.trending_now ||
    serpJson?.trending_searches_results ||
    serpJson?.realtime_trends ||
    [];

  const map = new Map();
  for (const it of items) {
    const title = String(it?.query || it?.title || it?.trend || "");
    if (!title) continue;

    const volume = it?.search_volume || it?.traffic || it?.formattedTraffic || it?.searches || "—";

    // prefer “time_active_minutes” if present, else try derive from start/end
    const timeActiveMin = it?.time_active_minutes ?? null;

    const breakdown =
      (it?.related_queries || it?.queries || it?.breakdown || [])
        .map((q) => String(q?.query || q))
        .filter(Boolean)
        .slice(0, 3);

    map.set(normalize(title), {
      volume: String(volume),
      startedText: relTimeFromMinutes(timeActiveMin),
      breakdownLinks: (breakdown.length ? breakdown : [title]).slice(0, 3).map(exploreLink).join(", ")
    });
  }
  return map;
}

/* ================== Newsroom Slack layout ================== */
function buildNewsroomBlocks(rows, newCount) {
  const now = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  // “Table-like” mono-space feel with pipes
  const header = `*Trending Now (GR)* — 🆕 ${newCount} NEW`;
  const columns = `*Trend* | *Volume* | *Started* | *Breakdown*`;
  const separator = "—".repeat(88);

  const lines = rows.map((r, idx) => {
    const badge = r.isNew ? "🆕" : "  ";
    // Badge δίπλα στο trend (όπως ζήτησες)
    const trend = `${badge} *${idx + 1}. ${r.title}*`;
    return `${trend} | ${r.volume} | ${r.startedText} | ${r.breakdownLinks}`;
  });

  return [
    { type: "header", text: { type: "plain_text", text: `🇬🇷 Trending Now — ${newCount} NEW`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `⏱️ ${now} • Post μόνο αν υπάρχει νέο στο Top10` }] },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: [header, columns, separator, ...lines].join("\n") } }
  ];
}

/* ================== MAIN ================== */
async function main() {
  // Connect Redis (state for diff)
  await redis.connect();

  // 1) Baseline list from RSS (kept as you requested)
  const rssTop = await fetchTrendingRssTopN();

  // 2) Enrichment snapshot
  const serp = await fetchSerpApiTrendingNow();
  const enrichMap = indexEnrichmentByTitle(serp);

  // 3) Compose Top10 rows
  const rows = rssTop.map((r) => {
    const e = enrichMap.get(normalize(r.title)) || {};
    return {
      title: r.title,
      volume: e.volume || "—",
      startedText: e.startedText || "—",
      breakdownLinks: e.breakdownLinks || exploreLink(r.title)
    };
  });

  // 4) Diff vs previous Top10: NEW = not present previously
  const prev = new Set(await redis.smembers(SEEN_KEY));
  const currentKeys = rows.map((x) => normalize(x.title));
  const newSet = currentKeys.filter((k) => !prev.has(k));

  // If nothing new => do NOT send anything
  if (newSet.length === 0) {
    await redis.quit();
    return;
  }

  // mark rows
  const newKeysSet = new Set(newSet);
  const marked = rows.map((x) => ({ ...x, isNew: newKeysSet.has(normalize(x.title)) }));

  // 5) Save current Top10 as previous
  const pipeline = redis.pipeline();
  pipeline.del(SEEN_KEY);
  currentKeys.forEach((k) => pipeline.sadd(SEEN_KEY, k));
  await pipeline.exec();
  await redis.quit();

  // 6) Send newsroom layout
  const blocks = buildNewsroomBlocks(marked, newSet.length);
  await postToSlack(blocks, `Trending Now (GR) — ${newSet.length} NEW`);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await postToSlack(
      [{ type: "section", text: { type: "mrkdwn", text: `⚠️ *Google Trends Job Failed*\n\`${err.message}\`` } }],
      "Google Trends Job Failed"
    );
  } catch {}
  process.exit(1);
});
