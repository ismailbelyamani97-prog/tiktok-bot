import fs from "fs";
import playwright from "playwright";

async function scrapeAccount(username) {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const url = `https://www.tiktok.com/@${username}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Grab posts with Playwright
    const posts = await page.$$eval("div[data-e2e='user-post-item']", (nodes) =>
      nodes.map((n) => {
        const views = n.querySelector("strong")?.innerText || "0";
        return { views };
      })
    );

    return { username, posts };
  } catch (err) {
    return { username, error: err.message };
  } finally {
    await browser.close();
  }
}

async function main() {
  const accounts = fs.readFileSync("accounts.txt", "utf-8").split("\n").filter(Boolean);
  const results = [];

  for (const account of accounts) {
    console.log(`Scraping ${account}...`);
    const res = await scrapeAccount(account);
    results.push(res);
  }

  console.log("Scrape results:", results);
}

main();
