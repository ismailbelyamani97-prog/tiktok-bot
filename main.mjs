// main.mjs
import fs from "fs/promises";

/* Discord credentials */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const HEADERS = {
  "user-agent":
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://www.tiktok.com/"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readAccounts() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^@+/, ""));
}

async function fetchProfileHTML(handle) {
  const url = `https://www.tiktok.com/@${handle}?lang=en`;
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("SIGI_STATE not found");
  return JSON.parse(m[1]);
}

function getFollowerCount(state, handle) {
  const u = state?.UserModule?.users?.[handle];
  return u?.stats?.followerCount ?? null;
}

async function sendDiscord(text) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: text })
  });
  if (!res.ok) {
    console.error("Discord error", res.status, await res.text());
  }
}

(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  const handles = await readAccounts();
  let results = [];

  for (const h of handles) {
    try {
      const html = await fetchProfileHTML(h);
      const state = extractSIGI(html);
      const followers = getFollowerCount(state, h);
      if (followers && followers > 20000) {
        results.push({ handle: h, followers });
      }
      await sleep(500); // politeness
    } catch (e) {
      console.error(`@${h} failed:`, e.message);
    }
  }

  results.sort((a, b) => b.followers - a.followers);

  let out = ["**Accounts with >20k followers**", ""];
  results.forEach((r, i) => {
    out.push(`${i+1}. [@${r.handle}](https://www.tiktok.com/@${r.handle}) — **${r.followers.toLocaleString()} followers**`);
  });
  if (results.length === 0) out.push("_No accounts matched_");

  await sendDiscord(out.join("\n"));
  console.log("✅ Done");
})();
