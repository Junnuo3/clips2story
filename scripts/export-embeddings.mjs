#!/usr/bin/env node
/**
 * Build-time embedding export for the live "Try it yourself" storyboard planner.
 *
 * Reads the per-shot multimodal descriptors already checked into example/ (the
 * same shots/captions/asr/entities/background JSON the home-panel walkthrough
 * uses) for one demo video, embeds each shot's retrieval text (transcript +
 * caption, matching the paper's "Keyword-based Clip Retrieval" method) with a
 * small sentence-embedding model, and writes the result to embeddings/<id>.json.
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

// One demo video is fully wired for now: documentary/2 ("Can Dogs Talk?"),
// the same video the existing home-panel pipeline walkthrough uses, since
// it's the only one with full per-shot example/ descriptors checked into
// this repo. Add more entries here once another video's example/ bundle is
// exported from the pipeline (see README "Adding another live demo video").
const DEMO_VIDEOS = [
  {
    id: "documentary-2",
    videoId: "v1",
    label: "Documentary — Can Dogs Talk? (PBS NOVA)",
    sourceVideo:
      "documentary/2/Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
    exampleDir: path.join(ROOT, "example"),
  },
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
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

  console.log(`Loading ${MODEL_ID} (first run downloads + caches the ONNX model)...`);
  const extractor = await pipeline("feature-extraction", MODEL_ID);

  for (const demo of DEMO_VIDEOS) {
    const shots = readJson(path.join(demo.exampleDir, "shots", "shots.json")).filter(
      (s) => s.video_id === demo.videoId
    );
    const captions = readJson(path.join(demo.exampleDir, "captions", "captions.json"));
    const asr = readJson(path.join(demo.exampleDir, "asr", "asr.json"));
    const entities = readJson(path.join(demo.exampleDir, "entities", "entities.json"));
    const background = readJson(path.join(demo.exampleDir, "background", "background.json"));

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
