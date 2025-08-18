async function newContext(browser) {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Not.A/Brand";v="24", "Google Chrome";v="124"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  // basic stealth tweaks
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1,2,3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US","en"] });
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p.name === "notifications"
          ? Promise.resolve({ state: "denied" })
          : origQuery(p);
    }
  });

  // block images to be faster
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) return route.abort();
    return route.continue();
  });

  return ctx;
}

// try multiple ways to get the SIGI json (with retries)
async function gotoAndGetState(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // try common cookie buttons; ignore errors
  const btns = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
    'button:has-text("Accept")',
  ];
  for (const sel of btns) {
    try { await page.locator(sel).click({ timeout: 1200 }); } catch {}
  }

  // strategy A: direct element
  try {
    const el = await page.waitForSelector("script#SIGI_STATE", { timeout: 8000 });
    const txt = await el.textContent();
    if (txt) return JSON.parse(txt);
  } catch {}

  // strategy B: evaluate in-page
  try {
    const txt = await page.evaluate(() => document.querySelector("#SIGI_STATE")?.textContent || null);
    if (txt) return JSON.parse(txt);
  } catch {}

  // strategy C: get full HTML and regex
  try {
    const html = await page.content();
    const m = html.match(/<script id="SIGI_STATE".*?>([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch {}

  throw new Error("no SIGI_STATE");
}

async function fetchUserItems(browser, handleRaw) {
  const handle = handleRaw.replace(/^@+/, "").trim();
  const url = `https://www.tiktok.com/@${handle}?lang=en&is_from_webapp=1&sender_device=pc`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    try {
      const state = await gotoAndGetState(page, url);
      const items = (state?.ItemModule ? Object.values(state.ItemModule) : []).map(v => ({
        id: v.id,
        author: v.author,
        createTime: Number(v.createTime) * 1000,
        stats: {
          playCount: Number(v.stats?.playCount || 0),
          diggCount: Number(v.stats?.diggCount || 0),
          commentCount: Number(v.stats?.commentCount || 0),
        },
        url: `https://www.tiktok.com/@${handle}/video/${v.id}`
      }));
      await ctx.close();
      return { items, error: null, title: state?.SEOState?.metaParams?.title || "" };
    } catch (e) {
      await ctx.close();
      if (attempt === 3) return { items: [], error: `failed to load @${handle}`, title: "" };
      await sleep(2000); // backoff and try again
    }
  }
  return { items: [], error: `failed to load @${handle}`, title: "" };
}
