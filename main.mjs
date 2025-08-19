// main.mjs
import fs from "fs/promises";

/* ===== REQUIRED SECRETS =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
============================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

/* ===== TUNING ===== */
const DAYS_WINDOW = 7;              // posts from last N days
const MIN_VIEWS   = 50000;          // set your threshold (e.g., 1000 while testing)
const MAX_POSTS_PER_ACCOUNT = 30;   // safety cap

/* ===== Helpers ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtNum = (x) => (x ?? 0).toLocaleString("en-US");
const withinDays = (ms, days) => ms && (Date.now() - ms) <= days * 24 * 3600 * 1000;
const fmtUTC = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC" });

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* ---- Fetch HTML through jina.ai mirror (avoids consent/JS) ---- */
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

/* ---- Pull SIGI_STATE JSON if present ---- */
function extractSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/* ---- Get list of recent video IDs from a profile ---- */
function videoIdsFromProfile(html) {
  const state = extractSIGI(html);
  const ids = new Set();

  // Preferred: from SIGI ItemList
  const list = state?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list)) {
    for (const id of list) {
      ids.add(String(id));
      if (ids.size >= MAX_POSTS_PER_ACCOUNT) break;
    }
  }

  // Fallback: gather from ItemModule sorted by createTime
  if (ids.size === 0 && state?.ItemModule) {
    const items = Object.values(state.ItemModule);
    items.sort((a, b) => Number(b.createTime) - Number(a.createTime));
    for (const it of items) {
      if (!it?.id) continue;
      ids.add(String(it.id));
      if (ids.size >= MAX_POSTS_PER_ACCOUNT) break;
    }
  }

  // Last resort: regex scan
  if (ids.size === 0) {
    const re = /\/video\/(\d{8,})/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      ids.add(m[1]);
      if (ids.size >= MAX_POSTS_PER_ACCOUNT) break;
    }
  }

  return [...ids];
}

/* ---- Extract stats from a video page ---- */
function statsFromVideoHTML(html) {
  // Try SIGI_STATE first (most reliable)
  const state = extractSIGI(html);
  if (state?.ItemModule) {
    const items = Object.values(state.ItemModule);
    if (items.length) {
      const it = items[0];
      return {
        views: Number(it?.stats?.playCount || 0),
        likes: Number(it?.stats?.diggCount || 0),
        createMs: Number(it?.createTime || 0) * 1000
      };
    }
  }

  // Fallback: regex
  let views = 0, likes = 0, createMs = 0;
  let m = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
  if (m) views = Number(m[1]);

  m = html.match(/"diggCount"\s*:\s*"?(\d+)"?/);
  if (m) likes = Number(m[1]);

  m = html.match(/"createTime"\s*:\s*"?(\d+)"?/);
  if (m) createMs = Number(m[1]) * 1000;

  return { views, likes, createMs };
}

/* ---- Send message(s) to Discord ---- */
async function sendDiscord(text) {
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${BOT_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: c })
    });
    if (!res.ok) await res.text().catch(()=>{});
    await sleep(500);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let viral = [];

  for (const handle of handles) {
    try {
      const profileHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      const ids = videoIdsFromProfile(profileHTML);

      for (const id of ids) {
        const videoHTML = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${id}`);
        const { views, likes, createMs } = statsFromVideoHTML(videoHTML);

        if (withinDays(createMs, DAYS_WINDOW) && views >= MIN_VIEWS) {
          viral.push({
            handle,
            id,
            url: `https://www.tiktok.com/@${handle}/video/${id}`,
            accountUrl: `https://www.tiktok.com/@${handle}`,
            views,
            likes,
            createMs
          });
        }

        await sleep(600 + Math.random() * 400);
      }
    } catch {
      // skip silently per account to avoid noisy output
    }
  }

  // Sort by posted date (newest first)
  viral.sort((a, b) => b.createMs - a.createMs);

  let lines = [`**🔥 Viral posts in last ${DAYS_WINDOW} days (≥${fmtNum(MIN_VIEWS)} views)**`, ""];
  if (viral.length) {
    viral.forEach((p, i) => {
      lines.push(
        `${i + 1}. [Post Link](${p.url}) | [@${p.handle}](${p.accountUrl}) — **${fmtNum(p.views)} views**, ❤️ ${fmtNum(p.likes)}, 📅 ${fmtUTC(p.createMs)}`
      );
    });
  } else {
    lines.push(`No viral posts found in last ${DAYS_WINDOW} days.`);
  }

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
