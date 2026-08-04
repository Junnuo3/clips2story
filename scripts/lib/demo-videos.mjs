/**
 * Shared live-demo video registry + descriptor-bundle lookup, used by both
 * scripts/export-embeddings.mjs (shot embeddings) and
 * scripts/extract-thumbnails.mjs (per-shot keyframe JPEGs) so the two build
 * steps agree on exactly which videos are candidates and where their
 * shots/captions/asr/entities/background bundle lives.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

// Every entry here is a *candidate* live-demo video, not a guarantee -- callers
// skip (with a clear message) any entry whose example/ descriptor bundle
// hasn't been precomputed yet. documentary-2 is the only one fully wired
// today (its bundle is checked into example/, the same descriptors the
// home-panel pipeline walkthrough uses). The rest point at videos that
// already have a local source file in this repo (a hard requirement for the
// ffmpeg.wasm renderer, which downloads sourceVideo directly -- see
// render-ffmpeg.js) and are ready to go once their shot-level descriptor
// bundle is precomputed and dropped at exampleDir -- see README "Adding
// another live demo video".
export const DEMO_VIDEOS = [
  {
    id: "documentary-2",
    videoId: "v1",
    label: "Documentary — Can Dogs Talk? (PBS NOVA)",
    sourceVideo:
      "documentary/2/Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
    exampleDir: path.join(ROOT, "example"),
  },
  {
    id: "documentary-1",
    videoId: "v1",
    label: "Documentary — Mammal Origins (PBS NOVA)",
    sourceVideo:
      "documentary/1/Mammal Origins ｜ Full Documentary ｜ NOVA ｜ PBS-23BGbVBxXdQ.mp4",
    exampleDir: path.join(ROOT, "example", "documentary-1"),
  },
  {
    id: "film-2",
    videoId: "v1",
    label: "Film — The Little Shop of Horrors (1960)",
    sourceVideo: "film/2/The Little Shop of Horrors 1960 Full Movie HD 1080p.mp4",
    exampleDir: path.join(ROOT, "example", "film-2"),
  },
  {
    id: "vlog-1",
    videoId: "v1",
    label: "Vlog — Attempting VEDA (Sticker Haul & Organizing)",
    sourceVideo:
      "vlog/1/Attempting VEDA？ ｜ Meals, Planner Sticker Haul, Bathroom Organizing Project-n2YNMJShKKA.mp4",
    exampleDir: path.join(ROOT, "example", "vlog-1"),
  },
  {
    id: "film-1",
    videoId: "v1",
    label: "Film — His Girl Friday (1940)",
    sourceVideo:
      "film/1/Cary Grant Romcom Full Movie ｜ His Girl Friday (1940) ｜ Retrospective-kmYcT5gT6a4.mp4",
    exampleDir: path.join(ROOT, "example", "film-1"),
  },
  {
    id: "lecture-1",
    videoId: "v1",
    label: "Lecture — Financial Terms and Concepts",
    sourceVideo: "lecture/1/1. Introduction, Financial Terms and Concepts-wvXDB9dMdEo.mp4",
    exampleDir: path.join(ROOT, "example", "lecture-1"),
  },
  {
    id: "lecture-2",
    videoId: "v1",
    label: "Lecture — Mathematics of Big Data and Machine Learning",
    sourceVideo:
      "lecture/2/Lecture： Mathematics of Big Data and Machine Learning-0sKPkJME2Jw.mp4",
    exampleDir: path.join(ROOT, "example", "lecture-2"),
  },
  {
    id: "news-1",
    videoId: "v1",
    label: "News — NBC Nightly News, Feb. 13",
    sourceVideo: "news/1/NBC Nightly News Full Episode - Feb. 13-tX80LkEqytg.mp4",
    exampleDir: path.join(ROOT, "example", "news-1"),
  },
  {
    id: "news-2",
    videoId: "v1",
    label: "News — Morning News NOW, Feb. 13",
    sourceVideo:
      "news/2/This Morning’s Top Headlines – Feb. 13 ｜ Morning News NOW-fbgQG61Irvs.mp4",
    exampleDir: path.join(ROOT, "example", "news-2"),
  },
  {
    id: "vlog-2",
    videoId: "v1",
    label: "Vlog — Silly Smiling Baby Playtime & House Cleaning",
    sourceVideo:
      "vlog/2/SILLY SMILING BABY PLAYTIME & HOUSE CLEANING FUN ｜ DITL Daily Vlog-Tn7CL9rL27I.mp4",
    exampleDir: path.join(ROOT, "example", "vlog-2"),
  },
];

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Descriptor bundles can live in either layout:
 *   - nested (the original documentary-2 layout): <exampleDir>/shots/shots.json
 *   - flat (new per-video bundles): <exampleDir>/shots.json
 * Returns null (not a throw) when neither exists, so callers can skip an
 * unprecomputed video with a clear message instead of crashing the whole run.
 */
export function findBundleFile(exampleDir, name) {
  const nested = path.join(exampleDir, name, `${name}.json`);
  if (fs.existsSync(nested)) return nested;
  const flat = path.join(exampleDir, `${name}.json`);
  if (fs.existsSync(flat)) return flat;
  return null;
}

/** Locates all 5 descriptor files for a demo video, or returns null + logs what's missing. */
export function findDescriptorPaths(demo) {
  const names = ["shots", "captions", "asr", "entities", "background"];
  const paths = {};
  const missing = [];
  for (const name of names) {
    const p = findBundleFile(demo.exampleDir, name);
    if (!p) missing.push(`${name}.json`);
    else paths[name] = p;
  }
  if (missing.length) {
    console.warn(
      `[skip] ${demo.id}: no precomputed descriptor bundle yet (missing ${missing.join(", ")} ` +
        `under ${demo.exampleDir}). Run the shot detection + multimodal metadata pipeline ` +
        `(src/pipeline/ in the main research repo) on its source video and drop the output there, ` +
        `then re-run this script -- see README "Adding another live demo video".`
    );
    return null;
  }
  return paths;
}

/** DEMO_VIDEOS entries whose descriptor bundle is actually present, paired with its paths. */
export function readyVideos() {
  const pathsByDemo = new Map(DEMO_VIDEOS.map((demo) => [demo, findDescriptorPaths(demo)]));
  return DEMO_VIDEOS.filter((demo) => pathsByDemo.get(demo) !== null).map((demo) => ({
    demo,
    paths: pathsByDemo.get(demo),
  }));
}
