#!/usr/bin/env node
/**
 * Parses demo_video_links.csv and local {genre}/{id}/ directories to produce data.json.
 * Anonymous demo page — no author metadata.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CSV_PATH = path.join(ROOT, "demo_video_links.csv");
const OUT_PATH = path.join(ROOT, "data.json");

const GENRES = ["documentary", "film", "lecture", "news", "vlog"];

// Config for the live "Try it yourself" storyboard planner (assets/js/try-it-panel.js).
// Keep the video list here in sync with DEMO_VIDEOS in scripts/export-embeddings.mjs --
// each entry needs a matching embeddings/<id>.json produced by `npm run build:embeddings`.
// plannerEndpoint points at the deployed Cloudflare Worker (see DEPLOYMENT.md); an
// unreachable endpoint degrades to the panel's own fallback message, it does not
// break the rest of the site.
const LIVE_DEMO = {
  enabled: true,
  plannerEndpoint: "https://clips2story-planner.clips2story-v2.workers.dev",
  videos: [
    {
      id: "documentary-2",
      genre: "documentary",
      label: "Documentary — Can Dogs Talk? (PBS NOVA)",
      sourceVideo:
        "documentary/2/Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
      embeddings: "embeddings/documentary-2.json",
      poolDurationBudgetSec: 480,
    },
  ],
  exampleKeywords: ["dog communication", "animal cognition", "button learning", "language study"],
};

// For certain examples, use a local MP4 for the source video instead of YouTube.
// Keys are `${genre}/${id}` and values are filenames inside {genre}/{id}/.
// GitHub LFS rejects files > 2GB per object — keep local sources under that (compress if needed).
const SOURCE_LOCAL_OVERRIDES = {
  "documentary/1": "Mammal Origins ｜ Full Documentary ｜ NOVA ｜ PBS-23BGbVBxXdQ.mp4",
  "documentary/2": "Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
  "film/2": "The Little Shop of Horrors 1960 Full Movie HD 1080p.mp4",
  "vlog/1": "Attempting VEDA？ ｜ Meals, Planner Sticker Haul, Bathroom Organizing Project-n2YNMJShKKA.mp4",
};

function isLocalSourcePath(link) {
  const t = (link || "").trim();
  return t.length > 0 && !/^https?:\/\//i.test(t) && t.endsWith(".mp4");
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  if (!header) return [];
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // genre,id,url — URL may contain commas in rare cases; split on first two commas
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    if (first === -1 || second === -1) continue;
    const genre = line.slice(0, first).trim();
    const id = line.slice(first + 1, second).trim();
    const youtube_link = line.slice(second + 1).trim();
    rows.push({ genre, id, youtube_link });
  }
  return rows;
}

function youtubeWatchToEmbed(watchUrl) {
  try {
    const u = new URL(watchUrl);
    let videoId = u.searchParams.get("v");
    if (!videoId && (u.hostname === "youtu.be" || u.hostname === "www.youtu.be")) {
      videoId = u.pathname.replace(/^\//, "").split("/")[0];
    }
    if (!videoId) return null;
    return `https://www.youtube.com/embed/${videoId}`;
  } catch {
    return null;
  }
}

function listMp4(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
}

function pickSingle(files, suffix) {
  const s = suffix.toLowerCase();
  const hits = files.filter((f) => f.toLowerCase().endsWith(s));
  if (hits.length === 0) return null;
  if (hits.length > 1) hits.sort((a, b) => a.localeCompare(b));
  return hits[0];
}

function buildExampleForDir(genre, idStr, youtubeEmbed) {
  const dir = path.join(ROOT, genre, idStr);
  const files = listMp4(dir);
  const nfFiles = files.filter((f) => f.endsWith("_no_narration.mp4"));

  // Each source video now has exactly 2 target keywords. We derive them from the
  // existing NF clips in the folder (current place where keywords live).
  const keywordClips = [];
  for (const nf of nfFiles) {
    const keyword = nf.replace(/_no_narration\.mp4$/i, "");
    const oursName = `${keyword}_ours.mp4`;
    if (!files.includes(oursName)) {
      console.warn(`[skip] ${dir}: missing ${oursName} for keyword "${keyword}"`);
      continue;
    }
    keywordClips.push({ keyword, nf, oursName });
  }

  keywordClips.sort((a, b) => a.keyword.localeCompare(b.keyword));
  if (keywordClips.length < 2) {
    console.warn(`[skip] ${dir}: expected >=2 keywords, found ${keywordClips.length}`);
    return null;
  }

  const selected = keywordClips.slice(0, 2);
  const base = `${genre}/${idStr}`;

  // These 3 outputs do not change based on keyword.
  const a2summName = pickSingle(files, "_a2summ.mp4");
  const teasergenName = pickSingle(files, "_teasergen.mp4");
  const regenName = pickSingle(files, "_regen.mp4");
  const fixed = {
    a2summ: a2summName ? `${base}/${a2summName}` : null,
    teasergen: teasergenName ? `${base}/${teasergenName}` : null,
    regen: regenName ? `${base}/${regenName}` : null,
  };
  for (const [k, v] of Object.entries(fixed)) {
    if (!v) console.warn(`[warn] ${dir}: missing fixed output ${k} (*${k}.mp4)`);
  }

  let sourceLocal = null;
  const override = SOURCE_LOCAL_OVERRIDES[`${genre}/${idStr}`];
  if (override) {
    if (files.includes(override)) sourceLocal = `${base}/${override}`;
    else console.warn(`[warn] ${dir}: missing sourceLocal override file (${override})`);
  }

  return {
    id: idStr,
    youtubeEmbed,
    sourceLocal,
    keywords: selected.map((s) => ({
      keyword: s.keyword,
      local: {
        nf: `${base}/${s.nf}`,
        ours: `${base}/${s.oursName}`,
      },
    })),
    fixed: {
      a2summ: fixed.a2summ,
      teasergen: fixed.teasergen,
      regen: fixed.regen,
    },
  };
}

function main() {
  const csvRaw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(csvRaw);

  const byGenre = {};
  for (const g of GENRES) byGenre[g] = [];

  for (const row of rows) {
    const { genre, id, youtube_link } = row;
    if (!GENRES.includes(genre)) {
      console.warn(`Unknown genre in CSV: ${genre}`);
      continue;
    }
    const idStr = String(id);
    let embed = youtubeWatchToEmbed(youtube_link);
    if (!embed) {
      const key = `${genre}/${idStr}`;
      if (SOURCE_LOCAL_OVERRIDES[key] || isLocalSourcePath(youtube_link)) {
        embed = null;
      } else {
        console.warn(`Could not parse YouTube URL for ${genre}/${id}`);
        continue;
      }
    }
    const ex = buildExampleForDir(genre, idStr, embed);
    if (ex) byGenre[genre].push(ex);
  }

  const payload = {
    projectTitle: "Clips2Story: Training-free Video Storyboarding and Editing using Multimodal Retrieval-Embedded Generation",
    abstractPlaceholder:
      "[Abstract text will appear here in the camera-ready version. This anonymous demo page is for double-blind review.]",
    pipeline: [
      "Multimodal retrieval aligns candidate clips with story intent without task-specific training.",
      "Embedded generation composes a coherent narrative structure from retrieved visual segments.",
      "The pipeline outputs editable storyboard timelines for comparison across baselines.",
    ],
    genres: GENRES.map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      sets: byGenre[id] || [],
    })),
    liveDemo: LIVE_DEMO,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUT_PATH}`);
}

main();
