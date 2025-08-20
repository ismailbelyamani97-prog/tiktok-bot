// main.mjs — viral posts (last 7 days) with green bar + no embeds
// Secrets needed: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID
// Input file: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

// === Rules you can tweak ===
const DAYS_WINDOW = 7;          // last N days
const MIN_VIEWS   = 100;      // threshold
const MAX_IDS_PER_PROFILE = 20; // how many recent ids to scan per account

// ---- helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (x) => (x ?? 0).toLocaleString("en-US");
const ago = (now, tMs) => {
  if (!tMs) return "";
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400); if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600); if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60); if (m) return `${m} min(s) ago`;
  return "just now";
};

async function readHandles() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

async function sendDiscord(text) {
  // flags: 4 => SUPPRESS_EMBEDS (no huge previews)
  // leading ">>>" makes the whole message a multi-line blockquote (green bar)
  const content = `>>> ${text}`;
  const chunks = content.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: c, flags: 4 })
    });
    await sleep(250);
  }
}

async function fetchMirror(url) {
  // read-only HTML mirror to avoid consent/JS
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

function parseSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function recentIdsFromProfileHTML(html, max = MAX_IDS_PER_PROFILE) {
  const ids = new Set();

  // best: SIGI ItemList
  const sigi = parseSIGI(html);
  const list = sigi?.ItemList?.["user-post"]?.list;
  if (Array.isArray(list)) {
    for (const id of list) {
      ids.add(String(id));
      if (ids.size >= max) break;
    }
  }

  // fallback: scan links
  if (ids.size < max) {
    const re = /\/video\/(\d{8,})/g;
    let m;
    while (ids.size < max && (m = re.exec(html))) ids.add(m[1]);
  }
  return [...ids];
}

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

function statsFromVideoHTML(html) {
  // 1) SIGI (most reliable)
  const sigi = parseSIGI(html);
  if (sigi?.ItemModule) {
    const it = Object.values(sigi.ItemModule)[0];
    const st = it?.stats || {};
    const views = Number(
      st.playCount ?? st.viewCount ?? st.play_count ?? st.view_count ?? 0
    );
    const likes = Number(
      st.diggCount ?? st.digg_count ?? st.likeCount ?? 0
    );
    const comments = Number(
      st.commentCount ?? st.comment_count ?? 0
    );
    const createMs = Number(it?.createTime ? it.createTime * 1000 : 0);
    return { views, likes, comments, createMs, src: "SIGI" };
  }

  // 2) regex fallbacks (videos & slideshows)
  let views = 0, likes = 0, comments = 0, createMs = 0;

  let m = html.match(/"createTime"\s*:\s*"?(\d{10,13})"?/i);
  if (m) {
    const v = Number(m[1]);
    createMs = v > 2_000_000_000 ? v : v * 1000;
  }

  const viewPatterns = [
    /"playCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"viewCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"play_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"view_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"views"\s*:\s*"?([\d.,KMB]+)"?/i,
    /([\d.,KMB]+)\s*(views|plays)/i,
  ];
  for (const re of viewPatterns) { const mm = html.match(re); if (mm) { views = parseAbbrev(mm[1]); break; } }

  const likePatterns = [
    /"diggCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"digg_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"likeCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /([\d.,KMB]+)\s*likes?/i,
  ];
  for (const re of likePatterns) { const mm = html.match(re); if (mm) { likes = parseAbbrev(mm[1]); break; } }

  const commentPatterns = [
    /"commentCount"\s*:\s*"?([\d.,KMB]+)"?/i,
    /"comment_count"\s*:\s*"?([\d.,KMB]+)"?/i,
    /([\d.,KMB]+)\s*comms?/i,
    /([\d.,KMB]+)\s*comments?/i,
  ];
  for (const re of commentPatterns) { const mm = html.match(re); if (mm) { comments = parseAbbrev(mm[1]); break; } }

  return { views, likes, comments, createMs, src: "REGEX" };
}

function withinDays(ms, days) {
  return ms >= (Date.now() - days * 24 * 3600 * 1000);
}

(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  const handles = await readHandles();
  const now = Date.now();
  let posts = [];
  let debug = [];

  for (const handle of handles) {
    try {
      // 1) get recent ids from profile
      let ids = [];
      for (const base of [
        `https://www.tiktok.com/@${handle}`,
        `https://www.tiktok.com/@${handle}?lang=en`,
        `https://m.tiktok.com/@${handle}`,
        `https://us.tiktok.com/@${handle}`
      ]) {
        try {
          const html = await fetchMirror(base);
          ids = recentIdsFromProfileHTML(html, MAX_IDS_PER_PROFILE);
          if (ids.length) break;
        } catch {}
        await sleep(150);
      }
      if (!ids.length) {
        debug.push(`@${handle}: no ids`);
        continue;
      }

      // 2) read each post’s stats (stop early if many)
      for (const id of ids) {
        let stats = null;
        for (const v of [
          `https://www.tiktok.com/@${handle}/video/${id}`,
          `https://www.tiktok.com/@${handle}/video/${id}?lang=en`,
        ]) {
          try {
            const html = await fetchMirror(v);
            stats = statsFromVideoHTML(html);
            if (stats && (stats.views || stats.likes || stats.comments)) break;
          } catch {}
          await sleep(150);
        }
        if (!stats) continue;

        if (withinDays(stats.createMs, DAYS_WINDOW) && stats.views >= MIN_VIEWS) {
          posts.push({
            handle,
            id,
            url: `https://www.tiktok.com/@${handle}/video/${id}`,
            views: stats.views,
            likes: stats.likes,
            comments: stats.comments,
            createMs: stats.createMs
          });
        }
      }
    } catch (e) {
      debug.push(`@${handle}: ${e.message || e}`);
    }
    await sleep(300);
  }

  // sort by posted date (newest first)
  posts.sort((a,b)=> b.createMs - a.createMs);

  const header = `**Check Notification (last ${DAYS_WINDOW}D)**\n`;
  const lines = [header];

  if (posts.length === 0) {
    lines.push(`No posts ≥ ${n(MIN_VIEWS)} views in the last ${DAYS_WINDOW} day(s).`);
  } else {
    posts.forEach((p,i) => {
      lines.push(
        `${i+1}. Post gained ${n(p.views)} views\n` +
        `[Post Link](${p.url}) | [@${p.handle}](https://www.tiktok.com/@${p.handle}) | ` +
        `${n(p.views)} views | ${n(p.likes)} likes | ${n(p.comments)} coms.\n` +
        `posted ${ago(now, p.createMs)}\n`
      );
    });
  }

  // If you *don’t* want any debug line, comment this out:
  // if (debug.length) lines.push("\n_Debug:_\n" + debug.join("\n"));

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
