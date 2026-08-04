/**
 * Client-side keyword retrieval for the live storyboard planner.
 *
 * Embeds the reviewer's typed keyword with the same small sentence-embedding
 * model used to precompute embeddings/<id>.json at build time
 * (scripts/export-embeddings.mjs), then ranks candidate shots by cosine
 * similarity. Runs entirely in the browser after the one-time model + index
 * download -- no server involved in retrieval at all, live or otherwise.
 *
 * Keep MODEL_ID in sync with scripts/export-embeddings.mjs: retrieval only
 * makes sense if the query and the corpus are embedded with the same model.
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const TRANSFORMERS_CDN_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_CDN_URL).then(({ pipeline }) =>
      pipeline("feature-extraction", MODEL_ID)
    );
  }
  return extractorPromise;
}

/** Pre-warm the model download so the first real query doesn't pay for it. */
export function preloadEmbeddingModel() {
  getExtractor().catch(() => {
    // Swallowed here; the real error surfaces on the next embedQuery() call,
    // which the caller already handles as part of the planning flow.
  });
}

export async function embedQuery(text) {
  const extractor = await getExtractor();
  const output = await extractor([text], { pooling: "mean", normalize: true });
  const [, dim] = output.dims;
  return Array.from(output.data.slice(0, dim));
}

const indexCache = new Map();
export async function loadEmbeddingIndex(embeddingsPath) {
  if (indexCache.has(embeddingsPath)) return indexCache.get(embeddingsPath);
  const promise = fetch(embeddingsPath, { cache: "force-cache" }).then((res) => {
    if (!res.ok) throw new Error(`Failed to load ${embeddingsPath} (${res.status})`);
    return res.json();
  });
  indexCache.set(embeddingsPath, promise);
  try {
    return await promise;
  } catch (err) {
    indexCache.delete(embeddingsPath);
    throw err;
  }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Small stable hash -> masked clip id, mirroring the real pipeline's
 * clip-pool "mask_ids" behavior (src/pipeline/clip_pool.py): the LLM only
 * ever sees opaque clip_id strings, never shot_id/order, so it can't infer
 * original chronology from list position or naming.
 */
function maskedClipId(shotId) {
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < shotId.length; i++) {
    h ^= shotId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `c_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Rank shots by cosine similarity to the query embedding and take the
 * highest-scoring ones up to a duration budget, mirroring "Keyword-based
 * Clip Retrieval" (paper Method section): "The highest-scoring clips, up to
 * a total duration of 15 minutes, form the planning pool." The demo uses a
 * smaller default budget so the live LLM call stays fast.
 */
export function retrievePool(
  index,
  queryEmbedding,
  { maxDurationSec = 480, maxClips = 60 } = {}
) {
  const scored = index.shots.map((shot) => ({
    shot,
    score: dot(shot.embedding, queryEmbedding),
  }));
  scored.sort((a, b) => b.score - a.score);

  const pool = [];
  let totalDuration = 0;
  for (const { shot, score } of scored) {
    if (pool.length >= maxClips) break;
    if (pool.length > 0 && totalDuration + shot.duration > maxDurationSec) break;
    pool.push({
      clipId: maskedClipId(shot.shot_id),
      shotId: shot.shot_id,
      sourcePath: index.sourceVideo,
      startTime: shot.start_time,
      endTime: shot.end_time,
      duration: shot.duration,
      caption: shot.caption,
      transcript: shot.transcript,
      entities: shot.entities,
      background: shot.background,
      score,
    });
    totalDuration += shot.duration;
  }
  return { pool, totalDuration };
}
