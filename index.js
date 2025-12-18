import fetch from "node-fetch";

/* ================== CONFIG ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const HL = process.env.HL || "el";

// Πόσα active να δείχνει (δεν είναι “Top 10”, είναι απλά ένα όριο για να μην ξεχειλώνει το Slack)
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 20);

// Athens tz offset used by Trends API (in minutes, like JS getTimezoneOffset)
const TZ = -120;

// Endpoint που χρησιμοποιεί το Trending now (active/realtime)
const REALTIME_TRENDS_URL =
  `https://trends.google.com/trends/api/realtimetrends?` +
  `hl=${encodeURIComponent(HL)}&tz=${TZ}&cat=all&fi=0&fs=0&geo=${encodeURIComponent(GEO)}` +
  `&ri=300&rs=${MAX_ITEMS}&sort=0`;
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
  const res = await fetch(REALTIME_TRENDS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    },
    redirect: "follow"
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`RealtimeTrends HTTP ${res.status} | ${text.slice(0, 140)}`);

  // Response starts with )]}'
  const cleaned = text.replace(/^\)\]\}'\s*\n?/, "");
  return JSON.parse(cleaned);
}

function extractActiveRows(json, maxItems, geo) {
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
      s?.startTime ||
      s?.startTimeMillis ||
      s?.time ||
      null;

    // breakdown (3 links max)
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

  const lines = rows.map((r) => {
    return `*${r.title}* | ${r.volume} | ${formatStarted(r.started)} | ${r.breakdownLinks}`;
  });

  const textBlock = [headerLine, separator, ...lines].join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🇬🇷 Google Trends — Active τώρα (${geo})`, emoji: true }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now} (κάθε 5’)` }]
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: textBlock }
    }
  ];
}

async function main() {
  const json = await fetchRealtimeTrends();
  const rows = extractActiveRows(json, MAX_ITEMS, GEO);
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
