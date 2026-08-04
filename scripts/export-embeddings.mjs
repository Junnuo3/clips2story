#!/usr/bin/env node
/**
 * Build-time embedding export for the live "Try it yourself" storyboard planner.
 *
 * Reads the per-shot multimodal descriptors checked into example/ (the same
 * shots/captions/asr/entities/background JSON the home-panel walkthrough
 * uses) for each demo video in DEMO_VIDEOS (scripts/lib/demo-videos.mjs),
 * embeds each shot's retrieval text (transcript + caption, matching the
 * paper's "Keyword-based Clip Retrieval" method) with a small
 * sentence-embedding model, and writes the result to embeddings/<id>.json --
 * one file per video, auto-discovered by scripts/generate-data.mjs at
 * data.json build time.
 *
 * Videos in DEMO_VIDEOS whose descriptor bundle hasn't been precomputed yet
 * are skipped with a warning, not a hard failure -- run this any time after
 * dropping in a new bundle and it picks up whatever is ready. See also
 * scripts/extract-thumbnails.mjs, the sibling build step that turns the same
 * per-video shot list into per-shot thumbnail JPEGs.
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
import { pipeline } from "@huggingface/transformers";
import { ROOT, readyVideos, readJson } from "./lib/demo-videos.mjs";

const OUT_DIR = path.join(ROOT, "embeddings");

// Model shared between this build script and the browser (assets/js/semantic-search.js).
// Keep these in sync — retrieval only works if the query and the corpus are
// embedded with the identical model.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

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

  const ready = readyVideos();
  if (ready.length === 0) {
    console.error("No demo video has a precomputed descriptor bundle yet -- nothing to embed.");
    process.exit(1);
  }

  console.log(`Loading ${MODEL_ID} (first run downloads + caches the ONNX model)...`);
  const extractor = await pipeline("feature-extraction", MODEL_ID);

  for (const { demo, paths } of ready) {
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
