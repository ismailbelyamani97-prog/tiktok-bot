// main.mjs
import fs from "fs/promises";

/* ===== GitHub Secrets =====
   DISCORD_BOT_TOKEN
   DISCORD_CHANNEL_ID
=========================================== */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtNum = (x) => (x ?? 0).toLocaleString("en-US");

/* ---- Read accounts.txt ---- */
async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

/* ---- Fetch HTML via jina.ai mirror ---- */
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

/* ---- Extract video IDs from profile HTML ---- */
function extractVideoIdsFromProfileHTML(html) {
  const ids = new Set();
  const re = /\/video\/(\d{8,})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 20) break; // take first 20 posts for safety
  }
  return [...ids];
}

/* ---- Extract stats (views, likes, createTime) from video HTML ---- */
function extractStatsFromVideoHTML(html) {
  let views = 0, likes = 0, createMs = 0;

  let m = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
  if (m) views = Number(m[1]);

  m = html.match(/"diggCount"\s*:\s*"?(\d+)"?/);
  if (m) likes = Number(m[1]);

  m = html.match(/"createTime"\s*:\s*"?(\d+)"?/);
  if (m) createMs = Number(m[1]) * 1000;

  return { views, likes, createMs };
}

function formatDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: "UTC" });
}

/* ---- Send message(s) to Discord ---- */
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
    await sleep(600);
  }
}

/* ========================= MAIN ========================= */
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let viralPosts = [];

  for (const handle of handles) {
    try {
      const profileHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
      const ids = extractVideoIdsFromProfileHTML(profileHTML);

      for (const videoId of ids) {
        const videoHTML = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${videoId}`);
        const { views, likes, createMs } = extractStatsFromVideoHTML(videoHTML);

        if (createMs && Date.now() - createMs <= 7 * 24 * 3600 * 1000 && views >= 1000) {
          viralPosts.push({
            handle,
            videoId,
            url: `https://www.tiktok.com/@${handle}/video/${videoId}`,
            accountUrl: `https://www.tiktok.com/@${handle}`,
            views,
            likes,
            createMs
          });
        }

        await sleep(600 + Math.random() * 400);
      }
    } catch (e) {
      console.error(`@${handle}: ${e.message}`);
    }
  }

  viralPosts.sort((a, b) => b.createMs - a.createMs);

  let lines = ["**🔥 Viral posts in last 7 days (≥1000 views)**", ""];
  if (viralPosts.length) {
    viralPosts.forEach((p, i) => {
      lines.push(
        `${i + 1}. [Post Link](${p.url}) | [@${p.handle}](${p.accountUrl}) — **${fmtNum(p.views)} views**, ❤️ ${fmtNum(p.likes)}, 📅 ${formatDate(p.createMs)}`
      );
    });
  } else {
    lines.push("No viral posts found in last 7 days.");
  }

  await sendDiscord(lines.join("\n"));
  console.log("✅ Done");
})();
