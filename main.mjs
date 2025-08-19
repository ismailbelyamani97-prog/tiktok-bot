// main.mjs
import fs from "fs/promises";

/* ===== GitHub Secrets =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
=========================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const n = (x) => (x ?? 0).toLocaleString("en-US");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const daysAgo = (ms) => (ms ? Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24)) : null);

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* --- mirror fetch (returns raw HTML, avoids consent walls) --- */
async function fetchMirror(url) {
  const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(proxied, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
  return res.text();
}

/* --- pull video ids from profile HTML --- */
function extractVideoIdsFromProfileHTML(html) {
  const ids = new Set();
  const re = /\/video\/(\d{8,})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 12) break;
  }
  return [...ids];
}

/* --- get views + createTime from video HTML --- */
function extractStatsFromVideoHTML(html) {
  let views = 0, createMs = 0;

  let m = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
  if (m) views = Number(m[1]);

  m = html.match(/"createTime"\s*:\s*"?(\d+)"?/);
  if (m) createMs = Number(m[1]) * 1000;

  if (!views) {
    m = html.match(/"views"\s*:\s*"?(\d+)"?/);
    if (m) views = Number(m[1]);
  }
  return { views, createMs };
}

/* --- send to Discord --- */
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
      await res.text().catch(()=>{});
    }
    await sleep(400);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let latest = [];

  for (const handle of handles) {
    try {
      const profileHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      const ids = extractVideoIdsFromProfileHTML(profileHTML);
      if (!ids.length) continue;

      const videoId = ids[0];
      const videoHTML = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${videoId}`);
      const { views, createMs } = extractStatsFromVideoHTML(videoHTML);

      latest.push({
        handle,
        url: `https://www.tiktok.com/@${handle}/video/${videoId}`,
        views,
        createMs
      });

      await sleep(600 + Math.random() * 400);
    } catch {
      // quietly skip failed accounts (no debug output)
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

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
