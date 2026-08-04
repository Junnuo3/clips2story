#!/usr/bin/env node
/**
 * Build-time embedding export for the live "Try it yourself" storyboard planner.
 *
 * Reads the per-shot multimodal descriptors checked into example/ (the same
 * shots/captions/asr/entities/background JSON the home-panel walkthrough
 * uses) for each demo video in DEMO_VIDEOS below, embeds each shot's
 * retrieval text (transcript + caption, matching the paper's "Keyword-based
 * Clip Retrieval" method) with a small sentence-embedding model, and writes
 * the result to embeddings/<id>.json -- one file per video, auto-discovered
 * by scripts/generate-data.mjs at data.json build time.
 *
 * Videos in DEMO_VIDEOS whose descriptor bundle hasn't been precomputed yet
 * are skipped with a warning, not a hard failure -- run this any time after
 * dropping in a new bundle and it picks up whatever is ready.
 *
 * The browser embeds the reviewer's typed keyword with the SAME model at
 * request time (assets/js/semantic-search.js) so retrieval never needs a
 * network call: cosine similarity between two already-normalized vectors is
 * just a dot product, computed entirely client-side.
 *
 * Run: npm run build:embeddings
 * (downloads the ~30MB ONNX model from the Hugging Face hub on first run and
 * caches it locally; needs outbound internet access once, not at demo time.)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "@huggingface/transformers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "embeddings");

// Model shared between this build script and the browser (assets/js/semantic-search.js).
// Keep these in sync — retrieval only works if the query and the corpus are
// embedded with the identical model.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Every entry here is a *candidate* live-demo video, not a guarantee -- main()
// skips (with a clear message) any entry whose example/ descriptor bundle
// hasn't been precomputed yet. documentary-2 is the only one fully wired
// today (its bundle is checked into example/, the same descriptors the
// home-panel pipeline walkthrough uses). The other three point at the
// videos that already have a local source file in this repo (a hard
// requirement for the ffmpeg.wasm renderer, which downloads sourceVideo
// directly -- see render-ffmpeg.js) and are ready to go as soon as their
// shot-level descriptor bundle is precomputed with the pipeline
// (`src/pipeline/` in the main research repo) and dropped at exampleDir --
// see README "Adding another live demo video".
const DEMO_VIDEOS = [
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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Descriptor bundles can live in either layout:
 *   - nested (the original documentary-2 layout): <exampleDir>/shots/shots.json
 *   - flat (new per-video bundles): <exampleDir>/shots.json
 * Returns null (not a throw) when neither exists, so main() can skip an
 * unprecomputed video with a clear message instead of crashing the whole run.
 */
function findBundleFile(exampleDir, name) {
  const nested = path.join(exampleDir, name, `${name}.json`);
  if (fs.existsSync(nested)) return nested;
  const flat = path.join(exampleDir, `${name}.json`);
  if (fs.existsSync(flat)) return flat;
  return null;
}

/** Locates all 5 descriptor files for a demo video, or returns null + logs what's missing. */
function findDescriptorPaths(demo) {
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

/** Mirrors make_asr_timestamps_relative + speaker-labeled join in
 *  src/pipeline/planner_llm_no_narration.py, so live-generated prompts look
 *  like the ones the actual pipeline produces (see example/prompt/*.txt). */
function buildTranscript(asrSegments, shotStart) {
  if (!asrSegments || asrSegments.length === 0) return "";
  return asrSegments
    .map((seg) => {
      const relStart = Math.max(0, seg.start - shotStart);
      const relEnd = Math.max(0, seg.end - shotStart);
      const speaker = seg.speaker ? `[${seg.speaker}] ` : "";
      return `[${relStart.toFixed(2)}s-${relEnd.toFixed(2)}s] ${speaker}${seg.text}`;
    })
    .join(" | ");
}

function buildShotDescriptor(shot, captions, asr, entities, background) {
  const id = shot.shot_id;
  const caption = captions[id]?.[0]?.caption || "";
  const transcript = buildTranscript(asr[id], shot.start_time);
  const entityNames = (entities[id]?.[0]?.entities || [])
    .map((e) => e.name)
    .filter(Boolean);
  const backgroundLabel = background[id]?.[0]?.background?.label || "unknown";
  const duration = Math.max(0, shot.end_time - shot.start_time);

  return {
    shot_id: id,
    start_time: shot.start_time,
    end_time: shot.end_time,
    duration,
    caption,
    transcript,
    entities: entityNames,
    background: backgroundLabel,
    // Retrieval text follows the paper's Method section exactly:
    // "cosine similarity between ... the keyword and each clip's
    // concatenated transcript and caption."
    retrievalText: `${transcript} ${caption}`.trim(),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pathsByDemo = new Map(DEMO_VIDEOS.map((demo) => [demo, findDescriptorPaths(demo)]));
  const ready = DEMO_VIDEOS.filter((demo) => pathsByDemo.get(demo) !== null);
  if (ready.length === 0) {
    console.error("No demo video has a precomputed descriptor bundle yet -- nothing to embed.");
    process.exit(1);
  }

  console.log(`Loading ${MODEL_ID} (first run downloads + caches the ONNX model)...`);
  const extractor = await pipeline("feature-extraction", MODEL_ID);

  for (const demo of ready) {
    const paths = pathsByDemo.get(demo);
    const shots = readJson(paths.shots).filter((s) => s.video_id === demo.videoId);
    const captions = readJson(paths.captions);
    const asr = readJson(paths.asr);
    const entities = readJson(paths.entities);
    const background = readJson(paths.background);

    const descriptors = shots.map((s) =>
      buildShotDescriptor(s, captions, asr, entities, background)
    );

    console.log(`[${demo.id}] embedding ${descriptors.length} shots...`);
    const texts = descriptors.map((d) => d.retrievalText || d.caption || "(no description)");

    // Batched rather than one big extractor(texts) call: this HPC login node
    // kills processes that spike CPU/memory (embedding all 695 texts in one
    // ONNX Runtime call did that). Small batches keep peak memory low and
    // print progress along the way.
    const BATCH_SIZE = 16;
    let dim = null;
    const embeddings = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const [n, d] = output.dims;
      dim = d;
      for (let i = 0; i < n; i++) {
        embeddings.push(Array.from(output.data.slice(i * d, (i + 1) * d)));
      }
      console.log(`[${demo.id}]   ${Math.min(start + BATCH_SIZE, texts.length)}/${texts.length}`);
    }

    const payload = {
      id: demo.id,
      label: demo.label,
      sourceVideo: demo.sourceVideo,
      model: MODEL_ID,
      dim,
      shots: descriptors.map((d, i) => ({ ...d, embedding: embeddings[i] })),
    };

    const outPath = path.join(OUT_DIR, `${demo.id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
    console.log(`[${demo.id}] wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
