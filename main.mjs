import fs from "fs";
import fetch from "node-fetch";
import { Client, GatewayIntentBits } from "discord.js";

// Read TikTok accounts from accounts.txt
const accounts = fs.readFileSync("accounts.txt", "utf-8")
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean);

// Discord setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Helper to extract last video link
async function getLastPostLink(username) {
  try {
    const res = await fetch(`https://www.tiktok.com/@${username}`);
    const html = await res.text();

    // Extract JSON data inside <script id="SIGI_STATE">
    const match = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/);
    if (!match) return null;

    const data = JSON.parse(match[1]);

    // Navigate JSON to get last post
    const videos = data.ItemList?.["user-post"]?.list || [];
    if (!videos.length) return null;

    const lastVideoId = videos[0]; // first = latest
    return `https://www.tiktok.com/@${username}/video/${lastVideoId}`;
  } catch (err) {
    console.error(`Error fetching ${username}:`, err.message);
    return null;
  }
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  let messages = ["**Latest TikTok Posts**\n"];

  for (const account of accounts) {
    const link = await getLastPostLink(account);
    if (link) {
      messages.push(`🔗 [${account}](${link})`);
    } else {
      messages.push(`⚠️ Could not fetch last post for **${account}**`);
    }
  }

  const channel = await client.channels.fetch(CHANNEL_ID);
  await channel.send(messages.join("\n"));

  console.log("✅ Sent latest posts to Discord.");
  process.exit(0);
});

client.login(DISCORD_TOKEN);
