// main.mjs
// Uses TikAPI to send the latest TikTok post link for each account to Discord
// Secrets needed: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, TIKAPI_KEY
// Input file: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

// env vars from GitHub Actions
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TIKAPI_KEY = process.env.TIKAPI_KEY;

const TIKAPI_BASE = "https://api.tikapi.io";

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readHandles() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^@+/, ""));
}

async function sendDiscord(text) {
  // flags: 4 => SUPPRESS_EMBEDS
  // leading ">>>" turns the message into a blockquote with a vertical bar
  const content = `>>> ${text}`;
  const chunks = content.match(/[\s\S]{1,1800}/g) || [];
  for (const c of chunks) {
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: c, flags: 4 }),
    });
    await sleep(250);
  }
}

// basic TikAPI GET wrapper
async function tikapiGet(path, query = {}) {
  const url = new URL(TIKAPI_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-KEY": TIKAPI_KEY,
    },
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`TikAPI returned non JSON response, HTTP ${res.status}`);
  }

  if (json?.status === "error") {
    throw new Error(json.message || "TikAPI error");
  }

  return json;
}

// 1) from @username to secUid using TikAPI public/check
async function getSecUidFromUsername(username) {
  const data = await tikapiGet("/public/check", { username });

  const secUid = data?.userInfo?.user?.secUid;
  if (!secUid) {
    throw new Error("secUid not found in profile response");
  }
  return secUid;
}

// 2) from secUid to latest feed post using TikAPI public/posts
async function getLatestPostFromSecUid(handle, secUid) {
  const data = await tikapiGet("/public/posts", {
    secUid,
    count: 1,
    cursor: 0,
  });

  const items =
    data?.itemList ||
    data?.items ||
    data?.aweme_list ||
    [];

  if (!items.length) {
    return null;
  }

  const raw = items[0];

  const stats = raw.stats || raw.statistics || {};
  const views = Number(
    stats.playCount ??
      stats.viewCount ??
      stats.play_count ??
      stats.view_count ??
      0
  );

  const id =
    raw.id ||
    raw.aweme_id ||
    raw.awemeId ||
    raw.video?.id;

  if (!id) {
    return { handle, url: null, views };
  }

  const url =
    raw.shareUrl ||
    raw.share_url ||
    `https://www.tiktok.com/@${handle}/video/${id}`;

  return { handle, url, views };
}

// main script
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN || !TIKAPI_KEY) {
    console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or TIKAPI_KEY");
    process.exit(1);
  }

  const handles = await readHandles();
  const lines = ["Latest TikTok post for each account:\n"];

  for (const handle of handles) {
    try {
      const secUid = await getSecUidFromUsername(handle);
      const latest = await getLatestPostFromSecUid(handle, secUid);

      if (!latest || !latest.url) {
        lines.push(`No posts found for @${handle}`);
      } else {
        lines.push(
          `@${handle}: ${latest.url} (views: ${latest.views})`
        );
      }
    } catch (e) {
      lines.push(`Error for @${handle}: ${e.message || e}`);
    }

    await sleep(400);
  }

  await sendDiscord(lines.join("\n"));
  console.log("Done");
})();
