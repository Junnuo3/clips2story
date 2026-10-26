#!/usr/bin/env node
/**
 * Build-time audio waveform extraction for the live storyboard preview.
 *
 * The preview (assets/js/sequence-preview.js) draws a waveform under its
 * clip timeline, colored per segment. Decoding audio in the browser would
 * mean downloading the whole 100+MB source video, so instead we reduce
 * each source's audio to a small peak envelope here, once, at build time.
 *
 * Output: example/<id>/waveform.json --
 *   { "peaksPerSec": 20, "peaks": "<base64>" }
 * where `peaks` decodes to one Uint8 (0-255) amplitude peak per
 * 1/peaksPerSec seconds of source time, normalized to that track's own
 * 99.5th-percentile peak (~85KB for an hour of audio). The preview just
 * hides the waveform row for any video without this file.
 *
 * Requires ffmpeg on PATH and the real source videos (not Git LFS pointer
 * stubs -- run `git lfs pull` first). Resumable: skips any video whose
 * waveform.json already exists.
 *
 * Run: npm run build:waveforms
 */
import fs from "fs";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { ROOT, readyVideos } from "./lib/demo-videos.mjs";

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 8000; // plenty for an amplitude envelope
const PEAKS_PER_SEC = 20;
const SAMPLES_PER_PEAK = SAMPLE_RATE / PEAKS_PER_SEC;
const NORMALIZE_PERCENTILE = 0.995; // so one loud spike doesn't flatten the rest

async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

function isLfsPointer(absPath) {
  if (fs.statSync(absPath).size > 1024) return false;
  return fs.readFileSync(absPath, "utf8").startsWith("version https://git-lfs");
}

/** Streams the source's audio through ffmpeg as mono s16le and keeps the max |sample| per window. */
function extractPeaks(sourceAbsPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "error",
      "-i", sourceAbsPath,
      "-vn",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "-",
    ]);
    const peaks = [];
    let windowMax = 0;
    let windowCount = 0;
    let carry = null; // odd trailing byte from the previous chunk
    let stderr = "";

    ff.stdout.on("data", (chunk) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > windowMax) windowMax = v;
        if (++windowCount === SAMPLES_PER_PEAK) {
          peaks.push(windowMax);
          windowMax = 0;
          windowCount = 0;
        }
      }
    });
    ff.stderr.on("data", (d) => (stderr += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split("\n")[0] || `ffmpeg exited ${code}`));
      if (windowCount > 0) peaks.push(windowMax);
      resolve(peaks);
    });
  });
}

function normalizePeaks(peaks) {
  const sorted = [...peaks].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * NORMALIZE_PERCENTILE)] || sorted[sorted.length - 1] || 1;
  return Uint8Array.from(peaks, (p) => Math.min(255, Math.round((p / ref) * 255)));
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

  for (const { demo } of ready) {
    const outPath = path.join(ROOT, "example", demo.id, "waveform.json");
    if (fs.existsSync(outPath)) {
      console.log(`[${demo.id}] waveform already present, skipping`);
      continue;
    }
    const sourceAbsPath = path.join(ROOT, demo.sourceVideo);
    if (!fs.existsSync(sourceAbsPath)) {
      console.warn(`[skip] ${demo.id}: source video not found at ${sourceAbsPath}`);
      continue;
    }
    if (isLfsPointer(sourceAbsPath)) {
      console.warn(`[skip] ${demo.id}: source is a Git LFS pointer -- run \`git lfs pull\` first`);
      continue;
    }

    console.log(`[${demo.id}] extracting waveform...`);
    try {
      const peaks = normalizePeaks(await extractPeaks(sourceAbsPath));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify({ peaksPerSec: PEAKS_PER_SEC, peaks: Buffer.from(peaks).toString("base64") })
      );
      console.log(`[${demo.id}] done: ${peaks.length} peaks (${(peaks.length / PEAKS_PER_SEC / 60).toFixed(1)} min)`);
    } catch (err) {
      console.warn(`[warn] ${demo.id}: waveform extraction failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
