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

if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");
if (!REDIS_URL) throw new Error("Missing REDIS_URL");

const parser = new Parser();
const SEEN_KEY = `gt:seen:${GEO}`;

const normalize = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

async function postToSlack(blocks, text = "Google Trends update") {
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

/* ============ FETCH GOOGLE TRENDS ============ */
async function fetchFeed() {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml,application/xml,text/xml,*/*;q=0.9"
    },
    redirect: "follow"
  });

  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`Google Trends RSS HTTP ${res.status} | ${xml.slice(0, 120)}`);
  }

  return parser.parseString(xml);
}

/* =============== SLACK BLOCKS ================ */
function buildBlocks(items, newCount, redisOk) {
  const now = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  const redisBadge = redisOk ? "✅ Redis OK" : "⚠️ Redis OFF (NEW μπορεί να μην είναι ακριβές)";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `🇬🇷 Google Trends (Top 10) — 🆕 ${newCount} NEW`, emoji: true }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⏱️ ${now}  |  ${redisBadge}` }]
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

/* =============== REDIS SAFE CONNECT =============== */
function createRedisClient() {
  const r = new Redis(REDIS_URL, {
    // cron-friendly: μην “κολλάει” σε retries/queue
    maxRetriesPerRequest: 1,
    connectTimeout: 8000,
    enableOfflineQueue: false,
    lazyConnect: true
  });

  r.on("error", (err) => console.log("[Redis error]", err?.message || err));
  return r;
}

async function tryConnectRedis(redis) {
  try {
    await redis.connect();
    // μικρό ping για να είμαστε σίγουροι ότι είναι usable
    await redis.ping();
    return true;
  } catch (e) {
    console.log("[Redis connect failed]", e?.message || e);
    try { await redis.quit(); } catch {}
    return false;
  }
}

/* =================== MAIN ==================== */
async function main() {
  // 1) Πάντα παίρνουμε RSS
  const feed = await fetchFeed();
  const items = (feed.items || []).slice(0, MAX_ITEMS).map((it) => ({
    title: it.title,
    link: it.link
  }));

  // 2) Προσπαθούμε Redis, αλλά ΔΕΝ αποτυγχάνουμε αν πέσει
  const redis = createRedisClient();
  const redisOk = await tryConnectRedis(redis);

  let seen = new Set();
  if (redisOk) {
    try {
      seen = new Set(await redis.smembers(SEEN_KEY));
    } catch (e) {
      console.log("[Redis smembers failed]", e?.message || e);
    }
  }

  // 3) Mark NEW (μόνο αν έχουμε seen state)
  const enriched = items.map((it) => {
    const key = normalize(it.title);
    return { ...it, key, isNew: redisOk ? !seen.has(key) : false };
  });

  const newCount = enriched.filter((x) => x.isNew).length;

  // 4) Αποθηκεύουμε seen μόνο αν Redis OK
  if (redisOk) {
    try {
      const pipeline = redis.pipeline();
      enriched.forEach((x) => pipeline.sadd(SEEN_KEY, x.key));
      await pipeline.exec();
    } catch (e) {
      console.log("[Redis write failed]", e?.message || e);
    } finally {
      try { await redis.quit(); } catch {}
    }
  }

  // 5) Στέλνουμε ΠΑΝΤΑ Top 10
  await postToSlack(
    buildBlocks(enriched, newCount, redisOk),
    `Google Trends (GR) Top 10 — ${newCount} NEW`
  );
}

/* ================== RUN ====================== */
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
