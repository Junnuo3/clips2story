/**
 * Live preview for the storyboard editor: plays the current (edited)
 * segment list back-to-back straight out of the source video(s), with a
 * clip timeline and audio waveform underneath. There's no render step, so
 * every reorder / swap / remove in the editor shows up here immediately --
 * render-ffmpeg.js is still what produces the downloadable file.
 *
 * Playback double-buffers two <video> elements: while one plays segment i,
 * the other is already seeked to segment i+1's start, so a cut to a
 * far-away part of a long source doesn't stall on a byte-range fetch at
 * every boundary. Contiguous segments (the next one starts where this one
 * ends, same source) just keep playing on the same element.
 */
import { el, resolveMediaPath, setVideoMp4FromRepoPath } from "./dom-helpers.js";

// requestAnimationFrame granularity: treat a segment as finished this close
// to its end so a cut never shows a frame or two of the next shot.
const BOUNDARY_EPS = 0.04;
// Two segments closer than this (same source) play through without a cut.
const CONTIGUOUS_EPS = 0.05;

const WAVE_BAR_PX = 2;
const WAVE_GAP_PX = 1;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function segDuration(seg) {
  return seg.endTime - seg.startTime;
}

function isContiguous(a, b) {
  return !!a && !!b && a.sourcePath === b.sourcePath && Math.abs(b.startTime - a.endTime) < CONTIGUOUS_EPS;
}

/**
 * Precomputed per-video peaks (scripts/extract-waveforms.mjs). Cached per
 * path as a promise; resolves to null if the file isn't there (the
 * waveform row is just hidden then).
 */
const waveformCache = new Map();
function loadWaveform(waveformPath) {
  if (!waveformPath) return Promise.resolve(null);
  if (waveformCache.has(waveformPath)) return waveformCache.get(waveformPath);
  const promise = fetch(waveformPath, { cache: "force-cache" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !data.peaks || !data.peaksPerSec) return null;
      const bin = atob(data.peaks);
      const peaks = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) peaks[i] = bin.charCodeAt(i);
      return { peaksPerSec: data.peaksPerSec, peaks };
    })
    .catch(() => null);
  waveformCache.set(waveformPath, promise);
  return promise;
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {(seg: Object) => string} opts.colorFor - hex color for a segment (shared with the editor's cards)
 * @param {(seg: Object, onReady: (url: string|null) => void) => void} opts.thumbFor - thumbnail loader
 * @param {string} [opts.waveformPath] - example/<id>/waveform.json for the source video
 * @param {(index: number) => void} [opts.onActiveChange] - the playing segment changed
 */
export function createSequencePreview({ container, colorFor, thumbFor, waveformPath, onActiveChange }) {
  let segs = [];
  let starts = []; // sequence-time offset of each segment
  let total = 0;
  let idx = 0;
  let playing = false;
  let raf = null;
  let muted = false;
  let waveform = null;

  const root = el("div", "space-y-3");

  // --- stage ---
  const stage = el("div", "relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-inner");
  const vids = [0, 1].map(() => {
    const v = document.createElement("video");
    v.className = "absolute inset-0 h-full w-full object-contain";
    v.playsInline = true;
    v.preload = "auto";
    v.style.opacity = "0";
    stage.appendChild(v);
    return v;
  });
  const overlay = el(
    "div",
    "absolute inset-0 hidden items-center justify-center p-6 text-center text-sm text-slate-300"
  );
  stage.appendChild(overlay);
  const bigPlay = el(
    "button",
    "absolute inset-0 flex items-center justify-center text-5xl text-white/90 transition-opacity hover:text-white",
    "▶"
  );
  bigPlay.type = "button";
  bigPlay.setAttribute("aria-label", "Play storyboard preview");
  stage.appendChild(bigPlay);
  const loadingEl = el(
    "div",
    "pointer-events-none absolute bottom-3 left-3 hidden rounded-md bg-black/60 px-2 py-1 text-xs text-white",
    "Loading video…"
  );
  stage.appendChild(loadingEl);

  let cur = 0; // which element is on screen
  const cued = [null, null]; // segment each element is positioned for
  const pendingSeek = [null, null]; // seek to apply once that element's metadata loads

  vids.forEach((v, slot) => {
    v.addEventListener("loadedmetadata", () => {
      if (pendingSeek[slot] != null) {
        v.currentTime = pendingSeek[slot];
        pendingSeek[slot] = null;
      }
    });
    // Decode errors land here; a failed *load* fires on the <source> child
    // instead (see cue()).
    v.addEventListener("error", () => onLoadError(v.dataset.src));
    v.addEventListener("waiting", () => {
      if (slot === cur && playing) loadingEl.classList.remove("hidden");
    });
    v.addEventListener("playing", () => {
      if (slot === cur) loadingEl.classList.add("hidden");
    });
  });

  // --- controls ---
  const controls = el("div", "flex items-center gap-3 text-xs text-slate-600");
  const playBtn = el(
    "button",
    "w-20 whitespace-nowrap rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40",
    "▶ Play"
  );
  playBtn.type = "button";
  const timeLabel = el("span", "tabular-nums", "0:00 / 0:00");
  const clipLabel = el("span", "ml-auto truncate text-slate-500", "");
  const muteBtn = el(
    "button",
    "rounded-lg border border-surface-border px-2 py-1 text-xs text-slate-700 hover:bg-slate-50",
    "🔊"
  );
  muteBtn.type = "button";
  muteBtn.setAttribute("aria-label", "Mute");
  controls.appendChild(playBtn);
  controls.appendChild(timeLabel);
  controls.appendChild(clipLabel);
  controls.appendChild(muteBtn);

  // --- timeline: clip blocks + waveform, both scaled to sequence time ---
  const timeline = el("div", "relative cursor-pointer select-none touch-none space-y-1");
  const blocks = el("div", "relative h-14 w-full");
  const waveCanvas = document.createElement("canvas");
  waveCanvas.className = "hidden h-10 w-full";
  const playhead = el(
    "div",
    "pointer-events-none absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded-full bg-slate-900"
  );
  timeline.appendChild(blocks);
  timeline.appendChild(waveCanvas);
  timeline.appendChild(playhead);

  root.appendChild(stage);
  root.appendChild(controls);
  root.appendChild(timeline);
  container.appendChild(root);

  function showOverlay(msg) {
    overlay.textContent = msg;
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
    bigPlay.classList.add("hidden");
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
  }

  const loadErrors = new Map(); // sourcePath -> overlay message
  function onLoadError(sourcePath) {
    if (!sourcePath || loadErrors.has(sourcePath)) return;
    loadErrors.set(sourcePath, "Preview unavailable — the source video couldn't be loaded.");
    showLoadErrorIfCurrent();
    // The usual local cause: a Git LFS pointer stub served in place of the
    // real file (a ZIP download, or a clone without `git lfs pull`). Say so.
    fetch(resolveMediaPath(sourcePath), { headers: { Range: "bytes=0-99" } })
      .then((res) => res.text())
      .then((text) => {
        if (!text.startsWith("version https://git-lfs")) return;
        loadErrors.set(
          sourcePath,
          "Preview unavailable — this source video is a Git LFS pointer file, not the real video. " +
            "Run `git lfs pull` (or copy the real .mp4 into place) and reload."
        );
        showLoadErrorIfCurrent();
      })
      .catch(() => {});
  }
  function showLoadErrorIfCurrent() {
    const seg = segs[idx];
    if (!seg || !loadErrors.has(seg.sourcePath)) return false;
    pause();
    showOverlay(loadErrors.get(seg.sourcePath));
    return true;
  }

  function show(slot) {
    vids[slot].style.opacity = "1";
    vids[1 - slot].style.opacity = "0";
  }

  /** Position element `slot` at `offset` seconds into `seg`. */
  function cue(slot, seg, offset = 0) {
    const v = vids[slot];
    const t = seg.startTime + offset;
    cued[slot] = seg;
    if (v.dataset.src !== seg.sourcePath) {
      v.dataset.src = seg.sourcePath;
      pendingSeek[slot] = t;
      setVideoMp4FromRepoPath(v, seg.sourcePath);
      const source = v.querySelector("source");
      if (source) source.addEventListener("error", () => onLoadError(seg.sourcePath), { once: true });
    } else if (v.readyState >= 1) {
      pendingSeek[slot] = null;
      v.currentTime = t;
    } else {
      pendingSeek[slot] = t;
    }
  }

  /** Pre-position the off-screen element at the next segment, unless playback will just run into it. */
  function cueStandby() {
    const next = segs[idx + 1];
    if (!next || isContiguous(segs[idx], next)) return;
    if (cued[1 - cur] !== next) cue(1 - cur, next);
  }

  function currentOffset() {
    const seg = segs[idx];
    if (!seg) return 0;
    return clamp(vids[cur].currentTime - seg.startTime, 0, segDuration(seg));
  }

  function sequenceTime() {
    return segs.length ? starts[idx] + currentOffset() : 0;
  }

  function goTo(i, offset = 0) {
    vids[1 - cur].pause();
    idx = i;
    cue(cur, segs[i], offset);
    show(cur);
    if (playing) vids[cur].play().catch(() => {});
    cueStandby();
    onActive();
  }

  function advance() {
    const next = idx + 1;
    if (next >= segs.length) {
      pause();
      goTo(0, 0);
      return;
    }
    const b = segs[next];
    if (isContiguous(segs[idx], b)) {
      cued[cur] = b;
      idx = next;
    } else {
      if (cued[1 - cur] !== b) cue(1 - cur, b);
      vids[cur].pause();
      cur = 1 - cur;
      idx = next;
      show(cur);
      vids[cur].play().catch(() => {});
    }
    cueStandby();
    onActive();
  }

  function tick() {
    if (!playing) return;
    const v = vids[cur];
    const seg = segs[idx];
    if (seg && (v.currentTime >= seg.endTime - BOUNDARY_EPS || v.ended)) advance();
    updateProgress();
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!segs.length || showLoadErrorIfCurrent()) return;
    hideOverlay();
    playing = true;
    bigPlay.classList.add("hidden");
    playBtn.textContent = "❚❚ Pause";
    if (vids[cur].readyState < 3) loadingEl.classList.remove("hidden");
    vids[cur].play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    vids.forEach((v) => v.pause());
    loadingEl.classList.add("hidden");
    playBtn.textContent = "▶ Play";
    if (segs.length && overlay.classList.contains("hidden")) bigPlay.classList.remove("hidden");
    updateProgress();
  }

  function seekTo(t) {
    if (!segs.length) return;
    t = clamp(t, 0, Math.max(0, total - 0.01));
    let i = segs.length - 1;
    while (i > 0 && starts[i] > t) i--;
    goTo(i, t - starts[i]);
    updateProgress();
  }

  let lastActive = -1;
  function onActive() {
    if (idx === lastActive) return;
    lastActive = idx;
    blocks.querySelectorAll("[data-block]").forEach((b, i) => {
      b.style.boxShadow = i === idx ? `0 0 0 2px #fff, 0 0 0 4px ${colorFor(segs[i])}` : "";
    });
    onActiveChange && onActiveChange(idx);
  }

  function updateProgress() {
    const t = sequenceTime();
    timeLabel.textContent = `${fmtClock(t)} / ${fmtClock(total)}`;
    clipLabel.textContent = segs.length ? `Clip ${idx + 1} of ${segs.length}` : "";
    playhead.style.left = `${total ? (t / total) * 100 : 0}%`;
  }

  function renderBlocks() {
    blocks.innerHTML = "";
    segs.forEach((seg, i) => {
      const color = colorFor(seg);
      const block = el("div", "absolute inset-y-0 px-px");
      block.dataset.block = String(i);
      block.style.left = `${(starts[i] / total) * 100}%`;
      block.style.width = `${(segDuration(seg) / total) * 100}%`;
      block.title = `Clip ${i + 1} · ${segDuration(seg).toFixed(1)}s`;
      const inner = el("div", "h-full overflow-hidden rounded-md border-2");
      inner.style.borderColor = color;
      inner.style.backgroundColor = `${color}33`;
      const img = document.createElement("img");
      img.className = "h-full max-w-full object-cover";
      img.style.aspectRatio = "16 / 9";
      img.alt = "";
      img.draggable = false;
      inner.appendChild(img);
      thumbFor(seg, (url) => {
        if (url) img.src = url;
        else img.remove();
      });
      block.appendChild(inner);
      blocks.appendChild(block);
    });
    lastActive = -1;
  }

  function drawWaveform() {
    if (!waveform || !segs.length) {
      waveCanvas.classList.add("hidden");
      return;
    }
    waveCanvas.classList.remove("hidden");
    const dpr = window.devicePixelRatio || 1;
    const w = waveCanvas.clientWidth;
    const h = waveCanvas.clientHeight;
    if (!w || !h) return;
    waveCanvas.width = Math.round(w * dpr);
    waveCanvas.height = Math.round(h * dpr);
    const ctx = waveCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { peaks, peaksPerSec } = waveform;
    const step = WAVE_BAR_PX + WAVE_GAP_PX;
    segs.forEach((seg, i) => {
      const x0 = (starts[i] / total) * w;
      const x1 = ((starts[i] + segDuration(seg)) / total) * w;
      const secPerPx = segDuration(seg) / Math.max(1, x1 - x0);
      ctx.fillStyle = colorFor(seg);
      for (let x = x0; x + WAVE_BAR_PX <= x1; x += step) {
        // Loudest peak under this bar's slice of source time.
        const t0 = seg.startTime + (x - x0) * secPerPx;
        const a = Math.floor(t0 * peaksPerSec);
        const b = Math.max(a + 1, Math.ceil((t0 + step * secPerPx) * peaksPerSec));
        let p = 0;
        for (let k = a; k < b && k < peaks.length; k++) p = Math.max(p, peaks[k]);
        const barH = Math.max(1, (p / 255) * h);
        ctx.fillRect(x, (h - barH) / 2, WAVE_BAR_PX, barH);
      }
    });
  }

  new ResizeObserver(() => drawWaveform()).observe(waveCanvas.parentElement);
  loadWaveform(waveformPath).then((data) => {
    waveform = data;
    drawWaveform();
  });

  // --- input ---
  playBtn.addEventListener("click", () => (playing ? pause() : play()));
  bigPlay.addEventListener("click", play);
  stage.addEventListener("click", (e) => {
    if (e.target !== bigPlay && playing) pause();
  });
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    vids.forEach((v) => (v.muted = muted));
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  });

  // Click or drag anywhere on the timeline to scrub.
  timeline.addEventListener("pointerdown", (e) => {
    if (!segs.length) return;
    timeline.setPointerCapture(e.pointerId);
    const scrubTo = (ev) => {
      const rect = timeline.getBoundingClientRect();
      seekTo(clamp((ev.clientX - rect.left) / rect.width, 0, 1) * total);
    };
    scrubTo(e);
    const onUp = () => {
      timeline.removeEventListener("pointermove", scrubTo);
      timeline.removeEventListener("pointerup", onUp);
      timeline.removeEventListener("pointercancel", onUp);
    };
    timeline.addEventListener("pointermove", scrubTo);
    timeline.addEventListener("pointerup", onUp);
    timeline.addEventListener("pointercancel", onUp);
  });

  /**
   * Replace the sequence. Keeps playing the same clip if it's still in the
   * storyboard (wherever it moved to), so an edit mid-playback doesn't
   * restart the preview.
   */
  function setSegments(next) {
    const prevSeg = segs[idx];
    const prevOffset = currentOffset();
    segs = next.slice(); // the editor mutates its own array in place
    starts = [];
    total = 0;
    for (const seg of segs) {
      starts.push(total);
      total += segDuration(seg);
    }
    renderBlocks();
    drawWaveform();

    if (!segs.length) {
      pause();
      vids.forEach((v) => (v.style.opacity = "0"));
      playBtn.disabled = true;
      showOverlay("Storyboard is empty.");
      updateProgress();
      return;
    }
    playBtn.disabled = false;
    if (overlay.textContent === "Storyboard is empty.") {
      hideOverlay();
      if (!playing) bigPlay.classList.remove("hidden");
    }

    let i = prevSeg ? segs.indexOf(prevSeg) : -1;
    if (i >= 0 && cued[cur] === prevSeg) {
      idx = i;
      cueStandby();
      onActive();
    } else {
      if (i < 0 && prevSeg) i = segs.findIndex((s) => s.clipId === prevSeg.clipId);
      goTo(i >= 0 ? i : Math.min(idx, segs.length - 1), i >= 0 && segs[i] === prevSeg ? prevOffset : 0);
    }
    updateProgress();
  }

  return {
    setSegments,
    /** Jump to segment `i` and play from its start. */
    playSegment(i) {
      if (!segs[i]) return;
      goTo(i, 0);
      play();
    },
    activeIndex: () => idx,
    destroy() {
      pause();
      root.remove();
    },
  };
}
