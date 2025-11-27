// main.mjs
// Top 10 posts with most views in the last 48 hours, across all accounts
// Uses TikAPI
// Secrets: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, TIKAPI_KEY
// Input: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TIKAPI_KEY = process.env.TIKAPI_KEY;

const TIKAPI_BASE = "https://api.tikapi.io";

// window and limits
const HOURS_WINDOW = 48;          // last 48 hours
const MAX_POSTS_PER_ACCOUNT = 50; // how many recent posts to scan per account
const TOP_N = 10;                 // how many posts to report

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (x) => (x ?? 0).toLocaleString("en-US");

// "4 day(s) ago" style
const ago = (now, tMs) => {
  if (!tMs) return "";
  const s = Math.floor((now - tMs) / 1000);
  const d = Math.floor(s / 86400);
  if (d) return `${d} day(s) ago`;
  const h = Math.floor((s % 86400) / 3600);
  if (h) return `${h} hour(s) ago`;
  const m = Math.floor((s % 3600) / 60);
  if (m) return `${m} min(s) ago`;
  return "just now";
};

function withinHours(ms, hours) {
  if (!ms) return false;
  return ms >= Date.now() - hours * 3600 * 1000;
}

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
  // leading ">>>" makes a multi line quote with a green bar
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

// TikAPI GET wrapper
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

// 1) from @username to secUid
async function getSecUidFromUsername(username) {
  const data = await tikapiGet("/public/check", { username });

  const secUid = data?.userInfo?.user?.secUid;
  if (!secUid) {
    throw new Error("secUid not found in profile response");
  }
  return secUid;
}

// normalize a single post object
function normalizePost(handle, raw) {
  const stats = raw.stats || raw.statistics || {};
  const views = Number(
    stats.playCount ??
      stats.viewCount ??
      stats.play_count ??
      stats.view_count ??
      0
  );
  const likes = Number(
    stats.diggCount ??
      stats.likeCount ??
      stats.digg_count ??
      stats.like_count ??
      0
  );
  const comments = Number(
    stats.commentCount ??
      stats.comment_count ??
      0
  );

  const id =
    raw.id ||
    raw.aweme_id ||
    raw.awemeId ||
    raw.video?.id;

  const createTime = Number(
    raw.createTime ??
      raw.create_time ??
      raw.create_time_ms ??
      0
  );
  let createMs = 0;
  if (createTime) {
    // seconds vs milliseconds
    createMs = createTime > 2_000_000_000 ? createTime : createTime * 1000;
  }

  const url =
    raw.shareUrl ||
    raw.share_url ||
    (id
      ? `https://www.tiktok.com/@${handle}/video/${id}`
      : "");

  return { handle, id, url, views, likes, comments, createMs };
}

// 2) fetch recent posts for a user
async function getRecentPostsForSecUid(handle, secUid) {
  const data = await tikapiGet("/public/posts", {
    secUid,
    count: MAX_POSTS_PER_ACCOUNT,
    cursor: 0,
  });

  const items =
    data?.itemList ||
    data?.items ||
    data?.aweme_list ||
    [];

  return items.map((raw) => normalizePost(handle, raw));
}

// main
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN || !TIKAPI_KEY) {
    console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or TIKAPI_KEY");
    process.exit(1);
  }

  const handles = await readHandles();
  const now = Date.now();
  let posts = [];
  let debug = [];

  for (const handle of handles) {
    try {
      const secUid = await getSecUidFromUsername(handle);
      const userPosts = await getRecentPostsForSecUid(handle, secUid);

      for (const p of userPosts) {
        if (!p.url || !p.createMs) continue;
        if (withinHours(p.createMs, HOURS_WINDOW)) {
          posts.push(p);
        }
      }
    } catch (e) {
      debug.push(`@${handle}: ${e.message || e}`);
    }

    await sleep(400);
  }

  // sort by views descending and take top N
  posts.sort((a, b) => b.views - a.views);
  const top = posts.slice(0, TOP_N);

  const header = `**Check Notification (last ${HOURS_WINDOW}H)**\n`;
  const lines = [header];

  if (!top.length) {
    lines.push("No posts found in this window.");
  } else {
    top.forEach((p, i) => {
      lines.push(
        `${i + 1}. Post gained ${fmt(p.views)} views\n` +
          `[Post Link](${p.url}) | [@${p.handle}](https://www.tiktok.com/@${p.handle}) | ` +
          `${fmt(p.views)} views | ${fmt(p.likes)} likes | ${fmt(
            p.comments
          )} coms.\n` +
          `posted ${ago(now, p.createMs)}\n`
      );
    });
  }

  // optional debug line if you want to see errors for some accounts
  // if (debug.length) lines.push("\n_Debug:_\n" + debug.join("\n"));

  await sendDiscord(lines.join("\n"));
  console.log("Done");
})();
