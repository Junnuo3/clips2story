/**
 * "Try it yourself" -- the live storyboard planner panel mounted at the top
 * of the Home page. Orchestrates the other modules in this directory:
 *
 *   1. semantic-search.js  -- client-side retrieval (no server call)
 *   2. one fetch() to the Cloudflare Worker -- the only network call that
 *      needs a backend, because it's the only step that needs a secret key
 *   3. storyboard-editor.js -- the editable result (the actual centerpiece)
 *   4. render-ffmpeg.js     -- in-browser "Render final video"
 *
 * See docs/design-plan.md for the full design rationale.
 */
import { el, createDetails, createProgressBar, resolveMediaPath, setVideoMp4FromRepoPath } from "./dom-helpers.js";
import { embedQuery, loadEmbeddingIndex, retrievePool, preloadEmbeddingModel } from "./semantic-search.js";
import { createStoryboardEditor } from "./storyboard-editor.js";
import { renderStoryboard } from "./render-ffmpeg.js";

const PLANNING_TIMEOUT_MS = 45000;

export function mountTryItPanel(container, liveDemo) {
  if (!liveDemo || liveDemo.enabled === false || !(liveDemo.videos || []).length) {
    return; // Live demo disabled/unconfigured -- the rest of the site works fine without it.
  }

  const root = el(
    "div",
    "space-y-4 rounded-2xl border border-blue-200 bg-blue-50/60 p-5 shadow-xl shadow-slate-900/5"
  );
  root.appendChild(
    el("h2", "text-lg font-semibold text-slate-900 sm:text-xl", "Try it yourself — live storyboard planner")
  );
  root.appendChild(
    el(
      "p",
      "max-w-4xl text-sm leading-relaxed text-slate-700",
      "Pick a video, then choose or type a theme keyword, and Clips2Story-NF drafts a real storyboard from its matching clips. " +
        "Reorder, remove, or swap clips, then render a downloadable video."
    )
  );

  // --- video picker ---
  const videoLabel = el(
    "p",
    "text-xs font-medium uppercase tracking-wide text-slate-500",
    `Source video (${liveDemo.videos.length} available)`
  );
  const videoRow = el("div", "flex flex-wrap gap-2");
  let selectedVideo = liveDemo.videos[0];
  const videoButtons = [];
  const activeCls = ["border-blue-500", "bg-blue-50", "text-blue-700"];
  for (const v of liveDemo.videos) {
    const btn = el(
      "button",
      "rounded-lg border border-surface-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50",
      v.label
    );
    btn.addEventListener("click", () => {
      selectedVideo = v;
      for (const { el: b } of videoButtons) b.classList.remove(...activeCls);
      btn.classList.add(...activeCls);
      onVideoSelected(v);
    });
    videoButtons.push({ el: btn, v });
    videoRow.appendChild(btn);
  }
  if (videoButtons[0]) videoButtons[0].el.classList.add(...activeCls);

  // Shows the actual selected source video -- reviewers pick a keyword blind
  // to what footage they're drawing from otherwise. preload="metadata" only
  // (not the full file) until they actually press play. This preview is
  // display-only: storyboard generation/rendering always reads video.sourceVideo
  // (the local file), never this element, since ffmpeg.wasm needs real bytes.
  const previewWrap = el(
    "div",
    "order-1 w-full self-start overflow-hidden rounded-xl border border-surface-border/80 bg-black shadow-inner lg:order-2"
  );
  const previewVideo = document.createElement("video");
  previewVideo.className = "aspect-video w-full object-contain";
  previewVideo.controls = true;
  previewVideo.muted = true;
  previewVideo.playsInline = true;
  previewVideo.preload = "metadata";

  // A handful of source videos still have a working YouTube embed (checked
  // against the oembed endpoint -- see LIVE_DEMO_YOUTUBE_PREVIEW_IDS in
  // scripts/generate-data.mjs); for those, prefer the YouTube player over the
  // local file for this preview so reviewers see it exactly as it's credited.
  const previewFrame = document.createElement("iframe");
  previewFrame.className = "hidden aspect-video w-full";
  previewFrame.title = "Source video preview";
  previewFrame.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  previewFrame.referrerPolicy = "strict-origin-when-cross-origin";
  previewFrame.allowFullscreen = true;
  previewWrap.appendChild(previewVideo);
  previewWrap.appendChild(previewFrame);

  // --- clip grid ---
  // The source video's shots, as the precomputed per-shot thumbnails from
  // scripts/extract-thumbnails.mjs -- these clips (not the long video) are
  // what retrieval and the planner actually work with. The shot list comes
  // from the same embedding index retrieval uses, so loading it here also
  // warms that cache for "Generate storyboard". Clicking a clip seeks the
  // preview to it; while the local preview plays, the current clip is
  // outlined; after retrieval, the retrieved pool is checked.
  const clipsPanel = el(
    "div",
    "order-2 rounded-xl border border-surface-border bg-surface-raised lg:order-1 lg:relative"
  );
  const clipsInner = el("div", "flex flex-col lg:absolute lg:inset-0");
  const clipsHeader = el(
    "div",
    "flex items-baseline justify-between gap-3 border-b border-surface-border/70 px-4 py-2.5"
  );
  clipsHeader.appendChild(
    el("p", "text-xs font-medium uppercase tracking-wide text-slate-500", "Clips from this video")
  );
  const clipsCount = el("p", "truncate text-xs text-slate-500", "");
  clipsHeader.appendChild(clipsCount);
  const clipsScroll = el(
    "div",
    "relative max-h-80 overflow-y-auto p-3 scrollbar-thin lg:max-h-none lg:min-h-0 lg:flex-1"
  );
  const clipsGrid = el("div", "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4");
  clipsScroll.appendChild(clipsGrid);
  clipsInner.appendChild(clipsHeader);
  clipsInner.appendChild(clipsScroll);
  clipsPanel.appendChild(clipsInner);

  // Per-video grid state; rebuilt from scratch on every video switch.
  let gridVideoId = null;
  let gridShots = []; // sorted by start_time
  let gridTiles = []; // parallel to gridShots
  let gridLoadToken = 0;
  let activeTileIdx = -1;

  function formatTimestamp(sec) {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  function setActiveTile(i) {
    if (i === activeTileIdx) return;
    if (gridTiles[activeTileIdx]) gridTiles[activeTileIdx].tile.classList.remove("outline", "outline-amber-400");
    activeTileIdx = i;
    if (gridTiles[i]) gridTiles[i].tile.classList.add("outline", "outline-amber-400");
  }

  /** Index of the shot containing time `t` (binary search over gridShots), or -1. */
  function shotIndexAt(t) {
    let lo = 0;
    let hi = gridShots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = gridShots[mid];
      if (t < s.start_time) hi = mid - 1;
      else if (t >= s.end_time) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function seekPreviewTo(video, startSec) {
    if (video.youtubeId) {
      previewFrame.src =
        `https://www.youtube-nocookie.com/embed/${video.youtubeId}` +
        `?start=${Math.floor(startSec)}&autoplay=1&mute=1`;
      return;
    }
    const seek = () => {
      previewVideo.currentTime = startSec;
      previewVideo.play().catch(() => {});
    };
    if (previewVideo.readyState >= 1) seek();
    else previewVideo.addEventListener("loadedmetadata", seek, { once: true });
  }

  previewVideo.addEventListener("timeupdate", () => {
    if (gridShots.length) setActiveTile(shotIndexAt(previewVideo.currentTime));
  });

  async function loadClipGrid(video) {
    const token = ++gridLoadToken;
    gridVideoId = null;
    gridShots = [];
    gridTiles = [];
    activeTileIdx = -1;
    clipsGrid.innerHTML = "";
    clipsScroll.scrollTop = 0;
    clipsCount.textContent = "Loading…";

    let index;
    try {
      index = await loadEmbeddingIndex(video.embeddings);
    } catch {
      if (token !== gridLoadToken) return;
      clipsCount.textContent = "Couldn't load clips";
      return;
    }
    if (token !== gridLoadToken) return; // switched videos while loading

    gridVideoId = video.id;
    gridShots = [...index.shots].sort((a, b) => a.start_time - b.start_time);
    clipsCount.textContent = `${gridShots.length} clips`;

    const frag = document.createDocumentFragment();
    gridShots.forEach((shot, i) => {
      const tile = el(
        "button",
        "group relative block aspect-video overflow-hidden rounded-md bg-slate-200 outline-2 outline-offset-2 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500"
      );
      tile.type = "button";
      tile.title =
        `${formatTimestamp(shot.start_time)}–${formatTimestamp(shot.end_time)}` +
        (shot.caption ? ` · ${shot.caption}` : "");

      const img = document.createElement("img");
      img.className = "h-full w-full object-cover transition-transform duration-200 group-hover:scale-105";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => img.remove(); // no precomputed thumbnail for this shot -- leave the grey box
      img.src = resolveMediaPath(`example/${video.id}/thumbs/${shot.shot_id}.jpg`);
      tile.appendChild(img);

      tile.appendChild(
        el(
          "span",
          "absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] font-medium tabular-nums text-white",
          formatTimestamp(shot.start_time)
        )
      );
      const check = el(
        "span",
        "absolute right-1 top-1 hidden h-4 w-4 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white shadow",
        "✓"
      );
      tile.appendChild(check);

      tile.addEventListener("click", () => {
        setActiveTile(i);
        seekPreviewTo(video, shot.start_time);
      });
      gridTiles.push({ tile, check, shotId: shot.shot_id });
      frag.appendChild(tile);
    });
    clipsGrid.appendChild(frag);
  }

  /** Check the retrieved pool's clips (and dim the rest), or clear with pool = null. */
  function markRetrieved(video, pool, keyword) {
    if (gridVideoId !== video.id) return;
    const ids = pool ? new Set(pool.map((c) => c.shotId)) : null;
    let first = null;
    for (const { tile, check, shotId } of gridTiles) {
      const hit = ids ? ids.has(shotId) : false;
      check.classList.toggle("hidden", !hit);
      check.classList.toggle("flex", hit);
      tile.classList.toggle("ring-2", hit);
      tile.classList.toggle("ring-blue-500", hit);
      tile.classList.toggle("opacity-40", !!ids && !hit);
      if (hit && !first) first = tile;
    }
    clipsCount.textContent = ids
      ? `${ids.size} of ${gridShots.length} retrieved for “${keyword}”`
      : `${gridShots.length} clips`;
    if (first) clipsScroll.scrollTo({ top: Math.max(0, first.offsetTop - 12), behavior: "smooth" });
  }

  // --- keyword picker ---
  // Visitors either pick one of the selected video's curated keywords
  // (keywords.txt, via scripts/generate-data.mjs) or type their own -- the
  // chips just fill the text input, which is the single source of truth.
  // The chips re-render every time the video picker selection changes, and
  // switching videos clears the input.
  const keywordCard = el("div", "space-y-3 rounded-xl border border-surface-border bg-surface-raised p-4");
  const keywordLabel = el("p", "text-center text-sm font-medium uppercase tracking-wide text-slate-900", "Theme keyword");
  const keywordHint = el("p", "text-center text-xs text-slate-500", "Pick a suggestion or type your own");
  const chipsRow = el("div", "flex flex-wrap justify-center gap-2");
  const keywordForm = el("form", "mx-auto flex w-full max-w-2xl flex-col gap-2 sm:flex-row");
  const keywordInput = document.createElement("input");
  keywordInput.type = "text";
  keywordInput.maxLength = 200; // matches the worker's keyword length limit
  keywordInput.placeholder = "Type your own keyword…";
  keywordInput.setAttribute("aria-label", "Theme keyword");
  keywordInput.className =
    "min-w-0 flex-1 rounded-lg border border-surface-border bg-white px-3 py-2.5 text-base text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";
  const submitBtn = el(
    "button",
    "shrink-0 rounded-lg bg-blue-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50",
    "Generate storyboard"
  );
  submitBtn.type = "submit";
  submitBtn.disabled = true;
  keywordForm.appendChild(keywordInput);
  keywordForm.appendChild(submitBtn);
  keywordCard.appendChild(keywordLabel);
  keywordCard.appendChild(keywordHint);
  keywordCard.appendChild(chipsRow);
  keywordCard.appendChild(keywordForm);

  let generating = false;
  let chips = [];
  function syncKeywordUI() {
    const kw = keywordInput.value.trim().toLowerCase();
    submitBtn.disabled = generating || !kw;
    for (const { chip, kw: chipKw } of chips) {
      chip.classList.toggle("border-blue-500", chipKw.toLowerCase() === kw);
      chip.classList.toggle("bg-blue-50", chipKw.toLowerCase() === kw);
      chip.classList.toggle("text-blue-700", chipKw.toLowerCase() === kw);
    }
  }
  keywordInput.addEventListener("input", syncKeywordUI);
  keywordInput.addEventListener("focus", () => preloadEmbeddingModel(), { once: true });

  function onVideoSelected(video) {
    if (video.youtubeId) {
      previewVideo.classList.add("hidden");
      previewVideo.removeAttribute("src");
      previewVideo.load();
      previewFrame.classList.remove("hidden");
      previewFrame.src = `https://www.youtube-nocookie.com/embed/${video.youtubeId}`;
    } else {
      previewFrame.classList.add("hidden");
      previewFrame.src = "";
      previewVideo.classList.remove("hidden");
      setVideoMp4FromRepoPath(previewVideo, video.sourceVideo);
    }
    loadClipGrid(video);

    const keywords = (video.exampleKeywords && video.exampleKeywords.length
      ? video.exampleKeywords
      : liveDemo.exampleKeywords) || [];

    keywordInput.value = "";
    chipsRow.innerHTML = "";
    chips = [];
    for (const kw of keywords) {
      const chip = el(
        "button",
        "rounded-full border border-surface-border/70 px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50",
        kw.charAt(0).toUpperCase() + kw.slice(1)
      );
      chip.type = "button";
      chip.addEventListener("click", () => {
        preloadEmbeddingModel();
        keywordInput.value = kw;
        syncKeywordUI();
      });
      chips.push({ chip, kw });
      chipsRow.appendChild(chip);
    }
    syncKeywordUI();
  }
  onVideoSelected(selectedVideo);

  const workspace = el("div", "grid gap-4 lg:grid-cols-2");
  workspace.appendChild(clipsPanel);
  workspace.appendChild(previewWrap);

  const statusEl = el("p", "text-sm text-slate-600", "");
  const genProgress = createProgressBar();
  genProgress.el.classList.add("hidden");
  const resultWrap = el("div", "hidden space-y-4");

  root.appendChild(videoLabel);
  root.appendChild(videoRow);
  root.appendChild(workspace);
  root.appendChild(keywordCard);
  root.appendChild(statusEl);
  root.appendChild(genProgress.el);
  root.appendChild(resultWrap);
  container.appendChild(root);

  function setStatus(msg, tone = "info") {
    statusEl.textContent = msg;
    statusEl.className = "text-sm " + (tone === "error" ? "text-amber-700" : "text-slate-600");
  }

  const GEN_STEPS = { embed: 15, retrieve: 40, plan: 90, ready: 100 };
  function setGenStep(step, { pulse = false } = {}) {
    genProgress.el.classList.remove("hidden");
    genProgress.set(GEN_STEPS[step], { pulse });
  }
  function hideGenProgress() {
    genProgress.reset();
    genProgress.el.classList.add("hidden");
  }

  function showFallback(video, message) {
    hideGenProgress();
    setStatus(message, "error");
    resultWrap.innerHTML = "";
    resultWrap.classList.remove("hidden");
    resultWrap.appendChild(
      el(
        "div",
        "rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800",
        `Live planning is temporarily unavailable. Browse the "${video.genre}" page in the sidebar for ` +
          "precomputed Clips2Story-NF/-ND examples on this and other source videos, or try again in a moment."
      )
    );
  }

  async function handleSubmit() {
    const keyword = keywordInput.value.trim();
    if (!keyword) {
      setStatus("Pick or type a keyword first.", "error");
      return;
    }
    const video = selectedVideo;
    generating = true;
    syncKeywordUI();
    markRetrieved(video, null);
    resultWrap.classList.add("hidden");
    resultWrap.innerHTML = "";

    try {
      setStatus("Embedding your keyword…");
      setGenStep("embed", { pulse: true });
      const [index, queryEmbedding] = await Promise.all([
        loadEmbeddingIndex(video.embeddings),
        embedQuery(keyword),
      ]);

      setStatus("Retrieving relevant clips…");
      setGenStep("retrieve", { pulse: true });
      const { pool } = retrievePool(index, queryEmbedding, {
        maxDurationSec: video.poolDurationBudgetSec || 480,
      });
      if (pool.length === 0) throw new Error("no candidate clips retrieved");
      markRetrieved(video, pool, keyword);

      setStatus("Planning storyboard with the LLM…");
      setGenStep("plan", { pulse: true });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PLANNING_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(liveDemo.plannerEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword, pool, videoId: video.id }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `planner returned ${res.status}`);
      }
      const data = await res.json();
      if (!data.segments || data.segments.length === 0) throw new Error("planner returned no segments");

      const droppedNote =
        data.dropped && data.dropped.length
          ? ` (${data.dropped.length} clip${data.dropped.length === 1 ? "" : "s"} the model proposed didn't pass validation and ${
              data.dropped.length === 1 ? "was" : "were"
            } skipped.)`
          : "";
      setGenStep("ready");
      setStatus(
        (data.cached
          ? "Ready — served from cache (someone already tried this keyword recently)."
          : "Ready.") + droppedNote
      );
      hideGenProgress();
      renderResult(video, keyword, data, pool);
    } catch (err) {
      const reason = err.name === "AbortError" ? "the request timed out" : err.message;
      showFallback(video, `Live planning is temporarily unavailable (${reason}).`);
    } finally {
      generating = false;
      syncKeywordUI();
    }
  }

  keywordForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!submitBtn.disabled) handleSubmit();
  });

  function renderResult(video, keyword, data, pool) {
    resultWrap.innerHTML = "";
    resultWrap.classList.remove("hidden");
    resultWrap.appendChild(
      el(
        "p",
        "text-sm font-semibold text-blue-700",
        `Clips2Story-NF storyboard — generated live for "${keyword}" just now`
      )
    );

    const renderStatus = el("p", "hidden text-xs text-slate-600");
    const renderProgress = createProgressBar();
    renderProgress.el.classList.add("hidden");
    const renderOutputBox = el("div", "hidden space-y-2");

    // Rough target percentage per render phase -- ffmpeg.wasm doesn't expose
    // byte-level progress for the load/fetch phases, so these are stepped
    // approximations (same idea as the generation progress bar above),
    // enough to show forward motion during the ~minute-plus wait.
    function renderProgressForMessage(msg) {
      if (msg.startsWith("Loading ffmpeg.wasm")) return { pct: 10, pulse: true };
      const fetchMatch = msg.match(/^Fetching source clip (\d+) of (\d+)/);
      if (fetchMatch) {
        const [, i, n] = fetchMatch.map(Number);
        return { pct: 15 + (i / n) * 25, pulse: true };
      }
      if (msg.startsWith("Rendering")) return { pct: 75, pulse: true };
      if (msg === "Done.") return { pct: 100, pulse: false };
      return null;
    }

    const editorBox = el("div");
    const editor = createStoryboardEditor({
      container: editorBox,
      segments: data.segments,
      pool,
      waveformPath: `example/${video.id}/waveform.json`,
      onRender: async (segments) => {
        renderStatus.classList.remove("hidden");
        renderProgress.el.classList.remove("hidden");
        renderProgress.set(0);
        renderOutputBox.classList.add("hidden");
        renderOutputBox.innerHTML = "";
        try {
          const blob = await renderStoryboard(segments, (msg) => {
            renderStatus.textContent = msg;
            const p = renderProgressForMessage(msg);
            if (p) renderProgress.set(p.pct, { pulse: p.pulse });
          });
          const url = URL.createObjectURL(blob);
          const outVideo = document.createElement("video");
          outVideo.className =
            "w-full max-w-xl rounded-lg border border-surface-border bg-black aspect-video object-contain";
          outVideo.controls = true;
          outVideo.src = url;
          const link = el(
            "a",
            "inline-block rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-200",
            "⬇ Download MP4"
          );
          link.href = url;
          link.download = `clips2story-nf-${keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`;
          renderOutputBox.classList.remove("hidden");
          renderOutputBox.appendChild(outVideo);
          renderOutputBox.appendChild(link);
          renderProgress.el.classList.add("hidden");
          renderStatus.classList.add("hidden");
          renderStatus.textContent = "";
        } catch (err) {
          renderProgress.el.classList.add("hidden");
          renderStatus.textContent = `Rendering unavailable right now (${err.message}) — edit the storyboard and try again.`;
        }
      },
    });

    const poolDetails = createDetails({
      title: "Retrieved clip pool",
      subtitle: `${pool.length} candidate clips retrieved for this keyword`,
      content: (() => {
        const box = el("div", "max-h-72 space-y-1 overflow-y-auto text-xs text-slate-700");
        for (const c of pool) {
          box.appendChild(
            el(
              "p",
              "border-b border-surface-border/40 py-1",
              `${c.duration.toFixed(1)}s · ${c.caption || "(no caption)"}`
            )
          );
        }
        return box;
      })(),
    });

    const promptDetails = createDetails({
      title: "Exact prompt sent to the LLM",
      content: (() => {
        const pre = document.createElement("pre");
        pre.className =
          "whitespace-pre-wrap break-words rounded-lg border border-surface-border/70 bg-slate-50 p-3 text-xs leading-relaxed text-slate-800";
        pre.textContent = data.prompt;
        return pre;
      })(),
    });

    const rawDetails = createDetails({
      title: "Raw LLM JSON response",
      content: (() => {
        const pre = document.createElement("pre");
        pre.className =
          "whitespace-pre-wrap break-words rounded-lg border border-surface-border/70 bg-slate-50 p-3 text-xs leading-relaxed text-slate-800";
        pre.textContent = JSON.stringify(data.rawLlmOutput, null, 2);
        return pre;
      })(),
    });

    resultWrap.appendChild(editorBox);
    resultWrap.appendChild(renderStatus);
    resultWrap.appendChild(renderProgress.el);
    resultWrap.appendChild(renderOutputBox);

    if (data.dropped && data.dropped.length) {
      resultWrap.appendChild(
        createDetails({
          title: `Segments skipped by validation (${data.dropped.length})`,
          subtitle: "Proposed by the model but rejected -- unknown clip_id or an out-of-bounds trim -- and left out rather than failing the whole plan.",
          content: (() => {
            const box = el("div", "space-y-1 text-xs text-slate-700");
            for (const d of data.dropped) {
              box.appendChild(el("p", "border-b border-surface-border/40 py-1", `${d.clipId} · ${d.reason}`));
            }
            return box;
          })(),
        })
      );
    }

    resultWrap.appendChild(poolDetails);
    resultWrap.appendChild(promptDetails);
    resultWrap.appendChild(rawDetails);
  }
}
