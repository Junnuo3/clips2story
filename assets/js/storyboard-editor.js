/**
 * The editable storyboard timeline -- the centerpiece of the live demo.
 *
 * Renders the LLM's proposed segment list as draggable, deletable,
 * swappable cards next to a live sequence preview (sequence-preview.js)
 * that plays the current edit back-to-back, so every change is visible
 * immediately. Every mutation (reorder / delete / swap / reset) is a
 * plain in-memory array edit: nothing here ever touches the network.
 *
 * This module owns state + rendering only. Final rendering is handled by
 * the caller (assets/js/try-it-panel.js) via the onRender callback, so
 * this file has no dependency on render-ffmpeg.js.
 */
import { el, resolveMediaPath } from "./dom-helpers.js";
import { createSequencePreview } from "./sequence-preview.js";

const TARGET_MIN_SEC = 30; // 30 seconds -- shortened from the paper's 3-5 min target so the
const TARGET_MAX_SEC = 60; // in-browser ffmpeg.wasm render (source download + re-encode) stays fast

// Per-clip colors shared by a card, its timeline block and its waveform
// slice, so a reorder visibly moves the same color in all three places.
const CLIP_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#4f46e5"];


// A small pool of hidden <video> elements to grab poster-frame thumbnails by
// seeking. All segments in one storyboard almost always share the same
// source video, so a single shared element (the old approach) served every
// capture strictly one at a time -- each seek waits on a network byte-range
// fetch into a large remote file, so a 15-segment storyboard could take many
// seconds for the last thumbnail to appear even though nothing was actually
// broken. Round-robining across a few elements lets that many seeks/fetches
// run concurrently instead, while each element still queues its own
// assigned captures so it doesn't race itself.
const THUMB_POOL_SIZE = 4;
const thumbPool = Array.from({ length: THUMB_POOL_SIZE }, () => {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.crossOrigin = "anonymous"; // needed to read pixels back via canvas
  return { video, loadedSrc: null, failedSrc: null, queue: Promise.resolve(null) };
});
let nextThumbSlot = 0;

// Matches the on-screen thumbnail box size exactly (128x72, see thumbBox
// below) instead of capturing extra pixels the UI just scales down --
// smaller canvas + lower JPEG quality means a smaller data URL to encode
// and paint, which is the part of this actually worth compressing (the
// slow part is the network seek, not the encode).
const THUMB_WIDTH = 128;
const THUMB_HEIGHT = 72;
const THUMB_JPEG_QUALITY = 0.6;

function captureThumbnail(sourcePath, time) {
  const slot = thumbPool[nextThumbSlot];
  nextThumbSlot = (nextThumbSlot + 1) % thumbPool.length;

  slot.queue = slot.queue.then(
    () =>
      new Promise((resolve) => {
        const src = resolveMediaPath(sourcePath);
        const { video } = slot;

        // Already know this exact source fails to load (e.g. a 404) -- don't
        // repeat the network request just to fail again. Segments in one
        // storyboard virtually always share a source, and with only
        // THUMB_POOL_SIZE elements a broken source gets retried on every
        // slot at most once before every later call short-circuits here.
        if (src === slot.failedSrc) {
          resolve(null);
          return;
        }

        let settled = false;
        const cleanup = () => {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("error", onError);
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        // Without this, a source that fails to load (404, network error, an
        // undecodable file) never fires 'loadedmetadata' or 'seeked', so the
        // promise -- and every later capture queued behind it on this slot
        // -- would hang forever instead of falling back to "no preview".
        const onError = () => {
          slot.failedSrc = src;
          finish(null);
        };
        const onSeeked = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = THUMB_WIDTH;
            canvas.height = THUMB_HEIGHT;
            canvas.getContext("2d").drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
            finish(canvas.toDataURL("image/jpeg", THUMB_JPEG_QUALITY));
          } catch {
            finish(null); // cross-origin canvas taint, decode failure, etc.
          }
        };
        const seekAndCapture = () => {
          video.addEventListener("seeked", onSeeked);
          video.currentTime = time;
        };
        const onLoaded = () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          slot.loadedSrc = src;
          seekAndCapture();
        };

        video.addEventListener("error", onError);
        if (slot.loadedSrc !== src) {
          slot.loadedSrc = null;
          video.addEventListener("loadedmetadata", onLoaded);
          video.src = src;
        } else {
          seekAndCapture();
        }
      })
  );
  return slot.queue;
}

/**
 * Thumbnail source, cheapest first: a precomputed per-shot JPEG
 * (scripts/extract-thumbnails.mjs, seg.thumbnailPath -- set by the worker
 * whenever the segment's shot has one) loads instantly with no video
 * involved at all. Falls back to the live video-seek capture above only
 * when there's no precomputed thumbnail for this shot yet (e.g. a video
 * added before its thumbnails were extracted, or a source-file decode
 * error for that one frame).
 */
function loadThumbnail(seg, onReady) {
  if (!seg.thumbnailPath) {
    captureThumbnail(seg.sourcePath, (seg.startTime + seg.endTime) / 2).then(onReady);
    return;
  }
  const probe = new Image();
  probe.onload = () => onReady(resolveMediaPath(seg.thumbnailPath));
  probe.onerror = () => {
    captureThumbnail(seg.sourcePath, (seg.startTime + seg.endTime) / 2).then(onReady);
  };
  probe.src = resolveMediaPath(seg.thumbnailPath);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function cloneSegments(segments) {
  return segments.map((s) => ({ ...s }));
}

/**
 * Move the item at `fromIndex` so it ends up at gap `toIndex` -- both
 * indices are positions in the ORIGINAL (pre-move) array, where `toIndex`
 * counts the gaps between items (0 = before the first item, `array.length`
 * = after the last). Matches the drop-indicator line: the line sits at
 * gap `toIndex`, and dropping there is exactly this move.
 */
function reorder(list, fromIndex, toIndex) {
  const item = list[fromIndex];
  const without = list.slice(0, fromIndex).concat(list.slice(fromIndex + 1));
  // Removing an earlier item shifts every later gap index down by one.
  const adjusted = fromIndex < toIndex ? toIndex - 1 : toIndex;
  without.splice(adjusted, 0, item);
  return without;
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {Array} opts.segments - initial AI-proposed segments (ordered)
 * @param {Array} opts.pool - full retrieved pool (used + unused), for the swap popover
 * @param {string} [opts.waveformPath] - precomputed waveform for the source video (scripts/extract-waveforms.mjs)
 * @param {(segments: Array) => void} [opts.onChange] - called after every mutation
 * @param {(segments: Array) => void} [opts.onRender] - "Render final video" clicked
 */
export function createStoryboardEditor({ container, segments, pool, waveformPath, onChange, onRender }) {
  const original = cloneSegments(segments);
  let current = cloneSegments(segments);
  const clipColors = new Map(); // clipId -> color, assigned on first appearance
  function colorFor(seg) {
    if (!clipColors.has(seg.clipId)) clipColors.set(seg.clipId, CLIP_COLORS[clipColors.size % CLIP_COLORS.length]);
    return clipColors.get(seg.clipId);
  }
  // Every mutation rebuilds every card from scratch via render(), which
  // would otherwise reset a "Show more" toggle back to collapsed on each
  // edit -- track expansion by clipId here so it survives across re-renders.
  const expandedClipIds = new Set();
  let dragIndex = null;
  let lastDeleted = null; // { segment, index } for undo

  const root = el("div", "space-y-4");
  const header = el("div", "flex flex-wrap items-center justify-between gap-3");
  const headerLeft = el("div", "flex items-center gap-3");
  const stateLabel = el("span", "rounded-full px-2.5 py-1 text-xs font-semibold");
  const durationBadge = el("span", "rounded-full px-2.5 py-1 text-xs font-semibold");
  headerLeft.appendChild(stateLabel);
  headerLeft.appendChild(durationBadge);

  const headerRight = el("div", "flex flex-wrap items-center gap-2");
  const resetBtn = el(
    "button",
    "rounded-lg border border-surface-border px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50",
    "↩ Reset to AI proposal"
  );
  const renderBtn = el(
    "button",
    "rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-200",
    "🎬 Render final video"
  );
  headerRight.appendChild(resetBtn);
  headerRight.appendChild(renderBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const undoBar = el("div", "hidden items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800");
  const undoText = el("span", "", "");
  const undoBtn = el("button", "font-semibold underline underline-offset-2 hover:text-amber-900", "Undo");
  undoBar.appendChild(undoText);
  undoBar.appendChild(undoBtn);

  const list = el("div", "space-y-2");

  // A single reusable line that marks where a dragged card would land --
  // moved between cards on dragover rather than rebuilt, since render()
  // wipes and rebuilds the whole list (which would abort the drag).
  //
  // dragover fires continuously (many times a second) for as long as the
  // pointer sits over a valid target, not just when it moves. Touching the
  // DOM (remove + insertBefore) on every single one of those events forces
  // a synchronous layout recalc each time -- with several cards in the
  // list that's enough thrashing to visibly lag input, including a
  // backlog of already-queued dragover events still applying stale moves
  // for a moment *after* the mouse button is released. Only touch the DOM
  // when the target gap actually changes.
  const dropIndicator = el("div", "h-0.5 rounded-full bg-blue-500");
  let shownInsertIndex = null;
  function showDropIndicator(insertIndex) {
    if (insertIndex === shownInsertIndex) return;
    shownInsertIndex = insertIndex;
    if (dropIndicator.parentNode) dropIndicator.remove();
    list.insertBefore(dropIndicator, list.children[insertIndex] || null);
  }
  function clearDropIndicator() {
    shownInsertIndex = null;
    if (dropIndicator.parentNode) dropIndicator.remove();
  }

  const cardEls = [];
  function highlightCard(activeIdx) {
    cardEls.forEach((card, i) => {
      const color = colorFor(current[i]);
      const active = i === activeIdx;
      card.style.borderColor = active ? color : `${color}66`;
      card.style.backgroundColor = active ? `${color}1f` : `${color}0d`;
      card.style.boxShadow = active ? `0 0 0 2px ${color}` : "";
    });
  }

  const workspace = el("div", "grid gap-4 lg:grid-cols-2 lg:items-start");
  const previewCol = el("div", "lg:sticky lg:top-4 lg:order-2");
  list.classList.add("lg:order-1");
  workspace.appendChild(previewCol);
  workspace.appendChild(list);
  const preview = createSequencePreview({
    container: previewCol,
    colorFor,
    thumbFor: loadThumbnail,
    waveformPath,
    onActiveChange: highlightCard,
  });

  root.appendChild(header);
  root.appendChild(undoBar);
  root.appendChild(workspace);
  container.appendChild(root);

  function renderHeader() {
    const total = current.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    const inRange = total >= TARGET_MIN_SEC && total <= TARGET_MAX_SEC;
    durationBadge.textContent = `${fmtDuration(total)} — target 30–60s`;
    durationBadge.className =
      "rounded-full px-2.5 py-1 text-xs font-semibold " +
      (inRange
        ? "bg-teal-50 text-teal-700 ring-1 ring-teal-300"
        : "bg-amber-100 text-amber-700 ring-1 ring-amber-300");

    const edited = JSON.stringify(current.map((s) => s.clipId + s.startTime + s.endTime)) !==
      JSON.stringify(original.map((s) => s.clipId + s.startTime + s.endTime));
    stateLabel.textContent = edited ? "Edited storyboard" : "AI proposal";
    stateLabel.className =
      "rounded-full px-2.5 py-1 text-xs font-semibold " +
      (edited
        ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
        : "bg-slate-100 text-slate-700 ring-1 ring-slate-200");
    resetBtn.disabled = !edited;
    resetBtn.classList.toggle("opacity-40", !edited);
    resetBtn.classList.toggle("cursor-not-allowed", !edited);
  }

  function usedClipIds() {
    return new Set(current.map((s) => s.clipId));
  }

  function buildSwapPopover(cardIndex) {
    const used = usedClipIds();
    const alternates = (pool || []).filter((p) => !used.has(p.clipId));
    const box = el("div", "max-h-64 space-y-2 overflow-y-auto pr-1");
    if (alternates.length === 0) {
      box.appendChild(el("p", "text-xs text-slate-500", "No unused alternates left in the retrieved pool."));
    }
    for (const alt of alternates.slice(0, 12)) {
      const row = el(
        "button",
        "block w-full rounded-lg border border-surface-border/70 bg-slate-50 px-3 py-2 text-left text-xs hover:bg-slate-50"
      );
      // Same fallback as makeCard's own transcript display (transcript when
      // this clip actually has speech, caption otherwise) -- previously this
      // showed only the caption, so a clip with real dialogue looked
      // identical here to one that's silent, with no way to tell which
      // alternate to pick without swapping it in first.
      const altText = alt.transcript?.trim() ? alt.transcript : alt.caption || "(no transcript or caption)";
      row.appendChild(el("p", "line-clamp-2 font-medium text-slate-800", altText));
      row.appendChild(
        el(
          "p",
          "mt-1 text-slate-500",
          `${fmtDuration(alt.endTime - alt.startTime)} · ${alt.background || "unknown"}`
        )
      );
      row.addEventListener("click", () => {
        current[cardIndex] = { ...alt };
        emitChange();
      });
      box.appendChild(row);
    }
    return box;
  }

  function makeCard(seg, index) {
    const card = el("div", "flex gap-3 rounded-xl border-2 p-3 transition-shadow");
    card.draggable = true;
    card.dataset.index = String(index);

    card.addEventListener("dragstart", (e) => {
      dragIndex = index;
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragIndex === null) return;
      // Which half of this card the pointer is over decides whether the
      // line lands above it (insert here) or below it (insert after).
      const rect = card.getBoundingClientRect();
      const insertIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
      showDropIndicator(insertIndex);
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropIndicator();
      if (dragIndex === null) return;
      const rect = card.getBoundingClientRect();
      const insertIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
      current = reorder(current, dragIndex, insertIndex);
      dragIndex = null;
      emitChange();
    });
    card.addEventListener("dragend", () => {
      // Fires on the drag source once the gesture ends, success or not --
      // the only reliable place to clean up a drag that got cancelled
      // (Escape, dropped outside any card) rather than actually dropped.
      dragIndex = null;
      clearDropIndicator();
    });

    const thumbBox = el(
      "div",
      "flex h-[72px] w-[128px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-surface-border/60 bg-slate-200 animate-pulse"
    );
    const thumbImg = document.createElement("img");
    thumbImg.className = "h-full w-full object-cover";
    thumbImg.alt = "";
    thumbBox.appendChild(thumbImg);
    loadThumbnail(seg, (dataUrl) => {
      thumbBox.classList.remove("animate-pulse");
      if (dataUrl) {
        thumbImg.src = dataUrl;
      } else {
        thumbBox.classList.add("text-[10px]", "text-slate-500");
        thumbBox.textContent = "no preview";
      }
    });

    const body = el("div", "min-w-0 flex-1 space-y-1");
    const topRow = el("div", "flex items-center gap-2 text-xs text-slate-600");
    topRow.appendChild(el("span", "cursor-grab select-none text-slate-500", "☰"));
    const durationLabel = el("span", "", fmtDuration(seg.endTime - seg.startTime));
    topRow.appendChild(durationLabel);
    body.appendChild(topRow);

    const text = seg.transcript?.trim() ? seg.transcript : seg.caption || "(no transcript or caption)";
    let expanded = expandedClipIds.has(seg.clipId);
    const textEl = el("p", "text-sm text-slate-800", text);
    textEl.classList.toggle("line-clamp-2", !expanded);
    body.appendChild(textEl);
    // Long ASR transcripts get clamped to 2 lines by default -- only show a
    // toggle when there's actually more to reveal (avoids a dead "Show more"
    // button on short captions).
    const LONG_TEXT_CHARS = 140;
    if (text.length > LONG_TEXT_CHARS) {
      const toggleBtn = el(
        "button",
        "text-[11px] font-medium text-blue-600 hover:text-blue-800",
        expanded ? "Show less" : "Show more"
      );
      toggleBtn.addEventListener("click", () => {
        expanded = !expanded;
        if (expanded) expandedClipIds.add(seg.clipId);
        else expandedClipIds.delete(seg.clipId);
        textEl.classList.toggle("line-clamp-2", !expanded);
        toggleBtn.textContent = expanded ? "Show less" : "Show more";
      });
      body.appendChild(toggleBtn);
    }

    const moveRow = el("div", "flex flex-wrap items-center gap-2 pt-1");
    const playBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "▶ Play clip");
    const upBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "↑ Move up");
    const downBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "↓ Move down");
    const swapBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "⇄ Swap");
    const delBtn = el("button", "rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50", "× Remove");
    playBtn.addEventListener("click", () => preview.playSegment(index));
    upBtn.disabled = index === 0;
    downBtn.disabled = index === current.length - 1;
    upBtn.addEventListener("click", () => {
      if (index === 0) return;
      [current[index - 1], current[index]] = [current[index], current[index - 1]];
      emitChange();
    });
    downBtn.addEventListener("click", () => {
      if (index === current.length - 1) return;
      [current[index + 1], current[index]] = [current[index], current[index + 1]];
      emitChange();
    });
    delBtn.addEventListener("click", () => {
      lastDeleted = { segment: current[index], index };
      current.splice(index, 1);
      showUndo();
      emitChange();
    });

    let swapPanel = null;
    swapBtn.addEventListener("click", () => {
      if (swapPanel) {
        swapPanel.remove();
        swapPanel = null;
        return;
      }
      swapPanel = el("div", "mt-2");
      swapPanel.appendChild(buildSwapPopover(index));
      body.appendChild(swapPanel);
    });

    moveRow.appendChild(playBtn);
    moveRow.appendChild(upBtn);
    moveRow.appendChild(downBtn);
    moveRow.appendChild(swapBtn);
    moveRow.appendChild(delBtn);
    body.appendChild(moveRow);

    card.appendChild(thumbBox);
    card.appendChild(body);
    return card;
  }

  function showUndo() {
    if (!lastDeleted) return;
    undoText.textContent = `Removed "${(lastDeleted.segment.caption || lastDeleted.segment.clipId).slice(0, 60)}".`;
    undoBar.classList.remove("hidden");
    undoBar.classList.add("flex");
    clearTimeout(showUndo._t);
    showUndo._t = setTimeout(() => {
      undoBar.classList.add("hidden");
      undoBar.classList.remove("flex");
      lastDeleted = null;
    }, 6000);
  }

  undoBtn.addEventListener("click", () => {
    if (!lastDeleted) return;
    current.splice(lastDeleted.index, 0, lastDeleted.segment);
    lastDeleted = null;
    undoBar.classList.add("hidden");
    undoBar.classList.remove("flex");
    emitChange();
  });

  resetBtn.addEventListener("click", () => {
    current = cloneSegments(original);
    emitChange();
  });
  renderBtn.addEventListener("click", () => onRender && onRender(current));

  function render() {
    list.innerHTML = "";
    cardEls.length = 0;
    if (current.length === 0) {
      list.appendChild(
        el("p", "rounded-lg border border-dashed border-surface-border/70 p-4 text-center text-sm text-slate-500", "Storyboard is empty — reset or swap in a clip.")
      );
    }
    current.forEach((seg, i) => {
      const card = makeCard(seg, i);
      cardEls.push(card);
      list.appendChild(card);
    });
    renderHeader();
    preview.setSegments(current);
    highlightCard(preview.activeIndex());
  }

  function emitChange() {
    render();
    onChange && onChange(current);
  }

  render();

  return {
    getSegments: () => cloneSegments(current),
    reset: () => {
      current = cloneSegments(original);
      emitChange();
    },
    destroy: () => {
      preview.destroy();
      root.remove();
    },
  };
}
