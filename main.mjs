// main.mjs - viral popular posts (last 7 days) with green bar + no embeds
// Secrets needed: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, RAPIDAPI_KEY
// Input file: accounts.txt (one handle per line, no "@")

import fs from "fs/promises";

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "tiktok-api23.p.rapidapi.com";

// === Rules you can tweak ===
const DAYS_WINDOW = 7; // last N days
const MIN_VIEWS = 100; // threshold
const MAX_IDS_PER_PROFILE = 20; // how many popular posts to scan per account

// ---- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (x) => (x ?? 0).toLocaleString("en-US");
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

async function sendDiscord(text) {
  // flags: 4 => SUPPRESS_EMBEDS (no huge previews)
  // leading ">>>" makes the whole message a multi line blockquote (green bar)
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

// ============ TIKTOK RAPIDAPI INTEGRATION ============

// basic wrapper for RapidAPI GET
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

// Get secUid from handle using /api/user/info
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

// Get popular posts for a user using /api/user/popular-posts
async function getRecentPostsForUser(secUid, maxCount = MAX_IDS_PER_PROFILE) {
  const collected = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && collected.length < maxCount) {
    const count = Math.min(20, maxCount - collected.length);

    const data = await rapidGet("/api/user/popular-posts", {
      secUid,
      count,
      cursor,
    });

    // response shape can vary a bit
    const items =
      data?.data?.videos ||
      data?.data?.items ||
      data?.data ||
      data?.itemList ||
      data?.item_list ||
      [];

    for (const raw of items) {
      collected.push(raw);
      if (collected.length >= maxCount) break;
    }

    hasMore = Boolean(data?.hasMore ?? data?.has_more);
    cursor = data?.cursor ?? data?.cursorNext ?? cursor + count;
  }

  return collected.slice(0, maxCount);
}

// Normalize post stats into the structure the rest of your script expects
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

  const id = String(
    raw.id ??
      raw.awemeId ??
      raw.aweme_id ??
      raw.video_id ??
      ""
  );

  const createTime = Number(
    raw.createTime ??
      raw.create_time ??
      0
  );
  const createMs = createTime ? createTime * 1000 : 0;

  const url = id
    ? `https://www.tiktok.com/@${handle}/video/${id}`
    : raw.shareUrl || raw.share_url || "";

  return { handle, id, url, views, likes, comments, createMs };
}

function withinDays(ms, days) {
  if (!ms) return false;
  return ms >= Date.now() - days * 24 * 3600 * 1000;
}

// ================== MAIN ==================

(async () => {
  if (!CHANNEL_ID || !BOT_TOKEN || !RAPIDAPI_KEY) {
    console.error("Missing DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN or RAPIDAPI_KEY");
    process.exit(1);
  }

  const handles = await readHandles();
  const now = Date.now();
  let posts = [];
  let debug = [];

  for (const handle of handles) {
    try {
      // 1) get secUid for the handle from RapidAPI
      const secUid = await getSecUidFromHandle(handle);

      // 2) get popular posts for that user
      const rawPosts = await getRecentPostsForUser(secUid, MAX_IDS_PER_PROFILE);

      for (const raw of rawPosts) {
        const p = normalizePost(handle, raw);
        if (!p.id) continue;

        if (withinDays(p.createMs, DAYS_WINDOW) && p.views >= MIN_VIEWS) {
          posts.push(p);
        }
      }
    } catch (e) {
      debug.push(`@${handle}: ${e.message || e}`);
    }

    await sleep(300);
  }

  // sort by posted date (newest first)
  posts.sort((a, b) => b.createMs - a.createMs);

  const header = `**Check Notification (last ${DAYS_WINDOW}D)**\n`;
  const lines = [header];

  if (posts.length === 0) {
    lines.push(
      `No posts ≥ ${n(
        MIN_VIEWS
      )} views in the last ${DAYS_WINDOW} day(s).`
    );
  } else {
    posts.forEach((p, i) => {
      lines.push(
        `${i + 1}. Post gained ${n(p.views)} views\n` +
          `[Post Link](${p.url}) | [@${p.handle}](https://www.tiktok.com/@${p.handle}) | ` +
          `${n(p.views)} views | ${n(p.likes)} likes | ${n(
            p.comments
          )} coms.\n` +
          `posted ${ago(now, p.createMs)}\n`
      );
    });
  }

  // If you want debug lines in Discord, uncomment this:
  // if (debug.length) lines.push("\n_Debug:_\n" + debug.join("\n"));

  await sendDiscord(lines.join("\n"));
  console.log("Done");
})();
