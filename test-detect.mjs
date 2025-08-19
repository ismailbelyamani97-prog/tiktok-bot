// test-detect.mjs
// Diagnostic runner: for each handle, fetch the latest post and report
// exactly WHICH source (SIGI / LD-JSON / REGEX) produced views/likes,
// plus short “sniff” fragments to show what the page contains.

import fs from "fs/promises";

/* ===== REQUIRED SECRETS (same as your main script) =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
======================================================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

/* ===== CONFIG ===== */
const MAX_HANDLES = 12;      // how many accounts to test per run
const DELAY_MS    = 700;     // polite delay between requests

/* ===== Helpers ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (x) => (x ?? 0).toLocaleString("en-US");

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

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

/* ---------- JSON extractors ---------- */
function extractSIGIObj(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function extractLDVideo(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b[1]);
      const arr = Array.isArray(j) ? j : [j];
      for (const obj of arr) {
        const t = obj?.["@type"] || obj?.type;
        if (t && /VideoObject/i.test(t)) return obj;
      }
    } catch {}
  }
  return null;
}

/* ---------- latest video id from profile ---------- */
function latestVideoIdFromProfile(html) {
  const sigi = extractSIGIObj(html);
  const list = sigi?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list) && list.length) return String(list[0]);

  if (sigi?.ItemModule) {
    const items = Object.values(sigi.ItemModule);
    if (items.length) {
      items.sort((a, b) => Number(b.createTime) - Number(a.createTime));
      if (items[0]?.id) return String(items[0].id);
    }
  }

  // absolute or relative link
  let m = html.match(/href="(?:https?:\/\/www\.tiktok\.com)?\/@[^/]+\/video\/(\d{8,})"/);
  if (m) return m[1];

  m = html.match(/\/video\/(\d{8,})/);
  return m ? m[1] : null;
}

/* ---------- abbrev parser ---------- */
function parseAbbrev(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^([\d,.]+)\s*([KMB])?$/i);
  if (!m) return Number(String(str).replace(/,/g, "")) || 0;
  let num = Number(m[1].replace(/,/g, ""));
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") num *= 1e3;
  if (suf === "M") num *= 1e6;
  if (suf === "B") num *= 1e9;
  return Math.round(num);
}

/* ---------- sniff helpers to show what the page contains ---------- */
function sniffRegexes(html) {
  const hits = [];
  const tests = [
    [/\"playCount\"\s*:\s*\"?([\d,.KMB]+)\"?/i, "playCount"],
    [/\"diggCount\"\s*:\s*\"?([\d,.KMB]+)\"?/i, "diggCount"],
    [/([\d,.KMB]+)\s*(views|plays)/i, "text_views"],
    [/([\d,.KMB]+)\s*likes?/i, "text_likes"],
    [/\"views\"\s*:\s*\"?([\d,.KMB]+)\"?/i, "views_key"],
  ];
  for (const [re, label] of tests) {
    const m = html.match(re);
    if (m) hits.push(`${label}: "${m[0].slice(0,80)}"`);
  }
  return hits;
}

/* ---------- extract stats & record which source hit ---------- */
function statsFromVideoHTML(html) {
  let source = [];

  // 1) SIGI_STATE
  const sigi = extractSIGIObj(html);
  if (sigi?.ItemModule) {
    const items = Object.values(sigi.ItemModule);
    if (items.length) {
      const it = items[0];
      source.push("SIGI");
      return {
        views: Number(it?.stats?.playCount || 0),
        likes: Number(it?.stats?.diggCount || 0),
        source
      };
    }
  }

  // 2) LD JSON (VideoObject)
  const ld = extractLDVideo(html);
  if (ld) {
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
    let likes = 0;
    if (ld.aggregateRating && typeof ld.aggregateRating.ratingCount !== "undefined") {
      likes = Number(ld.aggregateRating.ratingCount || 0);
    }
    source.push("LD");
    return { views, likes, source };
  }

  // 3) REGEX fallbacks
  let views = 0, likes = 0;
  let m = html.match(/"playCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) views = parseAbbrev(m[1]);

  m = html.match(/"diggCount"\s*:\s*"?([\d,.KMB]+)"?/i);
  if (m) likes = parseAbbrev(m[1]);

  if (!views) {
    m = html.match(/([\d,.KMB]+)\s*(views|plays)/i);
    if (m) views = parseAbbrev(m[1]);
  }
  if (!likes) {
    m = html.match(/([\d,.KMB]+)\s*likes?/i);
    if (m) likes = parseAbbrev(m[1]);
  }
  if (!views) {
    m = html.match(/"views"\s*:\s*"?([\d,.KMB]+)"?/i);
    if (m) views = parseAbbrev(m[1]);
  }
  source.push("REGEX");
  return { views, likes, source };
}

/* ---------- Discord ---------- */
async function sendDiscord(text) {
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ content: c })
    });
    await sleep(350);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = (await readAccounts()).slice(0, MAX_HANDLES);
  let out = ["**🔎 TikTok view/like detection — latest post per account**", ""];

  for (const handle of handles) {
    try {
      // Profile → latest post id (2 attempts)
      const profA = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      let vid = latestVideoIdFromProfile(profA);
      if (!vid) {
        const profB = await fetchMirror(`https://www.tiktok.com/@${handle}?lang=en`);
        vid = latestVideoIdFromProfile(profB);
      }
      if (!vid) {
        out.push(`• @${handle} — no video id found on profile`);
        continue;
      }

      const urlA = `https://www.tiktok.com/@${handle}/video/${vid}`;
      const urlB = `${urlA}?lang=en`;

      // Video → stats (try two variants)
      let html = await fetchMirror(urlA);
      let { views, likes, source } = statsFromVideoHTML(html);
      const sniffA = sniffRegexes(html);

      if (!views && !likes) {
        const htmlB = await fetchMirror(urlB);
        const s2 = statsFromVideoHTML(htmlB);
        const sniffB = sniffRegexes(htmlB);
        views = views || s2.views;
        likes = likes || s2.likes;
        source = s2.source?.length ? s2.source : source;

        out.push(
          `• [@${handle}](https://www.tiktok.com/@${handle}) — ` +
          `views: **${fmt(views)}**, likes: **${fmt(likes)}** — ` +
          `[post](${urlA}) — source: ${source.join("+")}` +
          `${sniffA?.length ? `\n  sniffA: ${sniffA.join(" | ")}` : ""}` +
          `${sniffB?.length ? `\n  sniffB: ${sniffB.join(" | ")}` : ""}`
        );
      } else {
        out.push(
          `• [@${handle}](https://www.tiktok.com/@${handle}) — ` +
          `views: **${fmt(views)}**, likes: **${fmt(likes)}** — ` +
          `[post](${urlA}) — source: ${source.join("+")}` +
          `${sniffA?.length ? `\n  sniff: ${sniffA.join(" | ")}` : ""}`
        );
      }

      await sleep(DELAY_MS + Math.random() * 300);
    } catch (e) {
      out.push(`• @${handle} — error: ${e.message || e}`);
    }
  }

  await sendDiscord(out.join("\n"));
  console.log("✅ Diagnostics sent to Discord.");
})();
