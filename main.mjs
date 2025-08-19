// main.mjs
import fs from "fs/promises";

/* Discord credentials (from repo secrets) */
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

const HEADERS = {
  "user-agent":
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://www.tiktok.com/"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (x) => (x || 0).toLocaleString("en-US");

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
  let m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("SIGI_STATE not found");
  return JSON.parse(m[1]);
}

/* ---- FIXED: follower count lives in UserModule.stats[uniqueId].followerCount ---- */
function getFollowerCount(state, handle) {
  const users = state?.UserModule?.users || {};
  const stats = state?.UserModule?.stats || {};

  // direct lookup by uniqueId/handle
  if (stats[handle]?.followerCount != null) return Number(stats[handle].followerCount);

  // sometimes keys are case-variant or mapped; try to find the user by uniqueId in 'users' and then map to stats
  const userEntry = users[handle] || Object.values(users).find(u => (u?.uniqueId || "").toLowerCase() === handle.toLowerCase());
  if (userEntry && stats[userEntry.uniqueId]?.followerCount != null) {
    return Number(stats[userEntry.uniqueId].followerCount);
  }

  // last resort: scan all stats entries and match to a users entry with same key -> uniqueId
  for (const [key, st] of Object.entries(stats)) {
    const u = users[key];
    if ((u?.uniqueId || "").toLowerCase() === handle.toLowerCase() && st?.followerCount != null) {
      return Number(st.followerCount);
    }
  }

  return null; // not found
}

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
      const t = await res.text().catch(()=> "");
      console.error("Discord post failed:", res.status, t);
    }
  }
}

(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN) {
    console.error("❌ Missing DISCORD_CHANNEL_ID or DISCORD_BOT_TOKEN.");
    process.exit(1);
  }

  const handles = await readAccounts();
  let results = [];
  let debug = [];

  for (const h of handles) {
    try {
      const html = await fetchProfileHTML(h);
      const state = extractSIGI(html);
      const followers = getFollowerCount(state, h);
      if (followers != null && followers > 20000) {
        results.push({ handle: h, followers });
      } else {
        debug.push(`@${h}: followerCount not found or ≤ 20k`);
      }
      await sleep(400 + Math.random()*400); // polite delay
    } catch (e) {
      debug.push(`@${h}: ${e.message}`);
    }
  }

  results.sort((a,b) => b.followers - a.followers);

  let out = ["**Accounts with >20k followers**", ""];
  if (results.length) {
    results.forEach((r,i)=>{
      out.push(`${i+1}. [@${r.handle}](https://www.tiktok.com/@${r.handle}) — **${n(r.followers)} followers**`);
    });
  } else {
    out.push("_No accounts matched_");
  }

  if (debug.length) {
    out.push("", "_Debug:_", ...debug);
  }

  await sendDiscord(out.join("\n"));
  console.log("✅ Done");
})();
