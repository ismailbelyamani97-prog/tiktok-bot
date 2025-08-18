import fs from "fs";
import fetch from "node-fetch";

const DISCORD_WEBHOOK = "YOUR_DISCORD_WEBHOOK_HERE"; // replace with your webhook
const links = fs.readFileSync("./links.txt", "utf-8").split("\n").filter(Boolean);

function daysAgo(dateStr) {
  const postDate = new Date(dateStr);
  const diff = Date.now() - postDate.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

async function fetchVideoStats(url) {
  try {
    const res = await fetch(`${url}?__a=1&__d=dis`, {
      headers: {
        "User-Agent": "Mozilla/5.0" // looks human
      }
    });
    if (!res.ok) return null;
    const data = await res.json();

    const item = data?.props?.pageProps?.itemInfo?.itemStruct;
    if (!item) return null;

    return {
      id: item.id,
      url: `https://www.tiktok.com/@${item.author.uniqueId}/video/${item.id}`,
      views: item.stats.playCount,
      likes: item.stats.diggCount,
      comments: item.stats.commentCount,
      shares: item.stats.shareCount,
      createTime: new Date(item.createTime * 1000).toISOString(),
      author: item.author.uniqueId
    };
  } catch (err) {
    console.error("Error fetching:", url, err.message);
    return null;
  }
}

async function main() {
  let allPosts = [];

  for (const link of links) {
    const post = await fetchVideoStats(link);
    if (post && daysAgo(post.createTime) <= 7 && post.views > 100) {
      allPosts.push(post);
    }
  }

  allPosts.sort((a, b) => b.views - a.views);

  if (allPosts.length === 0) {
    console.log("No qualifying posts found.");
    return;
  }

  let description = allPosts.map((p, i) => {
    return `${i + 1}. Post gained **${p.views.toLocaleString()} views**\n` +
           `[Post Link](${p.url}) | @${p.author} | ` +
           `${p.views.toLocaleString()} views | ${p.likes.toLocaleString()} likes | ${p.comments.toLocaleString()} coms.\n` +
           `posted ${daysAgo(p.createTime)} day(s) ago\n`;
  }).join("\n");

  const embed = {
    username: "Greenscreen AI",
    embeds: [
      {
        title: "Check Notification (last 7 days)",
        description,
        color: 0x00ff00
      }
    ]
  };

  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed)
  });

  console.log("✅ Sent to Discord");
}

main();
