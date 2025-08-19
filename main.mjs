// main.mjs
import fs from "fs/promises";

/* ===== GitHub Secrets you already set =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
=========================================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const n = (x) => (x ?? 0).toLocaleString("en-US");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* ---- Fetch via a public mirror that returns raw HTML (bypasses JS/consent) ----
   Example: https://r.jina.ai/http://www.tiktok.com/@healthy.hair.usa
--------------------------------------------------------------------------- */
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

/* ---- From a profile page HTML, collect video IDs by regex ---- */
function extractVideoIdsFromProfileHTML(html) {
  const ids = new Set();
  // capture …/video/1234567890123456789
  const re = /\/video\/(\d{8,})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 12) break; // we only need the first handful
  }
  return [...ids];
}

/* ---- From a video page HTML, capture views and createTime ---- */
function extractStatsFromVideoHTML(html) {
  // try JSON-like keys first
  let views = 0, createMs = 0;

  let m = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
  if (m) views = Number(m[1]);

  m = html.match(/"createTime"\s*:\s*"?(\d+)"?/);
  if (m) createMs = Number(m[1]) * 1000;

  // fallback: sometimes views appear as "views":12345
  if (!views) {
    m = html.match(/"views"\s*:\s*"?(\d+)"?/);
    if (m) views = Number(m[1]);
  }

  return { views, createMs };
}

const daysAgo = (ms) =>
  ms ? Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24)) : null;

/* ---- Post message(s) to Discord via Bot HTTP API ---- */
async function sendDiscord(text) {
  const chunks = text.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${BOT_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: c })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("Discord post failed:", res.status, t);
    }
    await sleep(500);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let latest = [];     // one latest post per account (with views)
  let debug = [];

  for (const handle of handles) {
    try {
      // 1) fetch profile through mirror
      const profileHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      const ids = extractVideoIdsFromProfileHTML(profileHTML);

      if (!ids.length) {
        debug.push(`@${handle}: no video ids found`);
        continue;
      }

      // "Latest" = first id found on profile page (they're shown newest first)
      const videoId = ids[0];

      // 2) fetch that video page to read views + time
      const videoHTML = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${videoId}`);
      const { views, createMs } = extractStatsFromVideoHTML(videoHTML);

      latest.push({
        handle,
        videoId,
        url: `https://www.tiktok.com/@${handle}/video/${videoId}`,
        views,
        createMs
      });

      await sleep(600 + Math.random() * 400);
    } catch (e) {
      debug.push(`@${handle}: ${e.message}`);
    }
  }

  // sort by views (desc)
  latest.sort((a, b) => (b.views || 0) - (a.views || 0));

  let lines = ["**Latest post per account — sorted by views**", ""];
  if (latest.length) {
    latest.forEach((p, i) => {
      const when = p.createMs ? ` — posted ${daysAgo(p.createMs)} day(s) ago` : "";
      lines.push(`${i + 1}. [Post Link](${p.url}) | @${p.handle} — **${n(p.views)} views**${when}`);
    });
  } else {
    lines.push("No posts could be read.");
  }

  if (debug.length) {
    lines.push("", "_Debug:_", ...debug);
  }

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
