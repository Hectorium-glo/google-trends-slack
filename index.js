import Parser from "rss-parser";
import fetch from "node-fetch";
import Redis from "ioredis";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const REDIS_URL = process.env.REDIS_URL;

const GEO = process.env.GEO || "GR";
const HL = process.env.HL || "el";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 20);

const RSS_URLS = [
  `https://trends.google.com/trending/rss?geo=${GEO}&hl=${HL}`
];

if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL");
if (!REDIS_URL) throw new Error("Missing REDIS_URL");

const redis = new Redis(REDIS_URL);
const parser = new Parser();
const SEEN_KEY = `gt:seen:${GEO}`;

const normalize = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

async function postToSlack(blocks, text = "Google Trends update") {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks })
  });
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status}`);
}

async function fetchFeed() {
  let lastErr = "";
  for (const url of RSS_URLS) {
    try {
      const feed = await parser.parseURL(url);
      if (feed?.items?.length) return feed;
      lastErr = `Parsed but empty: ${url}`;
    } catch (e) {
      lastErr = `Fail ${url}: ${e?.message || e}`;
    }
  }
  throw new Error(`All RSS failed. ${lastErr}`);
}

function buildBlocks({ newCount, items }) {
  const nowGr = new Intl.DateTimeFormat("el-GR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Athens"
  }).format(new Date());

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `🇬🇷 Google Trends (GR) — 🆕 ${newCount} new`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `⏱️ ${nowGr} (ώρα Ελλάδας)` }] },
    { type: "divider" }
  ];

  for (const it of items) {
    const badge = it.isNew ? "🆕 *NEW*" : "•";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${badge} *${it.title}*\n<${it.link}|Άνοιγμα στο Google Trends>` }
    });
  }

  blocks.push({ type: "divider" });
  return blocks;
}

async function main() {
  const feed = await fetchFeed();
  const items = (feed.items || []).slice(0, MAX_ITEMS);

  const seen = new Set(await redis.smembers(SEEN_KEY));
  const enriched = items.map((it) => {
    const key = normalize(it.title);
    return { title: it.title, link: it.link, key, isNew: !seen.has(key) };
  });

  const newOnes = enriched.filter((x) => x.isNew);
  if (newOnes.length === 0) return;

  const pipeline = redis.pipeline();
  for (const x of enriched) pipeline.sadd(SEEN_KEY, x.key);
  await pipeline.exec();

  await postToSlack(buildBlocks({ newCount: newOnes.length, items: enriched }), `Google Trends (GR) — ${newOnes.length} new`);
}

main()
  .catch(async (e) => {
    try {
      await postToSlack([{ type: "section", text: { type: "mrkdwn", text: `⚠️ *Job failed*\n\`${String(e?.message || e)}\`` } }], "Google Trends job failed");
    } catch {}
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await redis.quit(); } catch {}
  });
