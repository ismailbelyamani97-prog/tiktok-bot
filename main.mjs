// main.mjs
import fs from "fs/promises";

/* ===== REQUIRED SECRETS =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
============================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

/* ===== RULES ===== */
const DAYS_WINDOW = 7;               // last N days
const MIN_VIEWS   = 1000;           // threshold (set to 1000 for testing if you want)
const MAX_POSTS_PER_ACCOUNT = 30;    // how many recent posts per account to scan

/* ===== Helpers ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtNum = (x) => (x ?? 0).toLocaleString("en-US");
const withinDays = (ms, days) => ms && (Date.now() - ms) <= days * 24 * 3600 * 1000;
const fmtUTC = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC" });

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
    } catch {
      // keep scanning
    }
  }
  return null;
}

/* ---- Get list of recent video IDs from a profile ---- */
function videoIdsFromProfile(html) {
  const ids = new Set();

  const state = extractSIGI(html);
  const list = state?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list)) {
    for (const id of list) {
      ids.add(String(id));
      if (ids.size >= MAX_POSTS_PER_ACCOUNT) break;
    }
  }

  if (ids.size === 0 && state?.ItemModule) {
    const items = Object.values(state.ItemModule);
    items.sort((a, b) => Number(b.createTime) - Number(a.createTime));
    for (const it of items) {
      if (!it?.id) continue;
      ids.add(String(it.id));
      if (ids.size >= MAX_POSTS_PER_ACCOUNT) break;
    }
  }

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

/* ---- Extract stats from video page ---- */
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
        createMs: Number(it?.createTime || 0) * 1000
      };
    }
  }

  // 2) LD+JSON VideoObject
  const ld = extractLDJSONVideoObject(html);
  if (ld) {
    // date via uploadDate / datePublished / dateCreated
    const dateStr = ld.uploadDate || ld.datePublished || ld.dateCreated || "";
    const t = Date.parse(dateStr);
    const createMs = Number.isNaN(t) ? 0 : t;

    // views via WatchAction
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
    // likes sometimes appear as aggregateRating.ratingCount
    let likes = 0;
    if (ld.aggregateRating && typeof ld.aggregateRating.ratingCount !== "undefined") {
      likes = Number(ld.aggregateRating.ratingCount || 0);
    }
    return { views, likes, createMs };
  }

  // 3) Regex fallbacks (views, likes, createTime)
  let views = 0, likes = 0, createMs = 0;

  let m = html.match(/"playCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) views = parseAbbrev(m[1]);

  m = html.match(/"diggCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) likes = parseAbbrev(m[1]);

  // unix seconds
  m = html.match(/"createTime"\s*:\s*"?(\d+)"?/i);
  if (m) createMs = Number(m[1]) * 1000;

  // ISO strings
  if (!createMs) {
    m = html.match(/"(?:uploadDate|datePublished|dateCreated)"\s*:\s*"?([0-9T:\-+.Z]+)"?/i);
    if (m) {
      const tt = Date.parse(m[1]);
      if (!Number.isNaN(tt)) createMs = tt;
    }
  }

  // extremely last resort: look for "views": 12345
  if (!views) {
    m = html.match(/"views"\s*:\s*"?([\d,.KMB]+)"?/i);
    if (m) views = parseAbbrev(m[1]);
  }

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
        // try two URL forms through mirror (some pages differ)
        const htmlA = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${id}`);
        const statsA = statsFromVideoHTML(htmlA);

        let views = statsA.views, likes = statsA.likes, createMs = statsA.createMs;

        if ((!views || !createMs)) {
          const htmlB = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${id}?lang=en`);
          const statsB = statsFromVideoHTML(htmlB);
          views = views || statsB.views;
          likes = likes || statsB.likes;
          createMs = createMs || statsB.createMs;
        }

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
      // skip silently
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
