import axios from "axios";
import fs from "fs/promises";

/* Defaults (override via workflow env if you want) */
const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const BOT = process.env.DISCORD_BOT_TOKEN;
const MIN_VIEWS = Number(process.env.MIN_VIEWS || 50);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);

const n = (x) => (x || 0).toLocaleString("en-US");
const nowMs = () => Date.now();
const ago = (now, tMs) => {
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400); if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600); if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60); if (m) return `${m} min(s) ago`;
  return "just now";
};

/* ----- helpers to fetch and parse TikTok HTML via relay ----- */
const H = {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
};

async function fetchHtml(url) {
  // Use r.jina.ai as a relay to fetch the HTML (works for TikTok pages)
  const relay = "https://r.jina.ai/http/";
  const finalUrl = relay + url.replace(/^https?:\/\//, "");
  const res = await axios.get(finalUrl, { headers: H.headers, timeout: 30000 });
  return res.data; // full HTML
}

function parseSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE".*?>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function itemsFromState(state) {
  const mod = state?.ItemModule || {};
  return Object.values(mod).map(v => ({
    id: v.id,
    author: v.author,
    createTime: Number(v.createTime) * 1000,
    stats: {
      playCount: Number(v.stats?.playCount || 0),
      diggCount: Number(v.stats?.diggCount || 0),
      commentCount: Number(v.stats?.commentCount || 0),
    }
  }));
}

async function fetchUserItems(handleRaw) {
  const handle = handleRaw.replace(/^@+/, "").trim();
  const url = `https://www.tiktok.com/@${handle}?lang=en`;
  try {
    const html = await fetchHtml(url);
    const state = parseSIGI(html);
    if (!state) throw new Error("no SIGI_STATE");
    const items = itemsFromState(state).map(v => ({
      ...v,
      url: `https://www.tiktok.com/@${handle}/video/${v.id}`
    }));
    return { items, error: null };
  } catch (e) {
    return { items: [], error: `failed to load @${handle}` };
  }
}

// Fallback: re-fetch each video page if counts look zero
async function refreshCounts(posts) {
  for (const p of posts) {
    if (p.stats.playCount > 0) continue;
    try {
      const html = await fetchHtml(p.url + "?lang=en");
      const state = parseSIGI(html);
      const again = itemsFromState(state)[0];
      if (again?.stats?.playCount != null) {
        p.stats.playCount = Number(again.stats.playCount);
        p.stats.diggCount = Number(again.stats.diggCount || 0);
        p.stats.commentCount = Number(again.stats.commentCount || 0);
      }
    } catch {}
  }
  return posts;
}

/* ----- Discord ----- */
async function sendDiscord(text) {
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    await axios.post(
      `https://discord.com/api/v10/channels/${CHANNEL}/messages`,
      { content: c },
      { headers: { Authorization: `Bot ${BOT}` } }
    );
  }
}

/* ================= MAIN ================= */
(async () => {
  const now = nowMs();
  const cutoff = now - LOOKBACK_HOURS * 3600 * 1000;

  const handles = (await fs.readFile("accounts.txt", "utf8"))
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^@+/, ""));

  let viral = [];
  let debug = [];

  for (const h of handles) {
    const { items, error } = await fetchUserItems(h);
    if (error) { debug.push(`@${h}: ${error}`); continue; }

    const recent = items.filter(v => v.createTime >= cutoff);
    await refreshCounts(recent); // fix zeros

    if (recent.length) {
      const top = [...recent].sort((a,b)=> b.stats.playCount - a.stats.playCount)[0];
      debug.push(`@${h}: ${recent.length} recent; top ${n(top.stats.playCount)} views`);
    } else {
      debug.push(`@${h}: 0 recent posts`);
    }

    const qualified = recent
      .filter(v => v.stats.playCount >= MIN_VIEWS)
      .map(v => ({ ...v, author: h }));

    viral.push(...qualified);
  }

  // group by handle
  const byHandle = new Map();
  viral.forEach(v => {
    if (!byHandle.has(v.author)) byHandle.set(v.author, []);
    byHandle.get(v.author).push(v);
  });
  for (const [h, arr] of byHandle.entries()) arr.sort((a,b)=> b.stats.playCount - a.stats.playCount);

  let out = [`Check Notification (last ${LOOKBACK_HOURS}H, ≥ ${n(MIN_VIEWS)} views)`];

  if (byHandle.size) {
    for (const [h, arr] of byHandle.entries()) {
      out.push(`@${h} → ${arr.length} post(s) ≥ ${n(MIN_VIEWS)} views`);
      for (const v of arr) {
        out.push(`${v.url} | ${n(v.stats.playCount)} views | ${n(v.stats.diggCount)} likes | ${n(v.stats.commentCount)} coms. | posted ${ago(now, v.createTime)}`);
      }
      out.push("");
    }
  } else {
    out.push(`No posts ≥ ${n(MIN_VIEWS)} views in the last ${LOOKBACK_HOURS}h.`);
    out.push("");
    out.push("Debug:");
    out.push(...debug);
  }

  await sendDiscord(out.join("\n"));
})();
