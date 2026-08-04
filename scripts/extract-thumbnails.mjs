#!/usr/bin/env node
/**
 * Build-time thumbnail extraction for the live storyboard editor.
 *
 * Storyboard cards used to get their thumbnail by seeking a hidden <video>
 * into the full source file in the browser -- a real network fetch + decode
 * into a 100+MB remote video just to grab a few KB of pixels, once per card,
 * every time a storyboard is generated. Since live-demo segments are shot-
 * aligned, we can instead extract one small JPEG per shot here at build
 * time (its midpoint timestamp, from the same shots.json already used for
 * embeddings -- see scripts/lib/demo-videos.mjs) and serve that static file
 * instead. assets/js/storyboard-editor.js still falls back to the old
 * live-seek approach for any shot without a precomputed thumbnail.
 *
 * Output: example/<id>/thumbs/<shot_id>.jpg (256x144, ~2-6KB each -- small
 * enough that, unlike the source videos, these do NOT need Git LFS; see
 * .gitattributes).
 *
 * Requires ffmpeg on PATH. Resumable: skips any thumbnail that already
 * exists on disk, so re-running after adding a new video only processes
 * what's missing.
 *
 * Run: npm run build:thumbnails
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ROOT, readyVideos, readJson } from "./lib/demo-videos.mjs";

const execFileAsync = promisify(execFile);

const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 144;
const THUMB_JPEG_QUALITY = 4; // ffmpeg -q:v scale: 2 (best) .. 31 (worst)
const CONCURRENCY = 6; // parallel ffmpeg processes -- these are seek+decode-one-frame, not full transcodes

async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function extractOne(sourceAbsPath, midpointSec, outPath) {
  if (fs.existsSync(outPath)) return "skip";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      String(Math.max(0, midpointSec)),
      "-i",
      sourceAbsPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-vf",
      `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=increase,crop=${THUMB_WIDTH}:${THUMB_HEIGHT}`,
      "-q:v",
      String(THUMB_JPEG_QUALITY),
      outPath,
    ]);
    return "ok";
  } catch (err) {
    console.warn(`[warn] thumbnail extraction failed for ${outPath}: ${err.message.split("\n")[0]}`);
    return "fail";
  }
}

/** Runs `tasks` (each a () => Promise) with at most `limit` in flight at once. */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  if (!(await hasFfmpeg())) {
    console.error("ffmpeg not found on PATH -- install it (e.g. `brew install ffmpeg`) and re-run.");
    process.exit(1);
  }

  const ready = readyVideos();
  if (ready.length === 0) {
    console.error("No demo video has a precomputed descriptor bundle yet -- nothing to extract.");
    process.exit(1);
  }

  for (const { demo, paths } of ready) {
    const shots = readJson(paths.shots).filter((s) => s.video_id === demo.videoId);
    const sourceAbsPath = path.join(ROOT, demo.sourceVideo);
    if (!fs.existsSync(sourceAbsPath)) {
      console.warn(`[skip] ${demo.id}: source video not found at ${sourceAbsPath}`);
      continue;
    }
    const thumbsDir = path.join(ROOT, "example", demo.id, "thumbs");

    const tasks = shots.map((shot) => () => {
      const midpoint = (shot.start_time + shot.end_time) / 2;
      const outPath = path.join(thumbsDir, `${shot.shot_id}.jpg`);
      return extractOne(sourceAbsPath, midpoint, outPath);
    });

    console.log(`[${demo.id}] extracting up to ${tasks.length} thumbnails (${CONCURRENCY} in parallel)...`);
    const results = await runPool(tasks, CONCURRENCY);
    const counts = results.reduce((acc, r) => ((acc[r] = (acc[r] || 0) + 1), acc), {});
    console.log(
      `[${demo.id}] done: ${counts.ok || 0} extracted, ${counts.skip || 0} already present, ${counts.fail || 0} failed`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
