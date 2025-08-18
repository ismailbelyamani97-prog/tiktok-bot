import { chromium } from "playwright";
import axios from "axios";
import fs from "fs/promises";

const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const BOT = process.env.DISCORD_BOT_TOKEN;
const MIN_VIEWS = Number(process.env.MIN_VIEWS || 100000);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);

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
  const page = await ctx.newPage();
  const url = `https://www.tiktok.com/@${handle}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);
    const html = await page.content();
    const state = parseFromSIGI(html);
    const items = itemsFromState(state).map(v => ({
      ...v,
      url: `https://www.tiktok.com/@${handle}/video/${v.id}`
    }));
    await ctx.close();
    return items;
  } catch {
    await ctx.close();
    return [];
  }
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
  for (const h of handles) {
    const items = await fetchUserItems(browser, h);
    const recent = items.filter(v => v.createTime >= cutoff);
    const qualified = recent.filter(v => v.stats.playCount >= MIN_VIEWS)
                            .map(v => ({ ...v, author: h }));
    viral.push(...qualified);
  }
  await browser.close();

  viral.sort((a,b)=> b.stats.playCount - a.stats.playCount);

  let out = [`Check Notification (last ${LOOKBACK_HOURS}H)`];
  viral.forEach((v,i)=>{
    out.push(`${i+1}. Post gained ${n(v.stats.playCount)} views`);
    out.push(`${v.url} | @${v.author} | ${n(v.stats.playCount)} views | ${n(v.stats.diggCount)} likes | ${n(v.stats.commentCount)} coms.`);
    out.push(`posted ${ago(now, v.createTime)}`);
    out.push("");
  });
  if (!viral.length) out.push(`No posts ≥ ${n(MIN_VIEWS)} views in the last ${LOOKBACK_HOURS}h.`);

  await sendDiscord(out.join("\n"));
})();
