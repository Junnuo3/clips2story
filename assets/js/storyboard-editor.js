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
import { el, createDetails, resolveMediaPath, setVideoMp4FromRepoPath } from "./dom-helpers.js";

const TARGET_MIN_SEC = 30; // 30 seconds -- shortened from the paper's 3-5 min target so the
const TARGET_MAX_SEC = 60; // in-browser ffmpeg.wasm render (source download + re-encode) stays fast

// Floor on a segment's own length so a trim handle can never collapse it to
// zero (which would break both the on-screen preview and the ffmpeg trim
// filter at render time).
const MIN_SEG_DURATION = 0.3;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The trim/extend handles need to know the *full* source video's duration
 * (not just the current clip's), since extending restores footage the clip
 * doesn't currently include. Nothing else in this app loads that today --
 * probe it once per unique source path with a throwaway <video> and cache
 * the result (a promise, so concurrent cards asking for the same source
 * share one probe instead of racing separate loads).
 */
const sourceDurationCache = new Map();
function getSourceDuration(sourcePath) {
  if (sourceDurationCache.has(sourcePath)) return sourceDurationCache.get(sourcePath);
  const promise = new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.addEventListener("loadedmetadata", () => resolve(probe.duration || null), { once: true });
    probe.addEventListener("error", () => resolve(null), { once: true });
    probe.src = resolveMediaPath(sourcePath);
  });
  sourceDurationCache.set(sourcePath, promise);
  return promise;
}

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

/** m:ss timestamp for trim-handle labels (as opposed to fmtDuration's "Xm Ys" span format). */
function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
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
 * Split a "[Xs-Ys] [SPEAKER] text | [Xs-Ys] text | ..." transcript string
 * (built by scripts/export-embeddings.mjs's buildTranscript, timestamps
 * relative to the *shot's own* start) into its per-sentence pieces.
 */
function parseTranscriptEntries(transcript) {
  if (!transcript) return [];
  return transcript
    .split(" | ")
    .map((piece) => {
      const m = /^\[(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s\]/.exec(piece.trim());
      if (!m) return null;
      return { start: Number(m[1]), end: Number(m[2]), text: piece.trim() };
    })
    .filter(Boolean);
}

/** Strips the "[Xs-Ys] [SPEAKER_n] " prefix off one transcript piece, leaving just the spoken words. */
function bareTranscriptText(piece) {
  return piece
    .replace(/^\[\d+(?:\.\d+)?s-\d+(?:\.\d+)?s\]\s*/, "")
    .replace(/^\[SPEAKER_[^\]]*\]\s*/, "")
    .trim()
    .toLowerCase();
}

/**
 * Drops repeated sentences from a " | "-joined list of transcript pieces,
 * keeping the first occurrence. Needed because ASR bundles for this genre
 * (see DEMO_HPC_PREPROCESSING.md) commonly attribute one continuous spoken
 * sentence to *every* shot it overlaps in full, rather than splitting it --
 * so a segment spanning several such shots would otherwise show the exact
 * same sentence two or three times in a row.
 */
function dedupeTranscriptPieces(pieces) {
  const seen = new Set();
  const kept = [];
  for (const piece of pieces) {
    const key = bareTranscriptText(piece);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    kept.push(piece);
  }
  return kept;
}

/**
 * Re-slice a shot's full transcript down to whatever sentences overlap
 * [relStart, relEnd] (both relative to the shot's own start, matching the
 * bracket convention above). Used to keep a card's displayed transcript in
 * sync as its trim handles move -- the segment's own `transcript` field is
 * whatever the LLM (or the original AI proposal) chose to keep, which is
 * too narrow once a trim/extend moves outside that original window, so this
 * always re-derives from the *full* per-shot transcript instead.
 * Returns null if the source string didn't parse into any entries at all
 * (e.g. a shot with no speech) -- callers should leave the field alone then,
 * rather than blanking out a transcript that was never sliceable to begin with.
 */
function resliceTranscript(fullShotTranscript, relStart, relEnd) {
  const entries = parseTranscriptEntries(fullShotTranscript);
  if (entries.length === 0) return null;
  const pieces = entries.filter((e) => e.start < relEnd && e.end > relStart).map((e) => e.text);
  return dedupeTranscriptPieces(pieces).join(" | ");
}

/**
 * A trimmed clip's transcript re-slices fine from a single shot's own full
 * transcript (resliceTranscript above) as long as the trim stays inside that
 * one shot's own span. But extending is explicitly allowed to cross into
 * neighboring shots' footage (per spec, bounded only by the full source
 * video, not the current shot) -- a single shot's transcript has no idea
 * what's said in the next one, so a large extend needs to pull in and
 * re-slice *each* shot the new [seg.startTime, seg.endTime] range now
 * overlaps, not just the segment's own originating shot.
 *
 * `shots` is the full per-video shot list (embeddings/<id>.json's `shots`,
 * already loaded by the time the storyboard planner ran -- see
 * try-it-panel.js), each with absolute start_time/end_time and its own
 * full shot-relative transcript. Falls back to the single-shot pool lookup
 * when the caller didn't have the full shot list available.
 */
function fullRangeTranscript(seg, { shots, poolByClipId }) {
  if (shots && shots.length) {
    // Per-video shot lists restart their own clock at 0 (each bundle's
    // shot_ids are only unique within that one video -- see
    // DEMO_HPC_PREPROCESSING.md), so absolute start/end time alone isn't
    // enough to tell shots from two different source videos apart once
    // there's more than one in play. Scope the match to the segment's own
    // source when a shot entry carries sourcePath (local-demo's multi-video
    // path -- see local-demo/retrieval.js); shots without it (the public
    // single-video panel's index.shots) keep the old time-only behavior.
    const overlapping = shots
      .filter(
        (s) =>
          s.start_time < seg.endTime &&
          s.end_time > seg.startTime &&
          (!s.sourcePath || s.sourcePath === seg.sourcePath)
      )
      .sort((a, b) => a.start_time - b.start_time);
    if (overlapping.length > 0) {
      const perShotPieces = overlapping
        .map((s) => resliceTranscript(s.transcript, seg.startTime - s.start_time, seg.endTime - s.start_time))
        .filter(Boolean);
      // dedupeTranscriptPieces above only catches repeats *within* one
      // shot's own entries; the same duplicated-sentence-across-shots bug
      // just as commonly straddles the boundary between two different
      // shots' resliced output, so dedupe again across the joined set.
      return dedupeTranscriptPieces(perShotPieces).join(" | "); // may end up "" if none of the overlapping shots have speech in range
    }
  }
  const origin = poolByClipId.get(seg.clipId);
  if (origin && origin.transcript) {
    const resliced = resliceTranscript(origin.transcript, seg.startTime - origin.startTime, seg.endTime - origin.startTime);
    if (resliced !== null) return resliced;
  }
  return null; // no source we can re-slice from -- leave the existing transcript alone
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {Array} opts.segments - initial AI-proposed segments (ordered)
 * @param {Array} opts.pool - full retrieved pool (used + unused), for the swap popover
 * @param {Array} [opts.shots] - full per-video shot list (embeddings/<id>.json's `shots`), used to
 *   re-slice a card's transcript across shot boundaries when a trim/extend reaches past its own shot
 * @param {(segments: Array) => void} [opts.onChange] - called after every mutation
 * @param {(segments: Array) => void} [opts.onRender] - "Render final video" clicked
 */
export function createStoryboardEditor({ container, segments, pool, shots, onChange, onRender }) {
  const original = cloneSegments(segments);
  let current = cloneSegments(segments);
  // clipId -> its pool entry, which always carries the *full* per-shot
  // transcript/absolute start (pool entries are never trimmed) -- the
  // source of truth for re-slicing a card's transcript as it's trimmed.
  const poolByClipId = new Map((pool || []).map((p) => [p.clipId, p]));
  // Every mutation (including committing a trim drag) rebuilds every card
  // from scratch via render(), which would otherwise reset a "Show more"
  // toggle back to collapsed on each edit -- track expansion by clipId here
  // so it survives across re-renders.
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

  root.appendChild(header);
  root.appendChild(undoBar);
  root.appendChild(list);
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
    const card = el(
      "div",
      "flex gap-3 rounded-xl border border-surface-border bg-surface-raised p-3"
    );
    card.draggable = true;
    card.dataset.index = String(index);

    card.addEventListener("dragstart", (e) => {
      // The card itself is the HTML5 drag source, so a press-and-drag
      // gesture starting on a descendant (a trim handle, the video scrub
      // bar) would otherwise be hijacked into a reorder-drag instead of
      // reaching that widget's own pointer handlers. Opt those out here.
      if (e.target.closest && e.target.closest(".no-native-drag")) {
        e.preventDefault();
        return;
      }
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

    // Keeps the card's displayed transcript in sync as trim handles move --
    // re-derives from the full source transcript (across shot boundaries
    // once an extend reaches past this segment's own shot) rather than
    // slicing seg.transcript itself, since that field may already be
    // narrower than the shot (an LLM- or previously-user-chosen sub-range),
    // which would lose text on an extend past that earlier window.
    function updateTranscriptDisplay() {
      const resliced = fullRangeTranscript(seg, { shots, poolByClipId });
      if (resliced !== null) seg.transcript = resliced;
      textEl.textContent = seg.transcript?.trim() ? seg.transcript : seg.caption || "(no transcript or caption)";
    }

    // --- inline playback (clamped to this segment's current in/out points) ---
    let videoEl = null;
    const playerWrap = el("div", "no-native-drag mt-2 hidden");

    function clampPlayerToRange() {
      if (!videoEl) return;
      if (videoEl.currentTime < seg.startTime) videoEl.currentTime = seg.startTime;
      else if (videoEl.currentTime > seg.endTime) {
        videoEl.currentTime = seg.endTime;
        videoEl.pause();
      }
    }

    // --- trim/extend timeline (positions are against the full source video's
    // duration, not just this segment's own span, per spec) ---
    const trimWrap = el("div", "no-native-drag mt-2 space-y-1");
    const trimLabelRow = el("div", "flex items-center justify-between text-[10px] text-slate-500");
    const trimLabelLeft = el("span", "", "");
    const trimLabelRight = el("span", "", "");
    trimLabelRow.appendChild(trimLabelLeft);
    trimLabelRow.appendChild(el("span", "", "drag edges to trim / extend"));
    trimLabelRow.appendChild(trimLabelRight);

    const track = el("div", "relative h-6 w-full rounded-md bg-slate-50");
    const rangeEl = el("div", "absolute inset-y-0 rounded-md bg-amber-100 ring-1 ring-inset ring-amber-400");
    const leftHandle = el(
      "div",
      "absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded bg-amber-400 hover:bg-amber-300"
    );
    const rightHandle = el(
      "div",
      "absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded bg-amber-400 hover:bg-amber-300"
    );
    track.appendChild(rangeEl);
    track.appendChild(leftHandle);
    track.appendChild(rightHandle);
    trimWrap.appendChild(trimLabelRow);
    trimWrap.appendChild(track);
    const trimStatus = el("p", "text-[10px] text-slate-500", "Loading source timeline…");
    trimWrap.appendChild(trimStatus);

    let sourceDuration = null; // full source video length; null until (or unless) it loads

    // Pixel<->time mapping basis: the true full-source duration once known.
    // Until then, fall back to this clip's own current end -- extending the
    // right edge is capped at that fallback (can't safely offer more of the
    // source than we've confirmed exists), but trimming inward and
    // extending the *left* edge toward 0 are always safe and stay live.
    function trackTotal() {
      return sourceDuration != null ? sourceDuration : Math.max(seg.endTime, MIN_SEG_DURATION);
    }

    function updateTrimVisuals() {
      const total = trackTotal();
      const leftPct = clamp((seg.startTime / total) * 100, 0, 100);
      const rightPct = clamp((seg.endTime / total) * 100, 0, 100);
      rangeEl.style.left = `${leftPct}%`;
      rangeEl.style.right = `${100 - rightPct}%`;
      leftHandle.style.left = `${leftPct}%`;
      rightHandle.style.left = `${rightPct}%`;
      trimLabelLeft.textContent = fmtClock(seg.startTime);
      trimLabelRight.textContent = fmtClock(seg.endTime);
      durationLabel.textContent = fmtDuration(seg.endTime - seg.startTime);
    }
    updateTrimVisuals();

    getSourceDuration(seg.sourcePath).then((dur) => {
      sourceDuration = dur; // null means the probe failed -- trimming still works, extending past the current edges won't
      trimStatus.textContent = dur
        ? ""
        : "Full-source duration unavailable — extending past this clip's current range is disabled.";
      trimStatus.classList.toggle("hidden", !!dur);
      updateTrimVisuals();
    });

    function bindTrimHandle(handle, isLeft) {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const rect = track.getBoundingClientRect();

        const onMove = (ev) => {
          const total = trackTotal();
          const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const t = ratio * total;
          if (isLeft) {
            const maxStart = Math.max(0, seg.endTime - MIN_SEG_DURATION);
            seg.startTime = clamp(t, 0, maxStart);
          } else {
            const minEnd = Math.min(total, seg.startTime + MIN_SEG_DURATION);
            seg.endTime = clamp(t, minEnd, total);
          }
          updateTrimVisuals();
          updateTranscriptDisplay();
          clampPlayerToRange();
          renderHeader(); // live total-duration/edited-state feedback without rebuilding the list mid-drag
        };
        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          // The precomputed thumbnail is a frame from the *original* shot
          // midpoint; once trimmed it no longer represents this segment, so
          // clear it and let loadThumbnail's live-seek fallback recapture at
          // the new midpoint on the next render.
          seg.thumbnailPath = null;
          emitChange();
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      });
    }
    bindTrimHandle(leftHandle, true);
    bindTrimHandle(rightHandle, false);

    const moveRow = el("div", "flex flex-wrap items-center gap-2 pt-1");
    const playBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "▶ Play clip");
    const upBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "↑ Move up");
    const downBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "↓ Move down");
    const swapBtn = el("button", "rounded border border-surface-border/70 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50", "⇄ Swap");
    const delBtn = el("button", "rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50", "× Remove");
    playBtn.addEventListener("click", () => {
      if (videoEl) {
        videoEl.pause();
        playerWrap.classList.add("hidden");
        playerWrap.innerHTML = "";
        videoEl = null;
        playBtn.textContent = "▶ Play clip";
        return;
      }
      // Bind every listener to this specific element (`v`), not the outer
      // mutable `videoEl` -- closing the player nulls that out, but an
      // already-queued event on the (now detached) old element can still
      // fire afterward, and a handler reading `videoEl` at that point would
      // throw on a null currentTime access.
      const v = document.createElement("video");
      videoEl = v;
      v.className =
        "w-full max-w-sm rounded-lg border border-surface-border/60 bg-black aspect-video object-contain";
      v.controls = true;
      v.playsInline = true;
      v.preload = "metadata";
      setVideoMp4FromRepoPath(v, seg.sourcePath);
      // Seek to the segment's start and wait for that seek to actually land
      // before calling play() -- calling play() first and seeking out from
      // under it races the browser's own playback start against our seek,
      // which commonly aborts the pending play() (silently, via the catch
      // below) and leaves the element paused or stuck mid-seek with no
      // frame ever rendered, especially for a large local source file where
      // the seek needs a real byte-range fetch.
      v.addEventListener(
        "loadedmetadata",
        () => {
          const startPlayback = () => {
            v.removeEventListener("seeked", startPlayback);
            v.play().catch(() => {
              // Autoplay can still be blocked in some browsers even on a user
              // gesture; the visible controls still let them press play.
            });
          };
          if (Math.abs(v.currentTime - seg.startTime) < 0.05) {
            // Already at (or within a frame of) the target -- setting
            // currentTime to the same value it already has won't fire
            // 'seeked', so there's nothing to wait for.
            startPlayback();
          } else {
            v.addEventListener("seeked", startPlayback);
            // Backstop: a byte-range seek into a large local source file
            // that stalls (network hiccup, an over-loaded dev server) would
            // otherwise leave the player waiting forever with no visible
            // feedback -- start playback anyway after a few seconds rather
            // than staying stuck. startPlayback() itself is idempotent to
            // call twice (removeEventListener first) in case 'seeked' still
            // lands right after this fires.
            setTimeout(startPlayback, 4000);
            v.currentTime = seg.startTime;
          }
        },
        { once: true }
      );
      v.addEventListener("play", () => {
        if (v.currentTime < seg.startTime || v.currentTime >= seg.endTime) {
          v.currentTime = seg.startTime;
        }
      });
      v.addEventListener("timeupdate", () => {
        if (v.currentTime >= seg.endTime) {
          v.pause();
          v.currentTime = seg.endTime;
        }
      });
      v.addEventListener("seeking", () => {
        if (v.currentTime < seg.startTime) v.currentTime = seg.startTime;
        else if (v.currentTime > seg.endTime) {
          v.currentTime = seg.endTime;
          v.pause();
        }
      });
      playerWrap.innerHTML = "";
      playerWrap.appendChild(v);
      playerWrap.classList.remove("hidden");
      playBtn.textContent = "■ Stop";
      // play() itself happens once the loadedmetadata->seeked chain above
      // confirms we're actually positioned at seg.startTime -- not here.
    });
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
    body.appendChild(trimWrap);
    body.appendChild(playerWrap);
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
