import fetch from "node-fetch";
import Parser from "rss-parser";

/* ================== CONFIG ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");

const GEO = process.env.GEO || "GR";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 20);

const RSS_URL = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(GEO)}`;
const parser = new Parser();
/* ============================================ */

async function postToSlack(blocks, text = "Google Trends Active") {
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

async function fetchTrendingRss() {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml,application/xml,text/xml,*/*;q=0.9"
    },
    redirect: "follow"
  });

  const xml = await res.text();
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} | ${xml.slice(0, 140)}`);

  // rss-parser supports parseString
  return parser.parseString(xml);
}

function buildBlocks(items) {
  const now = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  const lines = items.map((it, idx) => `• *${idx + 1}. ${it.title}*`);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🇬🇷 Google Trends — Active τώρα (${GEO})`, emoji: true }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now} (κάθε 5’)` }]
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") || "—" }
    }
  ];
}

async function main() {
  const feed = await fetchTrendingRss();
  const items = (feed.items || []).slice(0, MAX_ITEMS);

  await postToSlack(buildBlocks(items), `Google Trends Active (${GEO})`);
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
