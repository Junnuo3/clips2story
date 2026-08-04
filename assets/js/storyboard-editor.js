/**
 * The editable storyboard timeline -- the centerpiece of the live demo.
 *
 * Renders the LLM's proposed segment list as draggable, deletable,
 * swappable cards. Every mutation (reorder / delete / swap / reset) is a
 * plain in-memory array edit: nothing here ever touches the network.
 *
 * This module owns state + rendering only. Final rendering is handled by
 * the caller (assets/js/try-it-panel.js) via the onRender callback, so
 * this file has no dependency on render-ffmpeg.js.
 */
import { el, createDetails, resolveMediaPath } from "./dom-helpers.js";

const TARGET_MIN_SEC = 180; // 3 minutes, matching the paper's 3-5 min target runtime
const TARGET_MAX_SEC = 300; // 5 minutes

// One shared hidden <video> used to grab poster-frame thumbnails by seeking,
// queued so concurrent captures don't race on the same element.
const thumbVideo = document.createElement("video");
thumbVideo.muted = true;
thumbVideo.preload = "auto";
thumbVideo.playsInline = true;
thumbVideo.crossOrigin = "anonymous"; // needed to read pixels back via canvas
let thumbSrc = null;
let thumbQueue = Promise.resolve(null);

function captureThumbnail(sourcePath, time) {
  thumbQueue = thumbQueue.then(
    () =>
      new Promise((resolve) => {
        const src = resolveMediaPath(sourcePath);
        const doSeek = () => {
          const onSeeked = () => {
            thumbVideo.removeEventListener("seeked", onSeeked);
            try {
              const canvas = document.createElement("canvas");
              canvas.width = 160;
              canvas.height = 90;
              canvas.getContext("2d").drawImage(thumbVideo, 0, 0, 160, 90);
              resolve(canvas.toDataURL("image/jpeg", 0.7));
            } catch {
              resolve(null); // cross-origin canvas taint, decode failure, etc. -- fall back to no thumbnail
            }
          };
          thumbVideo.addEventListener("seeked", onSeeked);
          thumbVideo.currentTime = time;
        };
        if (thumbSrc !== src) {
          thumbSrc = src;
          thumbVideo.src = src;
          const onLoaded = () => {
            thumbVideo.removeEventListener("loadedmetadata", onLoaded);
            doSeek();
          };
          thumbVideo.addEventListener("loadedmetadata", onLoaded);
        } else {
          doSeek();
        }
      })
  );
  return thumbQueue;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function cloneSegments(segments) {
  return segments.map((s) => ({ ...s }));
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {Array} opts.segments - initial AI-proposed segments (ordered)
 * @param {Array} opts.pool - full retrieved pool (used + unused), for the swap popover
 * @param {(segments: Array) => void} [opts.onChange] - called after every mutation
 * @param {(segments: Array) => void} [opts.onRender] - "Render final video" clicked
 */
export function createStoryboardEditor({ container, segments, pool, onChange, onRender }) {
  const original = cloneSegments(segments);
  let current = cloneSegments(segments);
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
    "rounded-lg border border-surface-border px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5",
    "↩ Reset to AI proposal"
  );
  const renderBtn = el(
    "button",
    "rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20",
    "🎬 Render final video"
  );
  headerRight.appendChild(resetBtn);
  headerRight.appendChild(renderBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const undoBar = el("div", "hidden items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200");
  const undoText = el("span", "", "");
  const undoBtn = el("button", "font-semibold underline underline-offset-2 hover:text-amber-100", "Undo");
  undoBar.appendChild(undoText);
  undoBar.appendChild(undoBtn);

  const list = el("div", "space-y-2");

  root.appendChild(header);
  root.appendChild(undoBar);
  root.appendChild(list);
  container.appendChild(root);

  function renderHeader() {
    const total = current.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    const inRange = total >= TARGET_MIN_SEC && total <= TARGET_MAX_SEC;
    durationBadge.textContent = `${fmtDuration(total)} — target 3–5 min`;
    durationBadge.className =
      "rounded-full px-2.5 py-1 text-xs font-semibold " +
      (inRange
        ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
        : "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30");

    const edited = JSON.stringify(current.map((s) => s.clipId + s.startTime + s.endTime)) !==
      JSON.stringify(original.map((s) => s.clipId + s.startTime + s.endTime));
    stateLabel.textContent = edited ? "Edited storyboard" : "AI proposal";
    stateLabel.className =
      "rounded-full px-2.5 py-1 text-xs font-semibold " +
      (edited
        ? "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30"
        : "bg-white/10 text-slate-300 ring-1 ring-white/10");
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
        "block w-full rounded-lg border border-surface-border/70 bg-black/20 px-3 py-2 text-left text-xs hover:bg-white/5"
      );
      row.appendChild(el("p", "font-medium text-slate-200", alt.caption || "(no caption)"));
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
    const card = el(
      "div",
      "flex gap-3 rounded-xl border border-surface-border bg-surface-raised/25 p-3"
    );
    card.draggable = true;
    card.dataset.index = String(index);

    card.addEventListener("dragstart", (e) => {
      dragIndex = index;
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === index) return;
      const [moved] = current.splice(dragIndex, 1);
      current.splice(index, 0, moved);
      dragIndex = null;
      emitChange();
    });

    const thumbBox = el(
      "div",
      "flex h-[72px] w-[128px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-surface-border/60 bg-black/40"
    );
    const thumbImg = document.createElement("img");
    thumbImg.className = "h-full w-full object-cover";
    thumbImg.alt = "";
    thumbBox.appendChild(thumbImg);
    captureThumbnail(seg.sourcePath, (seg.startTime + seg.endTime) / 2).then((dataUrl) => {
      if (dataUrl) {
        thumbImg.src = dataUrl;
      } else {
        thumbBox.classList.add("text-[10px]", "text-slate-500");
        thumbBox.textContent = "no preview";
      }
    });

    const body = el("div", "min-w-0 flex-1 space-y-1");
    const topRow = el("div", "flex items-center gap-2 text-xs text-slate-400");
    topRow.appendChild(el("span", "cursor-grab select-none text-slate-500", "☰"));
    topRow.appendChild(el("span", "font-mono", seg.clipId));
    topRow.appendChild(el("span", "", `· ${fmtDuration(seg.endTime - seg.startTime)}`));
    body.appendChild(topRow);

    const text = seg.transcript?.trim() ? seg.transcript : seg.caption || "(no transcript or caption)";
    body.appendChild(el("p", "line-clamp-2 text-sm text-slate-200", text));

    const moveRow = el("div", "flex flex-wrap items-center gap-2 pt-1");
    const upBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5", "↑ Move up");
    const downBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5", "↓ Move down");
    const swapBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5", "⇄ Swap");
    const delBtn = el("button", "rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10", "× Remove");
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
    if (current.length === 0) {
      list.appendChild(
        el("p", "rounded-lg border border-dashed border-surface-border/70 p-4 text-center text-sm text-slate-500", "Storyboard is empty — reset or swap in a clip.")
      );
    }
    current.forEach((seg, i) => list.appendChild(makeCard(seg, i)));
    renderHeader();
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
    destroy: () => root.remove(),
  };
}
