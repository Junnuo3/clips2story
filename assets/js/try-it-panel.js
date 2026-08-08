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
import { el, createDetails, createProgressBar, setVideoMp4FromRepoPath } from "./dom-helpers.js";
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
    "space-y-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5 shadow-xl shadow-black/20"
  );
  root.appendChild(
    el("h2", "text-lg font-semibold text-white sm:text-xl", "Try it yourself — live storyboard planner")
  );
  root.appendChild(
    el(
      "p",
      "max-w-4xl text-sm leading-relaxed text-slate-300",
      "Pick a video, type a theme, and Clips2Story-NF drafts a real storyboard from matching footage. " +
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
  const activeCls = ["border-cyan-500/60", "bg-cyan-500/10", "text-cyan-200"];
  for (const v of liveDemo.videos) {
    const btn = el(
      "button",
      "rounded-lg border border-surface-border px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5",
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
    "w-full max-w-xl overflow-hidden rounded-lg border border-surface-border/80 bg-black shadow-inner"
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

  // --- keyword input + example chips ---
  const inputRow = el("div", "flex flex-wrap gap-2");
  const input = document.createElement("input");
  input.type = "text";
  input.className =
    "min-w-[240px] flex-1 rounded-lg border border-surface-border bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500";
  input.addEventListener("focus", () => preloadEmbeddingModel(), { once: true });
  const submitBtn = el(
    "button",
    "rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400 disabled:opacity-50",
    "Generate storyboard"
  );
  inputRow.appendChild(input);
  inputRow.appendChild(submitBtn);

  // Suggested keywords (and the input placeholder example) are per-video
  // (each source video has its own real extracted/gallery keywords -- see
  // scripts/generate-data.mjs), so both re-render every time the video
  // picker selection changes instead of showing one fixed global example.
  const chipsRow = el("div", "flex flex-wrap gap-2");
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

    const keywords = (video.exampleKeywords && video.exampleKeywords.length
      ? video.exampleKeywords
      : liveDemo.exampleKeywords) || [];

    input.placeholder = keywords.length
      ? `Type a theme, e.g. "${keywords[0]}"`
      : "Type a theme, e.g. a topic or keyword";

    chipsRow.innerHTML = "";
    for (const kw of keywords) {
      const chip = el(
        "button",
        "rounded-full border border-surface-border/70 px-3 py-1 text-xs text-slate-400 hover:bg-white/5",
        kw
      );
      chip.addEventListener("click", () => {
        input.value = kw;
        input.focus();
      });
      chipsRow.appendChild(chip);
    }
  }
  onVideoSelected(selectedVideo);

  const statusEl = el("p", "text-sm text-slate-400", "");
  const genProgress = createProgressBar();
  genProgress.el.classList.add("hidden");
  const resultWrap = el("div", "hidden space-y-4");

  root.appendChild(videoLabel);
  root.appendChild(videoRow);
  root.appendChild(previewWrap);
  root.appendChild(inputRow);
  root.appendChild(chipsRow);
  root.appendChild(statusEl);
  root.appendChild(genProgress.el);
  root.appendChild(resultWrap);
  container.appendChild(root);

  function setStatus(msg, tone = "info") {
    statusEl.textContent = msg;
    statusEl.className = "text-sm " + (tone === "error" ? "text-amber-300" : "text-slate-400");
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
        "rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200",
        `Live planning is temporarily unavailable. Browse the "${video.genre}" page in the sidebar for ` +
          "precomputed Clips2Story-NF/-ND examples on this and other source videos, or try again in a moment."
      )
    );
  }

  async function handleSubmit() {
    const keyword = input.value.trim();
    if (!keyword) {
      setStatus("Type a keyword first.", "error");
      return;
    }
    const video = selectedVideo;
    submitBtn.disabled = true;
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
      renderResult(video, keyword, data, pool, index.shots);
    } catch (err) {
      const reason = err.name === "AbortError" ? "the request timed out" : err.message;
      showFallback(video, `Live planning is temporarily unavailable (${reason}).`);
    } finally {
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener("click", handleSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSubmit();
  });

  function renderResult(video, keyword, data, pool, shots) {
    resultWrap.innerHTML = "";
    resultWrap.classList.remove("hidden");
    resultWrap.appendChild(
      el(
        "p",
        "text-sm font-semibold text-cyan-200",
        `Clips2Story-NF storyboard — generated live for "${keyword}" just now`
      )
    );

    const renderStatus = el("p", "hidden text-xs text-slate-400");
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
      shots,
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
            "inline-block rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20",
            "⬇ Download MP4"
          );
          link.href = url;
          link.download = `clips2story-nf-${keyword.replace(/\s+/g, "-").toLowerCase()}.mp4`;
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
        const box = el("div", "max-h-72 space-y-1 overflow-y-auto text-xs text-slate-300");
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
          "whitespace-pre-wrap break-words rounded-lg border border-surface-border/70 bg-black/30 p-3 text-xs leading-relaxed text-slate-200";
        pre.textContent = data.prompt;
        return pre;
      })(),
    });

    const rawDetails = createDetails({
      title: "Raw LLM JSON response",
      content: (() => {
        const pre = document.createElement("pre");
        pre.className =
          "whitespace-pre-wrap break-words rounded-lg border border-surface-border/70 bg-black/30 p-3 text-xs leading-relaxed text-slate-200";
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
            const box = el("div", "space-y-1 text-xs text-slate-300");
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
