/**
 * Renders the reviewer's (possibly edited) storyboard into a single,
 * real, downloadable MP4 -- entirely in the browser, via ffmpeg.wasm.
 *
 * Why client-side: frame-accurate cuts need ffmpeg's filter_complex
 * trim/atrim + re-encode, not the fast keyframe-aligned concat demuxer (see
 * ../../FRAME_ACCURATE_RENDERING_FIX.md for why the naive approach loses
 * seconds of accuracy across many segments). That normally means a real
 * server process with ffmpeg installed -- but this project has no
 * always-on host available (see docs/design-plan.md), so the same
 * trim-filter *approach* runs as a browser-side ffmpeg.wasm reimplementation
 * instead. It is NOT a call into src/pipeline/renderer.py's
 * render_from_timeline() -- say so plainly in the UI, don't imply literal
 * code reuse.
 *
 * Known limitation: this demo's one wired video (documentary/2) has no
 * separate per-clip media files -- its "clips" are timestamp ranges within
 * one long source video (example/shots/shots.json). Rendering therefore
 * downloads that whole source file into the browser before trimming it,
 * which is fine for a short demo video but does not scale to a
 * multi-hundred-MB feature-length source. MAX_SOURCE_BYTES below turns
 * that into an explicit, user-facing failure (caught by try-it-panel.js,
 * which falls back to the free "Preview cut" instead) rather than a
 * silent hang or an out-of-memory crash. See README "Known limitations."
 */
import { resolveMediaPath } from "./dom-helpers.js";

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.6";
const FFMPEG_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
const FFMPEG_CDN_URL = `${FFMPEG_BASE_URL}/index.js`;
const UTIL_CDN_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js`;
const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

// Browsers commonly cap a wasm instance's linear memory around ~2-4GB;
// leave generous headroom since ffmpeg.wasm holds decoded frames too.
const MAX_SOURCE_BYTES = 300 * 1024 * 1024; // 300MB per distinct source file

let ffmpegPromise = null;

// FFmpeg.load()'s default worker.js itself has relative imports ("./const.js",
// "./errors.js"). A blob: URL has no path for those to resolve against, so
// naively blobifying worker.js's raw text loads a worker that dies on its own
// import statements. Rewrite those specifiers to absolute CDN URLs first.
async function blobURLForWorker() {
  const res = await fetch(`${FFMPEG_BASE_URL}/worker.js`);
  const src = await res.text();
  const rewritten = src.replace(
    /from\s*(["'])\.\/([\w.-]+)\1/g,
    (_m, q, name) => `from ${q}${FFMPEG_BASE_URL}/${name}${q}`
  );
  return URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
}

async function getFfmpeg(onLog) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import(FFMPEG_CDN_URL),
        import(UTIL_CDN_URL),
      ]);
      const ffmpeg = new FFmpeg();
      if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
      // FFmpeg.load() does `new Worker(new URL("./worker.js", import.meta.url))`
      // internally, i.e. a Worker constructed directly from the jsDelivr CDN URL.
      // Browsers refuse to construct a Worker from a cross-origin script URL no
      // matter what CORS headers the CDN sends, so without the blob-URL
      // indirection below (same trick as coreURL/wasmURL) this throws
      // "Failed to construct 'Worker': ... cannot be accessed from origin ...".
      await ffmpeg.load({
        classWorkerURL: await blobURLForWorker(),
        coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/** Pre-warm the ~25-30MB ffmpeg.wasm core download so it's cached before
 *  the reviewer's first "Render final video" click. */
export function preloadFfmpeg() {
  getFfmpeg().catch(() => {});
}

async function checkSizeOk(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 0 && len > MAX_SOURCE_BYTES) {
      throw new Error(
        `Source file is ${(len / 1024 / 1024).toFixed(0)}MB, over the ${(
          MAX_SOURCE_BYTES /
          1024 /
          1024
        ).toFixed(0)}MB browser-rendering limit for this demo.`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("browser-rendering limit")) throw err;
    // HEAD not supported / network hiccup -- don't block on a best-effort check.
  }
}

async function fetchAsUint8Array(url) {
  await checkSizeOk(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Render an ordered list of segments into a single MP4.
 * @param {Array<{sourcePath:string,startTime:number,endTime:number}>} segments
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<Blob>} an MP4 blob, ready to download or preview
 */
export async function renderStoryboard(segments, onProgress) {
  if (!segments || segments.length === 0) throw new Error("No segments to render.");
  const report = (m) => onProgress && onProgress(m);

  report("Loading ffmpeg.wasm (first use only, ~25–30MB)…");
  const ffmpeg = await getFfmpeg(report);

  const uniqueSources = [...new Set(segments.map((s) => s.sourcePath))];
  const inputByPath = new Map();
  for (let i = 0; i < uniqueSources.length; i++) {
    const src = uniqueSources[i];
    const name = `in${i}.mp4`;
    report(`Fetching source clip ${i + 1} of ${uniqueSources.length}…`);
    const bytes = await fetchAsUint8Array(resolveMediaPath(src));
    await ffmpeg.writeFile(name, bytes);
    inputByPath.set(src, { name, index: i });
  }

  const filterParts = [];
  const vLabels = [];
  const aLabels = [];
  segments.forEach((seg, i) => {
    const { index } = inputByPath.get(seg.sourcePath);
    const dur = Math.max(0.01, seg.endTime - seg.startTime);
    filterParts.push(
      `[${index}:v]trim=start=${seg.startTime}:duration=${dur},setpts=PTS-STARTPTS[v${i}]`
    );
    filterParts.push(
      `[${index}:a]atrim=start=${seg.startTime}:duration=${dur},asetpts=PTS-STARTPTS[a${i}]`
    );
    vLabels.push(`[v${i}]`);
    aLabels.push(`[a${i}]`);
  });
  filterParts.push(`${vLabels.join("")}concat=n=${segments.length}:v=1:a=0[outv]`);
  filterParts.push(`${aLabels.join("")}concat=n=${segments.length}:v=0:a=1[outa]`);

  const args = [];
  for (const { name } of inputByPath.values()) args.push("-i", name);
  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "out.mp4"
  );

  report(`Rendering ${segments.length} segment${segments.length === 1 ? "" : "s"} (re-encoding, this can take a minute or two)…`);
  await ffmpeg.exec(args);

  const data = await ffmpeg.readFile("out.mp4");
  report("Done.");
  return new Blob([data.buffer], { type: "video/mp4" });
}
