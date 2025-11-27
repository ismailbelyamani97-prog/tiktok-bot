// main.mjs
// TikTok view gainer tracker using TikAPI + Discord embed
// Secrets: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, TIKAPI_KEY
// Input: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TIKAPI_KEY = process.env.TIKAPI_KEY;

const TIKAPI_BASE = "https://api.tikapi.io";

// label only, describes how often the bot runs
const WINDOW_LABEL_HOURS = 8;

// TikAPI limits
const MAX_POSTS_PER_ACCOUNT = 30;
const TOP_N = 10;

// cache file for previous view counts
const CACHE_FILE = "views_cache.json";

// green embed color (vertical bar)
const EMBED_COLOR = 0x00ff66;

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 300K / 8.2M style
function fmtShort(num) {
  const x = Number(num ?? 0);
  if (x >= 1_000_000_000) return (x / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (x >= 1_000) return (x / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return x.toString();
}

// "4 day(s) ago"
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

async function readHandles() {
  const raw = await fs.readFile("accounts.txt", "utf8");
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^@+/, ""));
}

// Discord embed sender
async function sendDiscordEmbed(embed) {
  const body = {
    content: "",
    embeds: [embed],
  };

  await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// cache helpers
async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
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

// from @username to secUid
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
    createMs = createTime > 2_000_000_000 ? createTime : createTime * 1000;
  }

  const url = id
    ? `https://www.tiktok.com/@${handle}/video/${id}`
    : (raw.shareUrl || raw.share_url || "");

  return { handle, id, url, views, likes, comments, createMs };
}

// fetch recent posts for a user
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

// build embed.description text
function buildDescription(topPosts, now) {
  let desc = `**Check Notification (last ${WINDOW_LABEL_HOURS}H)**\n\n`;

  if (!topPosts.length) {
    desc += "No posts gained views since last check.";
    return desc;
  }

  topPosts.forEach((p, i) => {
    const header = `${i + 1}. Post gained ${fmtShort(p.gained)} views`;
    const line2 =
      `[Post Link](${p.url}) | ` +
      `[@${p.handle}](https://www.tiktok.com/@${p.handle}) | ` +
      `${fmtShort(p.views)} views | ${fmtShort(p.likes)} likes | ${fmtShort(p.comments)} coms.`;
    const line3 = `posted ${ago(now, p.createMs)}`;

    const block = `${header}\n${line2}\n${line3}\n\n`;

    // keep under 4000 chars to stay safe for embed description
    if ((desc + block).length <= 4000) {
      desc += block;
    }
  });

  return desc.trimEnd();
}

// main
(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN || !TIKAPI_KEY) {
    console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or TIKAPI_KEY");
    process.exit(1);
  }

  const handles = await readHandles();
  const now = Date.now();
  const cache = await loadCache(); // { [postId]: { views } }

  let posts = [];
  let debug = [];

  for (const handle of handles) {
    try {
      const secUid = await getSecUidFromUsername(handle);
      const userPosts = await getRecentPostsForSecUid(handle, secUid);

      if (!userPosts.length) {
        debug.push(`@${handle}: no posts returned from TikAPI`);
      }

      for (const p of userPosts) {
        if (!p.url || !p.id) continue;

        const key = String(p.id);
        const prevViews = cache[key]?.views ?? 0;
        const gained = Math.max(0, p.views - prevViews);

        posts.push({
          ...p,
          gained,
        });

        // update cache to current value
        cache[key] = {
          views: p.views,
          updatedAt: now,
        };
      }
    } catch (e) {
      debug.push(`@${handle}: ${e.message || e}`);
    }

    await sleep(400);
  }

  // save updated cache for next run
  await saveCache(cache);

  // keep only posts that actually gained views
  posts = posts.filter((p) => p.gained > 0);

  // sort by gained views descending, take top N
  posts.sort((a, b) => b.gained - a.gained);
  const top = posts.slice(0, TOP_N);

  if (debug.length) {
    console.log("Debug:");
    console.log(debug.join("\n"));
  }

  const description = buildDescription(top, now);

  const embed = {
    title: "", // we put title inside description as bold, to match your reference
    description,
    color: EMBED_COLOR,
    timestamp: new Date().toISOString(),
  };

  await sendDiscordEmbed(embed);
  console.log("Done");
})();
