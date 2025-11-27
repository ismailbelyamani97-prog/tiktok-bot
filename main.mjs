import fetch from "node-fetch";
import fs from "fs";

// Load secrets
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TIKAPI_KEY = process.env.TIKAPI_KEY;

if (!DISCORD_CHANNEL_ID || !DISCORD_BOT_TOKEN || !TIKAPI_KEY) {
  console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or TIKAPI_KEY");
  process.exit(1);
}

// Load accounts
const accounts = fs.readFileSync("accounts.txt", "utf8")
  .split("\n")
  .map(x => x.trim())
  .filter(Boolean);

// Load view cache
let cache = {};
if (fs.existsSync("views_cache.json")) {
  try {
    cache = JSON.parse(fs.readFileSync("views_cache.json", "utf8"));
  } catch {
    cache = {};
  }
}

// Save cache
function saveCache() {
  fs.writeFileSync("views_cache.json", JSON.stringify(cache, null, 2));
}

// Convert numbers (likes, views)
function fmt(num) {
  const x = Number(num ?? 0);
  if (x >= 1_000_000_000) return (x / 1_000_000_000).toFixed(1) + "B";
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + "M";
  if (x >= 1_000) return (x / 1_000).toFixed(1) + "K";
  return x.toString();
}

// Convert timestamp to age text
function ageText(ts) {
  const posted = new Date(ts * 1000);
  const diff = Date.now() - posted.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return "posted today";
  return "posted " + days + " day(s) ago";
}

// Fetch posts from TikAPI
async function fetchPosts(username) {
  const url = `https://api.tikapi.io/user/${username}/posts?count=30`;

  const res = await fetch(url, {
    headers: { Authorization: TIKAPI_KEY }
  });

  if (!res.ok) return [];
  const data = await res.json();

  if (!data || !data.itemList || !Array.isArray(data.itemList)) return [];

  return data.itemList;
}

// Format blockquote box
function quote(lines) {
  return lines.map(l => "> " + l).join("\n");
}

// Send message to Discord
async function sendDiscord(message) {
  await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": "Bot " + DISCORD_BOT_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: message })
  });
}

// Main execution
(async () => {
  let finalOutput = "**Check Notification (last 8H)**\n\n";

  for (const username of accounts) {
    const posts = await fetchPosts(username);
    if (!posts.length) continue;

    // Prepare cache for this user
    if (!cache[username]) cache[username] = {};

    let scored = [];

    for (const p of posts) {
      const id = p.id;
      const views = p.stats?.playCount ?? 0;
      const likes = p.stats?.diggCount ?? 0;
      const comments = p.stats?.commentCount ?? 0;
      const created = p.createTime;

      const oldViews = cache[username][id] ?? 0;
      const gained = views - oldViews;

      scored.push({
        id,
        url: "https://www.tiktok.com/@" + username + "/video/" + id,
        views,
        likes,
        comments,
        gained,
        created
      });

      cache[username][id] = views;
    }

    // Sort by gained views
    scored.sort((a, b) => b.gained - a.gained);

    const top10 = scored.slice(0, 10);

    const lines = [];
    lines.push("Account: @" + username);
    lines.push("");

    let index = 1;
    for (const p of top10) {
      lines.push(index + ". Post gained " + fmt(p.gained) + " views");
      lines.push("Post Link | @" + username + " | " + fmt(p.views) + " views | " + fmt(p.likes) + " likes | " + fmt(p.comments) + " coms.");
      lines.push(ageText(p.created));
      lines.push("");
      index++;
    }

    finalOutput += quote(lines) + "\n\n";
  }

  await sendDiscord(finalOutput);
  saveCache();

})();
