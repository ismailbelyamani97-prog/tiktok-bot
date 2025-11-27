// main.mjs
// Very simple: send the latest TikTok post link from each account to Discord
// Secrets needed: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, RAPIDAPI_KEY
// Input file: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

// env vars from GitHub Actions
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "tiktok-api23.p.rapidapi.com";

// small helpers
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
  // leading ">>>" makes a green bar quote block
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

// basic RapidAPI GET wrapper
async function rapidGet(path, query = {}) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_HOST,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`RapidAPI ${path} HTTP ${res.status} ${txt}`);
  }
  return res.json();
}

// step 1: get secUid from username
async function getSecUidFromHandle(handle) {
  const data = await rapidGet("/api/user/info", { uniqueId: handle });

  const secUid =
    data?.userInfo?.user?.secUid ||
    data?.user?.secUid ||
    data?.secUid;

  if (!secUid) {
    throw new Error("no secUid in user/info response");
  }
  return secUid;
}

// step 2: get latest post for that secUid
async function getLatestPostForUser(handle, secUid) {
  const data = await rapidGet("/api/user/posts", {
    secUid,
    count: 1,
    cursor: 0,
  });

  const items =
    data?.data?.videos ||
    data?.data?.items ||
    data?.data ||
    data?.itemList ||
    data?.item_list ||
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
    raw.awemeId ||
    raw.aweme_id ||
    raw.video_id;

  if (!id) {
    return null;
  }

  const url = `https://www.tiktok.com/@${handle}/video/${id}`;

  return {
    handle,
    url,
    views,
  };
}

// main script
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN || !RAPIDAPI_KEY) {
    console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or RAPIDAPI_KEY");
    process.exit(1);
  }

  const handles = await readHandles();
  const lines = ["Latest TikTok post for each account:\n"];

  for (const handle of handles) {
    try {
      const secUid = await getSecUidFromHandle(handle);
      const latest = await getLatestPostForUser(handle, secUid);

      if (!latest) {
        lines.push(`No posts found for @${handle}`);
      } else {
        lines.push(
          `@${handle}: ${latest.url} (views: ${latest.views})`
        );
      }
    } catch (e) {
      lines.push(`Error for @${handle}: ${e.message || e}`);
    }

    await sleep(300);
  }

  await sendDiscord(lines.join("\n"));
  console.log("Done");
})();
