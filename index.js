import fetch from "node-fetch";
import Parser from "rss-parser";

/* ================== CONFIG ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 10);

// Active RSS (baseline)
const RSS_URL = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(GEO)}`;

// IMPORTANT: capture ht:news_item_url from RSS
const parser = new Parser({
  customFields: {
    item: ["ht:news_item_url"]
  }
});

// Enrichment (SerpApi) for Volume
const SERPAPI_KEY = process.env.SERPAPI_KEY;
if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");

const SERPAPI_URL =
  `https://serpapi.com/search.json?engine=google_trends_trending_now` +
  `&geo=${encodeURIComponent(GEO)}` +
  `&hl=el` +
  `&api_key=${encodeURIComponent(SERPAPI_KEY)}`;
/* ============================================ */

/* ================== HELPERS ================== */
function stripDiacritics(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

const normalize = (s) => stripDiacritics(s);

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len - 1) + "…" : s + " ".repeat(len - s.length);
}

// Format raw search volume to K+/M+/B+
// Heuristic: if 1..999, treat as thousands => "200" => "200K+"
function formatVolume(v) {
  if (v == null) return "—";

  if (typeof v === "string" && /[KMB]\+?$/.test(v.trim())) return v.trim();

  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(v);

  if (n >= 1 && n < 1000) return `${Math.round(n)}K+`;
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B+`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K+`;
  return `${n}`;
}

// Turn formatted volume into sortable number (rough estimate)
function volumeToNumber(vFormattedOrRaw) {
  if (vFormattedOrRaw == null) return 0;

  const s = String(vFormattedOrRaw).trim();

  // "200K+"
  const m = s.match(/^(\d+(?:\.\d+)?)([KMB])\+?$/i);
  if (m) {
    const val = Number(m[1]);
    const unit = m[2].toUpperCase();
    if (!Number.isFinite(val)) return 0;
    if (unit === "K") return val * 1_000;
    if (unit === "M") return val * 1_000_000;
    if (unit === "B") return val * 1_000_000_000;
  }

  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;

  // same heuristic: 200 => 200K
  if (n >= 1 && n < 1000) return n * 1000;
  return n;
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

/* ================== RSS baseline (Active) ================== */
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

  return (feed.items || []).slice(0, MAX_ITEMS).map((it) => {
    const raw = it["ht:news_item_url"];
    const newsUrls = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const firstNewsUrl = newsUrls[0] || null;

    return {
      title: String(it.title || "—"),
      sampleUrl: firstNewsUrl
    };
  });
}

/* ================== SerpApi enrichment (Volume only) ================== */
async function fetchSerpApiTrendingNow() {
  const res = await fetch(SERPAPI_URL, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status} | ${text.slice(0, 140)}`);

  return JSON.parse(text);
}

function indexVolumeByTitle(serpJson) {
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

    const volFormatted = formatVolume(volumeRaw);

    map.set(normalize(title), {
      volume: volFormatted,
      volumeNum: volumeToNumber(volFormatted)
    });
  }

  return map;
}

/* ================== Slack blocks (table + sample urls) ================== */
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

  // table widths
  const W_POS = 3;   // so 10 fits
  const W_TREND = 24;
  const W_VOL = 7;

  const header =
    pad("#", W_POS) + " | " +
    pad("Trend", W_TREND) + " | " +
    pad("Volume", W_VOL);

  const sep = "-".repeat(header.length);

  const lines = rows.map((r, i) => (
    pad(i + 1, W_POS) + " | " +
    pad(r.title, W_TREND) + " | " +
    pad(r.volume || "—", W_VOL)
  ));

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🇬🇷 Trending Now (GR) — Active", emoji: true }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now} • update κάθε 30’` }]
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + [header, sep, ...lines].join("\n") + "```" }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: rows
          .map((r, i) => (r.sampleUrl ? `*${i + 1}.* <${r.sampleUrl}|Sample URL>` : `*${i + 1}.* —`))
          .join("\n")
      }
    }
  ];
}

/* ================== MAIN ================== */
async function main() {
  const rssTop = await fetchTrendingRssTopN();
  const serp = await fetchSerpApiTrendingNow();
  const volMap = indexVolumeByTitle(serp);

  // merge
  let rows = rssTop.map((r) => {
    const v = volMap.get(normalize(r.title)) || {};
    return {
      title: r.title,
      sampleUrl: r.sampleUrl,
      volume: v.volume || "—",
      volumeNum: v.volumeNum || 0
    };
  });

  // sort by search volume desc (approx)
  rows.sort((a, b) => (b.volumeNum || 0) - (a.volumeNum || 0));
  rows = rows.slice(0, MAX_ITEMS);

  await postToSlack(buildBlocks(rows), `Trending Now (GR) — Active`);
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
