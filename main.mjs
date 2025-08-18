import { chromium } from "playwright";
import axios from "axios";
import fs from "fs/promises";

/* ====== CONFIG (defaults; can be overridden via env) ====== */
const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const BOT = process.env.DISCORD_BOT_TOKEN;
const MIN_VIEWS = Number(process.env.MIN_VIEWS || 50);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);
/* ========================================================= */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const n = (x) => (x || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (now, tMs) => {
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400);
  if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600);
  if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60);
  if (m) return `${m} min(s) ago`;
  return "just now";
};

/* ---------- parse helpers ---------- */
function parseFromSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE".*?>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function itemsFromState(state) {
  const mod = state?.ItemModule || {};
  return Object.values(mod).map((v) => ({
    id: v.id,
    author: v.author,
    createTime: Number(v.createTime) * 1000,
    stats: {
      playCount: Number(v.stats?.playCount || 0),
      diggCount: Number(v.stats?.diggCount || 0),
      commentCount: Number(v.stats?.commentCount || 0),
    },
  }));
}

/* ---------- page helpers ---------- */
async function newContext(browser) {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
  });
  // block images to be lighter
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) return route.abort();
    return route.continue();
  });
  return ctx;
}

async function gotoAndGetState(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // cookie buttons in various wordings (best effort)
  const btns = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
  ];
  for (const sel of btns) {
    try { await page.locator(sel).click({ timeout: 1500 }); } catch {}
  }
  await page.waitForSelector("script#SIGI_STATE", { timeout: 15000 });
  const html = await page.content();
  return parseFromSIGI(html);
}

/* ---------- scraping functions ---------- */
async function fetchUserItems(browser, handleRaw) {
  const handle = handleRaw.replace(/^@+/, "").trim();
  const url = `https://www.tiktok.com/@${handle}?lang=en`;

  // try up to 2 attempts
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    try {
      const state = await gotoAndGetState(page, url);
      await ctx.close();
      if (!state) throw new Error("no SIGI_STATE");
      const items = itemsFromState(state).map((v) => ({
        ...v,
        url: `https://www.tiktok.com/@${handle}/video/${v.id}`,
      }));
      return { items, error: null, title: await (async () => {
        const c = await newContext(browser); const p = await c.newPage();
        try { await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }); return await p.title(); }
        catch { return "(title n/a)"; } finally { await c.close(); }
      })() };
    } catch (e) {
      await ctx.close();
      if (attempt === 2) return { items: [], error: `failed to load @${handle}`, title: "" };
      await sleep(1500);
    }
  }
  return { items: [], error: `failed to load @${handle}`, title: "" };
}

// Fallback: open each video page to refresh counts if profile JSON was stale
async function refreshCountsForRecent(browser, posts) {
  for (const p of posts) {
    if (p.stats?.playCount > 0) continue; // already has number
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(p.url + "?lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("script#SIGI_STATE", { timeout: 15000 });
      const html = await page.content();
      const state = parseFromSIGI(html);
      const again = itemsFromState(state)[0];
      if (again?.stats?.playCount != null) {
        p.stats.playCount = Number(again.stats.playCount);
        p.stats.diggCount = Number(again.stats.diggCount || 0);
        p.stats.commentCount = Number(again.stats.commentCount || 0);
      }
    } catch {}
    await ctx.close();
  }
  return posts;
}

/* ---------- Discord ---------- */
async function sendDiscord(text) {
  // split long messages into chunks under 1900 chars
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    await axios.post(
      `https://discord.com/api/v10/channels/${CHANNEL}/messages`,
      { content: c },
      { headers: { Authorization: `Bot ${BOT}` } }
    );
  }
}

/* ================== MAIN ================== */
(async () => {
  const now = Date.now();
  const cutoff = now - LOOKBACK_HOURS * 3600 * 1000;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  const handles = (await fs.readFile("accounts.txt", "utf8"))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^@+/, "")); // auto-strip leading @

  let viral = [];
  let debugLines = [];

  for (const h of handles) {
    const { items, error, title } = await fetchUserItems(browser, h);
    if (error) { debugLines.push(`@${h}: ${error}`); continue; }
    if (title) debugLines.push(`@${h}: loaded page "${title}"`);

    const recent = items.filter((v) => v.createTime >= cutoff);

    // refresh counts from each video page if zero/stale
    await refreshCountsForRecent(browser, recent);

    if (recent.length) {
      const top = [...recent].sort((a, b) => b.stats.playCount - a.stats.playCount)[0];
      debugLines.push(`@${h}: ${recent.length} recent; top ${n(top.stats.playCount)} views`);
    } else {
      debugLines.push(`@${h}: 0 recent posts`);
    }

    const qualified = recent
      .filter((v) => v.stats.playCount >= MIN_VIEWS)
      .map((v) => ({ ...v, author: h }));

    viral.push(...qualified);
  }

  await browser.close();

  // group by handle
  const byHandle = new Map();
  viral.forEach((v) => {
    if (!byHandle.has(v.author)) byHandle.set(v.author, []);
    byHandle.get(v.author).push(v);
  });
  for (const [h, arr] of byHandle.entries()) arr.sort((a, b) => b.stats.playCount - a.stats.playCount);

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
    out.push(...debugLines);
  }

  await sendDiscord(out.join("\n"));
})();
