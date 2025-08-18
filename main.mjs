import { chromium } from "playwright";
import axios from "axios";
import fs from "fs/promises";

const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const BOT = process.env.DISCORD_BOT_TOKEN;

// Defaults are 50 views over the last 48 hours.
// You can still override via env if you want.
const MIN_VIEWS = Number(process.env.MIN_VIEWS || 50);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);

const n = (x) => (x || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ago = (now, tMs) => {
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400); if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600); if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60); if (m) return `${m} min(s) ago`;
  return "just now";
};

function parseFromSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE".*?>([\s\S]*?)<\/script>/);
  if (!m) return null;
  return JSON.parse(m[1]);
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

async function fetchUserItems(browser, handle) {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    locale: "en-US"
  });

  // Block images to speed up
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  const url = `https://www.tiktok.com/@${handle}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Cookie popup (ignore if not there)
    await page.locator('button:has-text("Accept all")').click({ timeout: 3000 }).catch(()=>{});

    // Wait for TikTok’s JSON blob
    await page.waitForSelector('script#SIGI_STATE', { timeout: 15000 });

    const html = await page.content();
    const state = parseFromSIGI(html);
    const items = itemsFromState(state).map(v => ({
      ...v,
      url: `https://www.tiktok.com/@${handle}/video/${v.id}`
    }));
    await ctx.close();
    return { items, error: null };
  } catch (e) {
    await ctx.close();
    return { items: [], error: `failed to load @${handle}` };
  }
}

// Fallback: open each video page to refresh counts if profile JSON was stale
async function refreshCountsForRecent(browser, posts) {
  for (const p of posts) {
    // If we already have a non-zero count, skip
    if (p.stats?.playCount > 0) continue;

    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "en-US"
    });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) return route.abort();
      return route.continue();
    });

    const page = await ctx.newPage();
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector('script#SIGI_STATE', { timeout: 15000 });
      const html = await page.content();
      const state = parseFromSIGI(html);
      const again = itemsFromState(state)[0];
      if (again?.stats?.playCount != null) {
        p.stats.playCount = Number(again.stats.playCount);
        p.stats.diggCount = Number(again.stats.diggCount || 0);
        p.stats.commentCount = Number(again.stats.commentCount || 0);
      }
    } catch(_) {}
    await ctx.close();
  }
  return posts;
}

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

(async () => {
  const now = Date.now();
  const cutoff = now - LOOKBACK_HOURS * 3600 * 1000;

  const browser = await chromium.launch({ headless: true });
  const handles = (await fs.readFile("accounts.txt", "utf8"))
                    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  let viral = [];
  let debugLines = [];

  for (const h of handles) {
    const { items, error } = await fetchUserItems(browser, h);
    if (error) { debugLines.push(`@${h}: ${error}`); continue; }

    const recent = items.filter(v => v.createTime >= cutoff);

    // Refresh counts from each video page if needed
    await refreshCountsForRecent(browser, recent);

    if (recent.length) {
      const top = [...recent].sort((a,b)=> b.stats.playCount - a.stats.playCount)[0];
      debugLines.push(`@${h}: ${recent.length} recent; top ${top.stats.playCount.toLocaleString()} views`);
    } else {
      debugLines.push(`@${h}: 0 recent posts`);
    }

    const qualified = recent
      .filter(v => v.stats.playCount >= MIN_VIEWS)
      .map(v => ({ ...v, author: h }));

    viral.push(...qualified);
  }

  await browser.close();

  // Group by handle for cleaner output
  const byHandle = new Map();
  viral.forEach(v => {
    if (!byHandle.has(v.author)) byHandle.set(v.author, []);
    byHandle.get(v.author).push(v);
  });
  // Sort each handle group by views desc
  for (const [h, arr] of byHandle.entries()) arr.sort((a,b)=> b.stats.playCount - a.stats.playCount);

  let out = [`Check Notification (last ${LOOKBACK_HOURS}H, ≥ ${n(MIN_VIEWS)} views)`];

  if (byHandle.size) {
    for (const [h, arr] of byHandle.entries()) {
      out.push(`@${h} → ${arr.length} post(s) ≥ ${n(MIN_VIEWS)} views`);
      for (const v of arr) {
        out.push(`${v.url} | ${n(v.stats.playCount)} views | ${n(v.stats.diggCount)} likes | ${n(v.stats.commentCount)} coms. | posted ${ago(now, v.createTime)}`);
      }
      out.push(""); // blank line between creators
    }
  } else {
    out.push(`No posts ≥ ${n(MIN_VIEWS)} views in the last ${LOOKBACK_HOURS}h.`);
    out.push("");
    out.push("Debug:");
    out.push(...debugLines);
  }

  await sendDiscord(out.join("\n"));
})();
