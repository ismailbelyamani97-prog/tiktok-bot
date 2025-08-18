import fs from "fs";
import fetch from "node-fetch";

const DISCORD_WEBHOOK = "YOUR_DISCORD_WEBHOOK_HERE"; // put your webhook here
const accounts = fs.readFileSync("./accounts.txt", "utf-8").split("\n").filter(Boolean);

async function fetchLastPost(username) {
  try {
    const url = `https://www.tiktok.com/@${username}?__a=1&__d=dis`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) return null;
    const data = await res.json();
    const posts = data?.props?.pageProps?.items;
    if (!posts || posts.length === 0) return null;

    const last = posts[0];
    return {
      url: `https://www.tiktok.com/@${username}/video/${last.id}`,
      views: last.stats.playCount,
      author: username
    };
  } catch (e) {
    console.error(`Error fetching ${username}:`, e.message);
    return null;
  }
}

async function main() {
  let results = [];

  for (const account of accounts) {
    const post = await fetchLastPost(account);
    if (post) results.push(post);
  }

  if (results.length === 0) {
    console.log("No posts found.");
    return;
  }

  // sort by views (desc)
  results.sort((a, b) => b.views - a.views);

  let description = results.map((p, i) => {
    return `${i + 1}. [Post Link](${p.url}) by @${p.author} — **${p.views.toLocaleString()} views**`;
  }).join("\n");

  const embed = {
    username: "Greenscreen AI",
    embeds: [
      {
        title: "Latest Posts (sorted by views)",
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
