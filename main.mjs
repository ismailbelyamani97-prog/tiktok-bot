// test-detect.mjs
import fs from "fs/promises";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchMirror(url) {
  const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(proxied, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US" }
  });
  if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
  return res.text();
}

function extractSIGI(html) {
  const m = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1].slice(0, 500) : null;
}

function extractLDVideo(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) return null;
  return blocks[0][1].slice(0, 500);
}

function sniffNumbers(html) {
  const regexes = [
    /"playCount"\s*:\s*"?([\d,.KMB]+)"?/i,
    /"diggCount"\s*:\s*"?([\d,.KMB]+)"?/i,
    /([\d,.KMB]+)\s*(?:views|plays)/i,
    /([\d,.KMB]+)\s*likes?/i
  ];
  let out = [];
  for (const r of regexes) {
    const m = html.match(r);
    if (m) out.push(`${r}: ...${m[0]}...`);
  }
  return out.slice(0, 5).join("\n");
}

async function runOne(handle) {
  console.log(`\n=== Testing @${handle} ===`);

  const profHTML = await fetchMirror(`https://www.tiktok.com/@${handle}`);
  const vidId = (profHTML.match(/\/video\/(\d{8,})/)||[])[1];
  if (!vidId) {
    console.log("No videoId found in profile.");
    return;
  }
  console.log("VideoID:", vidId);

  const vidHTML = await fetchMirror(`https://www.tiktok.com/@${handle}/video/${vidId}`);
  
  console.log("SIGI found?", !!extractSIGI(vidHTML));
  if (extractSIGI(vidHTML)) console.log("SIGI snippet:", extractSIGI(vidHTML));

  console.log("LD+JSON found?", !!extractLDVideo(vidHTML));
  if (extractLDVideo(vidHTML)) console.log("LD snippet:", extractLDVideo(vidHTML));

  const sniff = sniffNumbers(vidHTML);
  console.log("Regex sniff:", sniff || "(none)");

  await fs.writeFile(`debug-${handle}.html`, vidHTML);
  console.log(`Full HTML saved to debug-${handle}.html (check locally)`);
}

// run against handles listed in accounts.txt
const raw = await fs.readFile("accounts.txt","utf8");
const handles = raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,3); // first 3
for (const h of handles) {
  await runOne(h);
  await sleep(500);
}
