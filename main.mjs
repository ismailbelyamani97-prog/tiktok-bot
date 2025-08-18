import fs from "fs";
import fetch from "node-fetch";
import { chromium } from "playwright";

// Load accounts
const accounts = JSON.parse(fs.readFileSync("./accounts.txt", "utf8"));
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const VIEW_THRESHOLD = 50;
const TIME_LIMIT_HOURS = 48;

async function scrapeAccount(browser, url) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // scroll human-like
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    // grab video blocks
    const videos = await page.$$eval("a[href*='/video/']", (els) =>
      els.map((el) => {
        const parent = el.closest("div[data-e2e='user-post-item']") || el;
        const viewsEl = parent.querySelector("strong");
        return {
          link: el.href,
          views: viewsEl ? viewsEl.innerText : "0",
        };
      })
    );

    return videos;
  } catch (err) {
    return { error: `failed to load ${url}: ${err.message}` };
  } finally {
    await context.close();
  }
}

function parseViews(viewStr) {
  if (!viewStr) return 0;
  viewStr = viewStr.toLowerCase();
  if (viewStr.endsWith("k")) return parseFloat(viewStr) * 1000;
  if (viewStr.endsWith("m")) return parseFloat(viewStr) * 1000000;
  return parseInt(viewStr.replace(/\D/g, "")) || 0;
}

async function sendDiscord(msg) {
  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: msg }),
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let report = `✅ TikTok Check (last ${TIME_LIMIT_HOURS}h, ≥${VIEW_THRESHOLD} views)\n\n`;

  for (const url of accounts) {
    const result = await scrapeAccount(browser, url);

    if (result.error) {
      report += `⚠️ ${result.error}\n`;
      continue;
    }

    let hits = [];
    for (const v of result) {
      const views = parseViews(v.views);
      if (views >= VIEW_THRESHOLD) {
        hits.push(`${views} views → ${v.link}`);
      }
    }

    if (hits.length > 0) {
      report += `🔹 ${url}\n${hits.join("\n")}\n\n`;
    } else {
      report += `❌ ${url} → No posts ≥ ${VIEW_THRESHOLD} views\n`;
    }
  }

  await sendDiscord(report);
  await browser.close();
})();
