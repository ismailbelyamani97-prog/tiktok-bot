// main.mjs
import { chromium } from "playwright";
import axios from "axios";
import fs from "fs/promises";

/* ====== ENV (override in workflow) ====== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;     // required
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;      // required
const MIN_VIEWS  = Number(process.env.MIN_VIEWS || 50);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);
/* ======================================== */

const UA_POOL = [
  // real desktop Chrome UAs
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];
const n = (x) => (x || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const ago = (now, tMs) => {
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400); if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600); if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60); if (m) return `${m} min(s) ago`;
  return "just now";
};

/* ---------- SIGI helpers ---------- */
function parseSIGI(html) {
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

/* ---------- “stealthy” context ---------- */
async function newContext(browser) {
  const UA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: rand(1280, 1600), height: rand(720, 900) },
    screen:   { width: 1600, height: 900 },
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Not.A/Brand";v="24", "Google Chrome";v="124"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      referer: "https://www.tiktok.com/",
    },
  });

  // light stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    // fake WebGL
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return "Intel Inc.";       // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return "Intel Iris OpenGL";// UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, p);
    };
  });

  // block heavy assets
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf)$/i.test(u)) return route.abort();
    route.continue();
  });

  return ctx;
}

async function clickCookieButtons(page) {
  const sels = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
    'button:has-text("Accept")',
  ];
  for (const sel of sels) { try { await page.locator(sel).click({ timeout: 1200 }); } catch {} }
}

async function readSIGI(page) {
  try {
    const el = await page.waitForSelector("script#SIGI_STATE", { timeout: 7000 });
    const txt = await el.textContent(); if (txt) return JSON.parse(txt);
  } catch {}
  try {
    const txt = await page.evaluate(() => document.querySelector("#SIGI_STATE")?.textContent || null);
    if (txt) return JSON.parse(txt);
  } catch {}
  try {
    const html = await page.content();
    const st = parseSIGI(html); if (st) return st;
  } catch {}
  throw new Error("no SIGI_STATE");
}

/* ---------- scraping ---------- */
async function fetchUserItems(browser, rawHandle) {
  const handle = rawHandle.replace(/^@+/, "").trim();
  const url = `https://www.tiktok.com/@${handle}?lang=en&is_from_webapp=1&sender_device=pc`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("about:blank");
      await sleep(rand(200, 500));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await clickCookieButtons(page);
      await sleep(rand(900, 1600));
      const state = await readSIGI(page);
      const items = itemsFromState(state).map((v) => ({
        ...v,
        url: `https://www.tiktok.com/@${handle}/video/${v.id}`,
      }));
      await ctx.close();
      return { items, error: null };
    } catch (e) {
      await ctx.close();
      if (attempt === 3) return { items: [], error: `failed to load @${handle}` };
      await sleep(rand(1200, 2200));
    }
  }
  return { items: [], error: `failed to load @${handle}` };
}

// If recent posts show 0 views, open video page and re-read SIGI
async function refreshCounts(browser, posts) {
  for (const p of posts) {
    if (p.stats.playCount > 0) continue;
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(p.url + "?lang=en", { waitUntil: "domcontentloaded", timeout: 45000 });
      await clickCookieButtons(page);
      const st = await readSIGI(page).catch(() => null);
      if (st) {
        const again = itemsFromState(st)[0];
        if (again?.stats?.playCount != null) {
          p.stats.playCount = Number(again.stats.playCount);
          p.stats.diggCount = Number(again.stats.diggCount || 0);
          p.stats.commentCount = Number(again.stats.commentCount || 0);
        }
      }
    } catch {}
    await ctx.close();
    await sleep(rand(250, 600));
  }
  return posts;
}

/* ---------- Discord ---------- */
async function sendDiscord(text) {
  const parts = text.match(/[\s\S]{1,1900}/g) || [];
  for (const c of parts) {
    await axios.post(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
      { content: c },
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
  }
}

/* ===================== MAIN ===================== */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  const start = Date.now();
  const HARD_TIMEOUT_MS = 8 * 60 * 1000; // bail after ~8 minutes on Actions
  const now = Date.now();
  const cutoff = now - LOOKBACK_HOURS * 3600 * 1000;

  const browser = await chromium.launch({
    channel: "chrome",           // ← use full Chrome (installed in workflow)
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  const handles = (await fs.readFile("accounts.txt", "utf8"))
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^@+/, ""));

  let all = [];
  let debug = [];

  for (const h of handles) {
    if (Date.now() - start > HARD_TIMEOUT_MS) { debug.push("⏱️ hard timeout reached"); break; }

    const { items, error } = await fetchUserItems(browser, h);
    if (error) { debug.push(`@${h}: ${error}`); continue; }

    const recent = items.filter((v) => v.createTime >= cutoff);
    await refreshCounts(browser, recent);

    if (recent.length) {
      const top = [...recent].sort((a, b) => b.stats.playCount - a.stats.playCount)[0];
      debug.push(`@${h}: ${recent.length} recent; top ${n(top.stats.playCount)} views`);
    } else {
      debug.push(`@${h}: 0 recent posts`);
    }

    const qualified = recent
      .filter((v) => v.stats.playCount >= MIN_VIEWS)
      .map((v) => ({ ...v, author: h }));
    all.push(...qualified);

    await sleep(rand(350, 800));
  }

  await browser.close();

  // group by handle
  const byHandle = new Map();
  all.forEach((v) => {
    if (!byHandle.has(v.author)) byHandle.set(v.author, []);
    byHandle.get(v.author).push(v);
  });
  for (const [h, arr] of byHandle.entries())
    arr.sort((a, b) => b.stats.playCount - a.stats.playCount);

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
    out.push("", "Debug:", ...debug);
  }

  await sendDiscord(out.join("\n"));
})();
