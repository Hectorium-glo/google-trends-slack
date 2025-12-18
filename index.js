import fetch from "node-fetch";

/* ================== CONFIG ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const HL = process.env.HL || "el";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 20);

// Athens offset in minutes (same style as Google Trends params)
const TZ = -120;

// Try multiple variants (some return 404 depending on params / edge handling)
const REALTIME_URLS = [
  // safest: cat=0 (no category filter)
  `https://trends.google.com/trends/api/realtimetrends?hl=${encodeURIComponent(HL)}&tz=${TZ}&geo=${encodeURIComponent(GEO)}&cat=0&fi=0&fs=0&ri=300&rs=${MAX_ITEMS}&sort=0`,
  // sometimes works without fi/fs
  `https://trends.google.com/trends/api/realtimetrends?hl=${encodeURIComponent(HL)}&tz=${TZ}&geo=${encodeURIComponent(GEO)}&cat=0&ri=300&rs=${MAX_ITEMS}&sort=0`
];

const REFERER = `https://trends.google.com/trending?geo=${encodeURIComponent(GEO)}`;
const UA = "Mozilla/5.0";
/* ============================================ */

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

function formatStarted(tsSecondsOrMs) {
  if (!tsSecondsOrMs) return "—";
  const ms = tsSecondsOrMs > 10_000_000_000 ? tsSecondsOrMs : tsSecondsOrMs * 1000;
  return new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date(ms));
}

function exploreLink(q, geo) {
  const url = `https://trends.google.com/trends/explore?geo=${geo}&q=${encodeURIComponent(q)}`;
  return `<${url}|${q}>`;
}

async function fetchRealtimeTrends() {
  let last = "";

  for (const url of REALTIME_URLS) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "el-GR,el;q=0.9,en;q=0.8",
        "Referer": REFERER
      },
      redirect: "follow"
    });

    const text = await res.text();

    if (!res.ok) {
      last = `HTTP ${res.status} | ${text.slice(0, 140)}`;
      continue;
    }

    // Response starts with )]}'
    const cleaned = text.replace(/^\)\]\}'\s*\n?/, "");
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      last = `JSON parse failed | ${cleaned.slice(0, 140)}`;
    }
  }

  throw new Error(`RealtimeTrends failed. ${last}`);
}

function extractRows(json, maxItems, geo) {
  const stories = json?.storySummaries?.trendingStories || [];

  return stories.slice(0, maxItems).map((s) => {
    const title =
      s?.title?.query ||
      s?.title ||
      s?.entityNames?.[0] ||
      "—";

    const volume =
      s?.formattedTraffic ||
      s?.traffic ||
      "—";

    const started =
      s?.startTimeMillis ||
      s?.startTime ||
      s?.time ||
      null;

    const breakdownRaw =
      (s?.relatedQueries || [])
        .flatMap((rq) => rq?.queries || [])
        .map((q) => q?.query || q)
        .filter(Boolean)
        .slice(0, 3);

    const breakdownLinks = (breakdownRaw.length ? breakdownRaw : [title])
      .slice(0, 3)
      .map((q) => exploreLink(String(q), geo))
      .join(", ");

    return {
      title: String(title),
      volume: String(volume),
      started,
      breakdownLinks
    };
  });
}

function buildBlocks(rows, geo) {
  const now = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  const headerLine = `*Trend* | *Search volume* | *Started* | *Trend breakdown*`;
  const separator = "—".repeat(80);

  const lines = rows.map((r) =>
    `*${r.title}* | ${r.volume} | ${formatStarted(r.started)} | ${r.breakdownLinks}`
  );

  const textBlock = [headerLine, separator, ...lines].join("\n");

  return [
    { type: "header", text: { type: "plain_text", text: `🇬🇷 Google Trends — Active τώρα (${geo})`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `⏱️ ${now} (κάθε 5’)` }] },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: textBlock } }
  ];
}

async function main() {
  const json = await fetchRealtimeTrends();
  const rows = extractRows(json, MAX_ITEMS, GEO);
  await postToSlack(buildBlocks(rows, GEO), `Google Trends Active (${GEO})`);
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
