// main.mjs
import fs from "fs/promises";

/* ===== REQUIRED SECRETS =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
============================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

/* ===== Helpers ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtNum = (x) => (x ?? 0).toLocaleString("en-US");

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* ---- Fetch HTML via jina.ai mirror (avoids consent/JS) ---- */
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

/* ---- JSON extractors ---- */
function extractSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractLDJSONVideoObject(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b[1]);
      const arr = Array.isArray(j) ? j : [j];
      for (const obj of arr) {
        const t = obj?.["@type"] || obj?.type;
        if (t && /VideoObject/i.test(t)) return obj;
      }
    } catch {/* keep scanning */}
  }
  return null;
}

/* ---- Get the MOST RECENT video ID from a profile ---- */
function latestVideoIdFromProfile(html) {
  // Prefer SIGI ItemList order (newest first)
  const state = extractSIGI(html);
  const list = state?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list) && list.length) return String(list[0]);

  // Fallback: newest by createTime in ItemModule
  if (state?.ItemModule) {
    const items = Object.values(state.ItemModule);
    if (items.length) {
      items.sort((a, b) => Number(b.createTime) - Number(a.createTime));
      if (items[0]?.id) return String(items[0].id);
    }
  }

  // Final fallback: regex scan and take first occurrence
  const m = html.match(/\/video\/(\d{8,})/);
  return m ? m[1] : null;
}

/* ---- Abbrev number parser (e.g., "2.1K", "3.4M") ---- */
function parseAbbrev(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^([\d,.]+)\s*([KMB])?$/i);
  if (!m) return Number(str) || 0;
  let num = Number(m[1].replace(/,/g, ""));
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") num *= 1e3;
  if (suf === "M") num *= 1e6;
  if (suf === "B") num *= 1e9;
  return Math.round(num);
}

/* ---- Extract views + likes from a video page ---- */
function statsFromVideoHTML(html) {
  // 1) SIGI_STATE
  const sigi = extractSIGI(html);
  if (sigi?.ItemModule) {
    const items = Object.values(sigi.ItemModule);
    if (items.length) {
      const it = items[0];
      return {
        views: Number(it?.stats?.playCount || 0),
        likes: Number(it?.stats?.diggCount || 0),
      };
    }
  }

  // 2) LD+JSON VideoObject
  const ld = extractLDJSONVideoObject(html);
  if (ld) {
    // Views via WatchAction
    let views = 0;
    if (Array.isArray(ld.interactionStatistic)) {
      for (const s of ld.interactionStatistic) {
        const typ = s?.interactionType?.["@type"] || s?.interactionType;
        if (typ && /WatchAction/i.test(typ)) {
          views = Number(s?.userInteractionCount || 0);
          break;
        }
      }
    }
    // Likes sometimes as aggregateRating.ratingCount
    let likes = 0;
    if (ld.aggregateRating && typeof ld.aggregateRating.ratingCount !== "undefined") {
      likes = Number(ld.aggregateRating.ratingCount || 0);
    }
    return { views, likes };
  }

  // 3) Regex fallbacks
  let views = 0, likes = 0;

  let m = html.match(/"playCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) views = parseAbbrev(m[1]);

  m = html.match(/"diggCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) likes = parseAbbrev(m[1]);

  if (!views) {
    m = html.match(/"views"\s*:\s*"?([\d,.KMB]+)"?/i);
    if (m) views = parseAbbrev(m[1]);
  }

  return { views, likes };
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
    await sleep(400);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let rows = [];

  for (const handle of handles) {
    try {
      // 1) profile → latest video id
      const profileHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      const videoId = latestVideoIdFromProfile(profileHTML);
      if (!videoId) {
        rows.push(`• @${handle} — (no recent post found)`);
        continue;
      }

      // 2) video page → stats
      // try two variants; some mirrors expose different blocks
      let html = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${videoId}`);
      let { views, likes } = statsFromVideoHTML(html);

      if (!views && !likes) {
        html = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${videoId}?lang=en`);
        const alt = statsFromVideoHTML(html);
        views = views || alt.views;
        likes = likes || alt.likes;
      }

      rows.push(
        `• [@${handle}](https://www.tiktok.com/@${handle}) — ` +
        `**${fmtNum(views)} views**, ❤️ ${fmtNum(likes)} — ` +
        `[Post link](https://www.tiktok.com/@${handle}/video/${videoId})`
      );

      await sleep(600 + Math.random() * 400);
    } catch {
      rows.push(`• @${handle} — (could not read)`);
    }
  }

  const header = "**Latest post per account — views & likes**\n";
  await sendDiscord(header + rows.join("\n"));
  console.log("✅ Done");
})();
