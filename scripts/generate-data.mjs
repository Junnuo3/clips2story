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
const KEYWORDS_FILE = path.join(ROOT, "keywords.txt");

const GENRES = ["documentary", "film", "lecture", "news", "vlog"];

// Config for the live "Try it yourself" storyboard planner (assets/js/try-it-panel.js).
// plannerEndpoint points at the deployed Cloudflare Worker (see DEPLOYMENT.md); an
// unreachable endpoint degrades to the panel's own fallback message, it does not
// break the rest of the site.
const LIVE_DEMO_ENDPOINT = "https://clips2story-planner.clips2story-v2.workers.dev";
// Generic fallback only -- used if a video has neither plan_inputs-derived nor
// gallery-derived keywords (shouldn't normally happen; see buildVideoExampleKeywords).
const LIVE_DEMO_FALLBACK_KEYWORDS = ["central conflict", "key relationships", "turning point", "background context"];

// The live demo's target output is 30-60s (see assets/js/storyboard-editor.js /
// worker/src/index.js), so the retrieval pool only needs a couple minutes of
// candidate footage, not the paper's full 15-minute budget.
const LIVE_DEMO_POOL_DURATION_BUDGET_SEC = 150;

/** "04_extinction" -> "extinction", "05_human_dog_interaction" -> "human dog interaction". */
function toKeywordChip(rawKeyword) {
  return rawKeyword.replace(/^\d+_/, "").replace(/_/g, " ").trim().toLowerCase();
}

/**
 * Only documentary-2 has this: the original pipeline's keyword-extraction
 * stage proposed 5 candidate story topics for it (rag_stage1_pool_<mid|none>_
 * <NN>_<slug>.json in example/plan_inputs/, checked in from the one full
 * pipeline run this demo fork carries) -- only 2 of those 5 were ever fully
 * rendered into the public gallery. The other 3 are still good, real,
 * video-specific suggestions for the live demo, so surface all 5 here
 * instead of just the gallery's 2. Supports the same per-video nested dir
 * (example/<id>/plan_inputs/) for any future video precomputed the same way.
 */
function planInputsDirForVideo(id) {
  const nested = path.join(ROOT, "example", id, "plan_inputs");
  if (fs.existsSync(nested)) return nested;
  if (id === "documentary-2") {
    const legacy = path.join(ROOT, "example", "plan_inputs");
    if (fs.existsSync(legacy)) return legacy;
  }
  return null;
}

function extractPlanInputKeywords(dir) {
  if (!dir) return [];
  const re = /^rag_stage1_pool_(?:mid|none)_(\d+)_(.+)\.json$/;
  const bySeq = new Map(); // sequence number -> raw keyword slug, deduped across mid/none pool variants
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(re);
    if (m) bySeq.set(m[1], m[2]);
  }
  return [...bySeq.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, slug]) => toKeywordChip(slug));
}

/**
 * keywords.txt (repo root, plain text, one line per video) is a hand/HPC-
 * curated 5-keyword set covering every video -- format:
 *   <id>: keyword one, keyword two, keyword three, keyword four, keyword five
 * Kept as its own small checked-in file (not baked into this script) so
 * adding/editing a video's keywords later is a one-line text edit, not a
 * code change. Casing is preserved as written (proper nouns like "Chloe
 * Kim" stay capitalized) rather than force-lowercased like the other
 * sources below.
 */
function parseKeywordsFile() {
  if (!fs.existsSync(KEYWORDS_FILE)) return new Map();
  const byId = new Map();
  const lines = fs.readFileSync(KEYWORDS_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      console.warn(`[keywords.txt] skipping malformed line: ${trimmed}`);
      continue;
    }
    const id = trimmed.slice(0, sep).trim();
    const keywords = trimmed
      .slice(sep + 1)
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.length) byId.set(id, keywords);
  }
  return byId;
}

/**
 * Per-video suggested keyword chips for the live demo, richest source first:
 *   1. keywords.txt (5 curated keywords per video, covers every video today)
 *   2. plan_inputs-derived candidates (5, documentary-2 only, redundant with
 *      #1 now but kept as a fallback if keywords.txt ever loses a line)
 *   3. the gallery's own 2 keywords for that video (every video has these)
 *   4. the generic fallback list (should only trigger for a video with no
 *      gallery entry at all, e.g. a bundle added without genre/id folders)
 */
function buildVideoExampleKeywords(id, galleryKeywordsById, keywordsFileById) {
  const curated = keywordsFileById.get(id);
  if (curated && curated.length) return curated;
  const planInputKeywords = extractPlanInputKeywords(planInputsDirForVideo(id));
  if (planInputKeywords.length) return planInputKeywords;
  const galleryKeywords = galleryKeywordsById.get(id);
  if (galleryKeywords && galleryKeywords.length) return galleryKeywords;
  return LIVE_DEMO_FALLBACK_KEYWORDS;
}

/**
 * Every embeddings/<id>.json is produced by `npm run build:embeddings`
 * (scripts/export-embeddings.mjs) from a precomputed per-shot descriptor
 * bundle -- one file per live-demo video. Auto-discovering the video list
 * from whatever embeddings actually exist (rather than hand-maintaining a
 * parallel list here) means adding a video is just: precompute its bundle,
 * run `npm run build:embeddings`, then `npm run build:data` -- no code change.
 */
function discoverLiveDemoVideos(galleryKeywordsById, keywordsFileById) {
  const dir = path.join(ROOT, "embeddings");
  if (!fs.existsSync(dir)) return [];
  const videos = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (e) {
      console.warn(`[liveDemo] skipping embeddings/${file}: ${e.message}`);
      continue;
    }
    if (!payload.id || !payload.sourceVideo || !Array.isArray(payload.shots)) {
      console.warn(`[liveDemo] skipping embeddings/${file}: missing id/sourceVideo/shots`);
      continue;
    }
    videos.push({
      id: payload.id,
      genre: payload.id.replace(/-\d+$/, ""),
      label: payload.label || payload.id,
      sourceVideo: payload.sourceVideo,
      embeddings: `embeddings/${file}`,
      poolDurationBudgetSec: LIVE_DEMO_POOL_DURATION_BUDGET_SEC,
      exampleKeywords: buildVideoExampleKeywords(payload.id, galleryKeywordsById, keywordsFileById),
    });
  }
  videos.sort((a, b) => a.id.localeCompare(b.id));
  return videos;
}

function buildLiveDemo(galleryKeywordsById, keywordsFileById) {
  const videos = discoverLiveDemoVideos(galleryKeywordsById, keywordsFileById);
  return {
    enabled: videos.length > 0,
    plannerEndpoint: LIVE_DEMO_ENDPOINT,
    videos,
    exampleKeywords: LIVE_DEMO_FALLBACK_KEYWORDS,
  };
}

// For certain examples, use a local MP4 for the source video instead of YouTube.
// Keys are `${genre}/${id}` and values are filenames inside {genre}/{id}/.
// GitHub LFS rejects files > 2GB per object — keep local sources under that (compress if needed).
const SOURCE_LOCAL_OVERRIDES = {
  "documentary/1": "Mammal Origins ｜ Full Documentary ｜ NOVA ｜ PBS-23BGbVBxXdQ.mp4",
  "documentary/2": "Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
  "film/2": "The Little Shop of Horrors 1960 Full Movie HD 1080p.mp4",
  "vlog/1": "Attempting VEDA？ ｜ Meals, Planner Sticker Haul, Bathroom Organizing Project-n2YNMJShKKA.mp4",
  "film/1": "Cary Grant Romcom Full Movie ｜ His Girl Friday (1940) ｜ Retrospective-kmYcT5gT6a4.mp4",
  "lecture/1": "1. Introduction, Financial Terms and Concepts-wvXDB9dMdEo.mp4",
  "lecture/2": "Lecture： Mathematics of Big Data and Machine Learning-0sKPkJME2Jw.mp4",
  "news/1": "NBC Nightly News Full Episode - Feb. 13-tX80LkEqytg.mp4",
  "news/2": "This Morning’s Top Headlines – Feb. 13 ｜ Morning News NOW-fbgQG61Irvs.mp4",
  "vlog/2": "SILLY SMILING BABY PLAYTIME & HOUSE CLEANING FUN ｜ DITL Daily Vlog-Tn7CL9rL27I.mp4",
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

  const galleryKeywordsById = new Map();
  for (const genre of GENRES) {
    for (const ex of byGenre[genre]) {
      galleryKeywordsById.set(
        `${genre}-${ex.id}`,
        (ex.keywords || []).map((k) => toKeywordChip(k.keyword))
      );
    }
  }
  const keywordsFileById = parseKeywordsFile();

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
    liveDemo: buildLiveDemo(galleryKeywordsById, keywordsFileById),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUT_PATH}`);
}

main();
