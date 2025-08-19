// main.mjs
import fs from "fs/promises";

/* ====== REQUIRED SECRETS (set in GitHub → Settings → Secrets → Actions) ======
   DISCORD_BOT_TOKEN  — your Discord bot token
   DISCORD_CHANNEL_ID — the channel ID where the bot should post
============================================================================= */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const n = (x) => (x ?? 0).toLocaleString("en-US");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const daysAgo = (ms) => Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));

/* ---------- Read accounts (one username per line, no @) ---------- */
async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* ---------- Simple GET with real browser-like headers ---------- */
async function get(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "referer": "https://www.tiktok.com/"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ---------- Try to parse TikTok JSON from HTML ---------- */
function extractState(html) {
  // New (most common)
  let m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  // Old fallback (still appears sometimes)
  m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

/* ---------- Get the latest video ID(s) from a profile page ---------- */
function videoIdsFromProfile(html, state, handle) {
  const found = new Set();

  // 1) Try JSON state first (various shapes)
  try {
    // Old shape
    const listOld = state?.ItemList?.["user-post"]?.list || [];
    listOld.forEach(id => found.add(String(id)));
  } catch {}

  try {
    // Some UNIVERSAL variants keep video IDs in a flat list too
    const modules = state?.ItemModule || {};
    // sort by createTime desc and take first few
    const items = Object.values(modules)
      .map(x => ({ id: String(x.id), t: Number(x.createTime || 0) }))
      .filter(x => x.id);
    items.sort((a,b) => b.t - a.t);
    items.slice(0, 6).forEach(x => found.add(x.id));
  } catch {}

  // 2) Regex fallback from HTML (anchor hrefs)
  const rgx = /href="https:\/\/www\.tiktok\.com\/@[^/]+\/video\/(\d+)"/g;
  let m;
  while ((m = rgx.exec(html)) !== null) {
    found.add(m[1]);
    if (found.size >= 10) break;
  }

  return [...found];
}

/* ---------- Pull details for a single video (views + createTime) ---------- */
async function fetchVideoDetails(author, videoId) {
  const url = `https://www.tiktok.com/@${author}/video/${videoId}?lang=en`;
  const html = await get(url);

  const state = extractState(html);

  // Try to find itemStruct in JSON first
  let views = 0, createMs = 0;
  try {
    // UNIVERSAL style: nested under props.pageProps.itemInfo.itemStruct
    const item = state?.props?.pageProps?.itemInfo?.itemStruct;
    if (item?.stats?.playCount != null) views = Number(item.stats.playCount);
    if (item?.createTime != null) createMs = Number(item.createTime) * 1000;
  } catch {}

  // Old SIGI ItemModule fallback (sometimes present)
  try {
    if (!views || !createMs) {
      const any = state?.ItemModule ? Object.values(state.ItemModule) : [];
      const hit = any.find(x => String(x.id) === String(videoId));
      if (hit) {
        if (hit?.stats?.playCount != null) views = Number(hit.stats.playCount);
        if (hit?.createTime != null) createMs = Number(hit.createTime) * 1000;
      }
    }
  } catch {}

  // As a last resort, try scraping a meta tag with a naive regex (rarely needed)
  if (!views) {
    const m = html.match(/"playCount":\s*([0-9]+)/);
    if (m) views = Number(m[1]);
  }
  if (!createMs) {
    const m = html.match(/"createTime":\s*"?(\d+)"?/);
    if (m) createMs = Number(m[1]) * 1000;
  }

  return { url, author, id: videoId, views, createMs };
}

/* ---------- Send message to Discord via Bot HTTP API ---------- */
async function sendDiscord(text) {
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        "authorization": `Bot ${BOT_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: c })
    });
    if (!res.ok) {
      const t = await res.text().catch(()=> "");
      console.error("Discord post failed:", res.status, t);
    }
    await sleep(600);
  }
}

/* ===================== MAIN ===================== */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN secrets.");
    process.exit(1);
  }

  const handles = await readAccounts();

  let latestPerAccount = [];
  let debug = [];

  for (const h of handles) {
    try {
      const html = await get(`https://www.tiktok.com/@${h}?lang=en`);
      const state = extractState(html);
      const ids = videoIdsFromProfile(html, state, h);

      if (!ids.length) {
        debug.push(`@${h}: no video ids found`);
        continue;
      }

      // take FIRST id as the “latest” (page is ordered newest → oldest)
      const vid = ids[0];
      const details = await fetchVideoDetails(h, vid);
      latestPerAccount.push(details);

      // gentle delay between accounts
      await sleep(700 + Math.random()*500);
    } catch (e) {
      debug.push(`@${h}: ${e.message}`);
    }
  }

  // sort by views desc
  latestPerAccount.sort((a,b) => (b.views||0) - (a.views||0));

  let lines = ["**Latest post per account — sorted by views**", ""];
  if (latestPerAccount.length) {
    latestPerAccount.forEach((p, i) => {
      const when = p.createMs ? ` — posted ${daysAgo(p.createMs)} day(s) ago` : "";
      lines.push(`${i+1}. [Post Link](${p.url}) | @${p.author} — **${n(p.views)} views**${when}`);
    });
  } else {
    lines.push("No posts could be read.");
  }

  if (debug.length) {
    lines.push("", "_Debug:_", ...debug);
  }

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
