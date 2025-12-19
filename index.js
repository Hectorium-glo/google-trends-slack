import fetch from "node-fetch";
import Parser from "rss-parser";

/* ================== CONFIG (keep RSS baseline) ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 10);

const RSS_URL = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(GEO)}`;
const parser = new Parser();

/* ================== ENRICHMENT (SerpApi) ================== */
const SERPAPI_KEY = process.env.SERPAPI_KEY;
if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");

const SERPAPI_URL =
  `https://serpapi.com/search.json?engine=google_trends_trending_now` +
  `&geo=${encodeURIComponent(GEO)}` +
  `&hl=el` +
  `&api_key=${encodeURIComponent(SERPAPI_KEY)}`;

/* ================== HELPERS ================== */
const normalize = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

function exploreLink(q) {
  const url = `https://trends.google.com/trends/explore?geo=${GEO}&q=${encodeURIComponent(q)}`;
  return `<${url}|περισσότερα εδώ>`;
}

function startedTimestampFromMinutes(mins) {
  if (mins == null || Number.isNaN(Number(mins))) return "—";
  const msAgo = Number(mins) * 60 * 1000;
  const started = new Date(Date.now() - msAgo);

  return new Intl.DateTimeFormat("el-GR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Athens"
  }).format(started);
}

function formatVolume(v) {
  if (v == null) return "—";

  // Already formatted like "200K+"
  if (typeof v === "string" && /[KMB]\+?$/.test(v.trim())) return v.trim();

  // Handle "12,345"
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(v);

  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B+`;
  if (n >= 1_000_000)     return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000)         return `${Math.round(n / 1_000)}K+`;
  return `${n}`;
}

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

/* ================== 1) RSS baseline ================== */
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
  return (feed.items || []).slice(0, MAX_ITEMS).map((it) => ({
    title: String(it.title || "—")
  }));
}

/* ================== 2) SerpApi enrichment ================== */
async function fetchSerpApiTrendingNow() {
  const res = await fetch(SERPAPI_URL, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status} | ${text.slice(0, 140)}`);

  return JSON.parse(text);
}

function indexEnrichmentByTitle(serpJson) {
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

    const volumeRaw =
      it?.traffic ||
      it?.search_volume ||
      it?.formattedTraffic ||
      it?.searches ||
      null;

    const timeActiveMin = it?.time_active_minutes ?? null;

    const breakdown =
      (it?.related_queries || it?.queries || it?.breakdown || [])
        .map((q) => String(q?.query || q))
        .filter(Boolean)
        .slice(0, 3);

    map.set(normalize(title), {
      volume: formatVolume(volumeRaw),
      startedText: startedTimestampFromMinutes(timeActiveMin),
      breakdownLinks: (breakdown.length ? breakdown : [title])
        .slice(0, 3)
        .map(exploreLink)
        .join(", ")
    });
  }

  return map;
}

/* ================== Slack newsroom "table" (fields grid) ================== */
function buildBlocks(rows) {
  const now = new Intl.DateTimeFormat("el-GR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Athens"
  }).format(new Date());

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `🇬🇷 Trending Now (GR) — Top 10`, emoji: true }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now} • Αυτόματο update κάθε 30’` }]
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Trend*" },
        { type: "mrkdwn", text: "*Volume*" },
        { type: "mrkdwn", text: "*Started*" },
        { type: "mrkdwn", text: "*Breakdown*" }
      ]
    },
    { type: "divider" }
  ];

  rows.forEach((r, idx) => {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${idx + 1}. ${r.title}*` },
        { type: "mrkdwn", text: r.volume || "—" },
        { type: "mrkdwn", text: r.startedText || "—" },
        { type: "mrkdwn", text: r.breakdownLinks || "—" }
      ]
    });
  });

  return blocks;
}

/* ================== MAIN ================== */
async function main() {
  const rssTop = await fetchTrendingRssTopN();
  const serp = await fetchSerpApiTrendingNow();
  const enrichMap = indexEnrichmentByTitle(serp);

  const rows = rssTop.map((r) => {
    const e = enrichMap.get(normalize(r.title)) || {};
    return {
      title: r.title,
      volume: e.volume || "—",
      startedText: e.startedText || "—",
      breakdownLinks: e.breakdownLinks || exploreLink(r.title)
    };
  });

  await postToSlack(buildBlocks(rows), `Trending Now (GR) — Top 10`);
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
