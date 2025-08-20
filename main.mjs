// main.mjs — GitHub Actions friendly, NO headless browser
// Reads views & likes reliably (video + slideshow) using a read-only mirror.
// Expects repo secrets: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID
// Uses accounts.txt (one handle per line, without @)

import fs from "fs/promises";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const MAX_IDS_PER_PROFILE = 12;   // how many recent post IDs to scan (we use the newest only here)
const PROFILE_VARIANTS = [
  (h) => `https://www.tiktok.com/@${h}`,
  (h) => `https://www.tiktok.com/@${h}?lang=en`,
  (h) => `https://m.tiktok.com/@${h}`,
  (h) => `https://us.tiktok.com/@${h}`,
];
const VIDEO_VARIANTS = [
  (h, id) => `https://www.tiktok.com/@${h}/video/${id}`,
  (h, id) => `https://www.tiktok.com/@${h}/video/${id}?lang=en`,
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (x) => (x ?? 0).toLocaleString("en-US");

/* ---------- basic IO ---------- */
async function readHandles() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

async function sendDiscord(text) {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN");
    return;
  }
  const parts = text.match(/[\s\S]{1,1800}/g) || [];
  for (const p of parts) {
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ content: p })
    });
    await sleep(250);
  }
}

/* ---------- mirror fetch (bypasses JS/consent walls) ---------- */
async function fetchMirror(url) {
  const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(proxied, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
  return res.text();
}

/* ---------- parsers ---------- */
function parseSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** collect recent post IDs from a profile page HTML */
function recentIdsFromProfileHTML(html, max = MAX_IDS_PER_PROFILE) {
  const ids = new Set();

  // 1) SIGI list (best)
  const sigi = parseSIGI(html);
  const list = sigi?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list)) {
    for (const id of list) {
      ids.add(String(id));
      if (ids.size >= max) break;
    }
  }

  // 2) Fallback: any /video/<id> link in the HTML
  if (ids.size < max) {
    const re = /\/video\/(\d{8,})/g;
    let m;
    while (ids.size < max && (m = re.exec(html))) ids.add(m[1]);
  }

  return [...ids];
}

/** normalize abbreviated numbers like 3.4K, 2M */
function parseAbbrev(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!m) return Number(String(str).replace(/,/g, "")) || 0;
  let num = Number(m[1].replace(/,/g, ""));
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") num *= 1e3;
  if (suf === "M") num *= 1e6;
  if (suf === "B") num *= 1e9;
  return Math.round(num);
}

/** get views/likes/createTime from a video (or slideshow) HTML */
function statsFromVideoHTML(html) {
  // 1) SIGI (best and most reliable)
  const sigi = parseSIGI(html);
  if (sigi?.ItemModule) {
    const it = Object.values(sigi.ItemModule)[0];
    const stats = it?.stats || {};
    const views =
      Number(stats.playCount ?? stats.viewCount ?? stats.play_count ?? stats.view_count ?? 0);
    const likes =
      Number(stats.diggCount ?? stats.digg_count ?? stats.likeCount ?? 0);
    const createMs = Number(it?.createTime ? it.createTime * 1000 : 0);
    return { views, likes, createMs, src: "SIGI" };
  }

  // 2) LD/regex fallbacks
  let views = 0, likes = 0, createMs = 0;

  // createTime (seconds or ms)
  let m = html.match(/"createTime"\s*:\s*"?(\d{10,13})"?/i);
  if (m) {
    const v = Number(m[1]);
    createMs = v > 2_000_000_000 ? v : v * 1000;
  }

  // views candidates
  const viewPatterns = [
    /"playCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"viewCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"play_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"view_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"views"\s*:\s*"?([\d.,KMB]+)"?/i,
    /([\d.,KMB]+)\s*(views|plays)/i,
  ];
  for (const re of viewPatterns) {
    const mm = html.match(re);
    if (mm) { views = parseAbbrev(mm[1]); break; }
  }

  // likes candidates
  const likePatterns = [
    /"diggCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"digg_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"likeCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /([\d.,KMB]+)\s*likes?/i,
  ];
  for (const re of likePatterns) {
    const mm = html.match(re);
    if (mm) { likes = parseAbbrev(mm[1]); break; }
  }

  return { views, likes, createMs, src: "REGEX" };
}

/* ---------- main workflow ---------- */
(async () => {
  const handles = await readHandles();
  const lines = ["**Latest post per account — views & likes**", ""];

  for (const handle of handles) {
    try {
      // fetch a profile variant that yields IDs
      let ids = [];
      for (const build of PROFILE_VARIANTS) {
        const url = build(handle);
        const html = await fetchMirror(url);
        ids = recentIdsFromProfileHTML(html, MAX_IDS_PER_PROFILE);
        if (ids.length) break;
        await sleep(200);
      }
      if (!ids.length) {
        lines.push(`• @${handle} — *(no recent post found)*`);
        continue;
      }

      const newestId = ids[0];
      let stats = { views: 0, likes: 0, createMs: 0, src: "N/A" };

      // try two video URL variants to be safe
      for (const v of VIDEO_VARIANTS) {
        const url = v(handle, newestId);
        const html = await fetchMirror(url);
        const s = statsFromVideoHTML(html);
        // take first non-zero result; otherwise keep last
        if ((s.views || s.likes) && !stats.views && !stats.likes) stats = s;
        else if (!stats.views && !stats.likes) stats = s;
        await sleep(200);
      }

      const postUrl = `https://www.tiktok.com/@${handle}/video/${newestId}`;
      lines.push(
        `• [@${handle}](https://www.tiktok.com/@${handle}) — **${n(stats.views)} views**, ❤️ ${n(stats.likes)} — [Post link](${postUrl})`
      );
      await sleep(500 + Math.random() * 300);
    } catch (e) {
      lines.push(`• @${handle} — error: ${e.message || e}`);
    }
  }

  await sendDiscord(lines.join("\n"));
  console.log("✅ Sent.");
})();
