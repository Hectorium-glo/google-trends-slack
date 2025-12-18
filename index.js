import Parser from "rss-parser";
import fetch from "node-fetch";
import Redis from "ioredis";

/* ================== CONFIG ================== */
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const REDIS_URL = process.env.REDIS_URL;

const GEO = "GR";
const MAX_ITEMS = 10;

const RSS_URL = `https://trends.google.com/trending/rss?geo=${GEO}`;

/* ============================================ */

if (!SLACK_WEBHOOK_URL) {
  throw new Error("Missing SLACK_WEBHOOK_URL");
}
if (!REDIS_URL) {
  throw new Error("Missing REDIS_URL");
}

/* =============== REDIS ====================== */
// Cron-friendly Redis config
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 8000,
  enableOfflineQueue: false,
  lazyConnect: true
});

redis.on("error", (err) => {
  console.log("[Redis error]", err?.message || err);
});

/* ============================================ */

const parser = new Parser();
const SEEN_KEY = `gt:seen:${GEO}`;

const normalize = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ");

async function postToSlack(blocks) {
  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks })
  });
}

/* ============ FETCH GOOGLE TRENDS ============ */
async function fetchFeed() {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml,application/xml,text/xml,*/*;q=0.9"
    }
  });

  if (!res.ok) {
    throw new Error(`Google Trends RSS HTTP ${res.status}`);
  }

  const xml = await res.text();
  return parser.parseString(xml);
}

/* =============== SLACK BLOCKS ================ */
function buildBlocks(items, newCount) {
  const now = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🇬🇷 Google Trends (Top 10) — 🆕 ${newCount} new`,
        emoji: true
      }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now}` }]
    },
    { type: "divider" }
  ];

  items.forEach((it, idx) => {
    const badge = it.isNew ? "🆕 *NEW*" : "•";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${badge} *${idx + 1}. ${it.title}*\n<${it.link}|Άνοιγμα στο Google Trends>`
      }
    });
  });

  return blocks;
}

/* =================== MAIN ==================== */
async function main() {
  // 1. Connect to Redis
  await redis.connect();

  // 2. Fetch Google Trends
  const feed = await fetchFeed();
  const items = (feed.items || []).slice(0, MAX_ITEMS);

  // 3. Load seen items
  const seen = new Set(await redis.smembers(SEEN_KEY));

  // 4. Mark NEW
  const enriched = items.map((it) => {
    const key = normalize(it.title);
    return {
      title: it.title,
      link: it.link,
      key,
      isNew: !seen.has(key)
    };
  });

  const newCount = enriched.filter((x) => x.isNew).length;

  // 5. Save all current Top 10 as seen
  const pipeline = redis.pipeline();
  enriched.forEach((x) => pipeline.sadd(SEEN_KEY, x.key));
  await pipeline.exec();

  // 6. Send ALWAYS Top 10 to Slack
  await postToSlack(buildBlocks(enriched, newCount));

  // 7. Close Redis
  await redis.quit();
}

/* ================== RUN ====================== */
main().catch(async (err) => {
  console.error(err);
  try {
    await postToSlack([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ *Google Trends Job Failed*\n\`${err.message}\``
        }
      }
    ]);
  } catch {}
  process.exit(1);
});
