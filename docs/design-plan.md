# Clips2Story demo website — interactive design plan

Prepared in response to `instruction/instruction.md`. Grounded in the current
site (`anonreview333.github.io/clips2story`, fetched and inspected directly —
`index.html` + `app.js` + `data.json`), the paper text (`instruction/paper.txt`),
and the actual pipeline code (`src/pipeline/`).

## 1. What reviewers most need

Reading the paper against the current site, three things matter most for a
Creative-AI-track reviewer, and the current site only covers the third one well:

1. **Does the LLM actually retrieve/select/reorder — or is it cherry-picked?**
   The paper's central claim is that this is a *training-free retrieval +
   planning* system, not memorized/scripted output. A static gallery of
   pre-rendered videos can't prove that; a reviewer has to take it on faith.
2. **Does it generalize beyond the handful of keywords shown?** The site
   currently ships exactly 2 keywords × 2 videos × 5 genres = 20 fixed
   combinations (`data.json`). A skeptical reviewer's first instinct is "what
   if I ask for something else?" — and today there is no way to find out.
3. **How does the pipeline actually work, mechanically?** This the site
   already does well: the home panel's 8-step walkthrough (shots → metadata →
   retrieval pool → prompt → LLM JSON → narration/visual matching → final
   video) with real intermediate artifacts is a genuine strength worth keeping
   as-is.

The gap is (1) and (2): the demo needs to let a reviewer **type a request the
authors didn't choose** and see the retrieval + planning happen for real. It
does not need to run the *whole* pipeline live — shot detection and multimodal
metadata extraction are the slow, GPU-bound stages (~8–15 min per video per
the paper's own latency breakdown) and are exactly the part that's safe to
precompute, because they don't depend on the reviewer's keyword at all.

## 2. What comparable projects do

- Sibling paper **TeaserGen** (Xu & Dong, ICLR 2025 — same lab, cited as a
  baseline here) ships only a static example gallery; its GitHub repo notes an
  interactive Gradio demo is still "coming soon." **REGen** (the strongest
  baseline in this paper) has no live demo either. So a working live component
  would be a genuine point of differentiation within this exact sub-area, not
  table stakes to match.
- The common pattern for creative-AI demos that do go interactive (Hugging
  Face Spaces / Gradio demos referenced for NeurIPS 2025 video/image papers
  such as MultiTalk, Wan-Move, ICEdit) is a **thin hosted inference
  endpoint behind a simple form**, not raw model weights in the browser — the
  heavy model stays server-side, the browser just sends a request and renders
  the result. That's the shape worth borrowing, scaled to this pipeline's
  actual bottlenecks.

## 3. Three designs, ranked

| | Reviewer value | Effort | Hosting/GPU | Reliability |
|---|---|---|---|---|
| **A. Semantic search over an expanded precomputed bank** | Medium | Low (days) | None | Excellent (100% static) |
| **B. Live storyboard planner + editable timeline + on-demand render** | High | Medium (1–2 weeks) | One tiny stateless serverless function (planning only); rendering runs in the reviewer's own browser, no host of ours needed | Good, with fallback to A and to preview-only |
| **C. Full live pipeline on reviewer-uploaded video** | Highest, if it worked | High (weeks) | Persistent GPU box | Poor — not recommended |

**Infrastructure constraint driving this revision:** compute access here is
a university HPC cluster only — a SLURM batch cluster, not a place to run an always-on,
publicly-reachable web service (jobs have walltime limits, compute nodes
aren't set up for arbitrary inbound traffic from reviewer browsers, and
running a persistent internet-facing daemon on shared research compute isn't
what it's for or reliably available for months unattended). So this plan
assumes **no persistent server of any kind** — the only non-static piece is
one free, stateless serverless function (e.g. a Cloudflare Worker) that does
nothing but hold an API key and forward the one LLM planning call; everything
else, including rendering, is either precomputed at build time or runs
entirely in the reviewer's browser.

### A. Expanded precomputed bank + free-text semantic search
Precompute ~15–20 keywords per source video (instead of today's 2), ship
their sentence-transformer embeddings in `data.json`, and let the reviewer
type free text; a client-side cosine-similarity match (no backend at all —
`src/pipeline/embeddings/__init__.py` already L2-normalizes its
sentence-transformer vectors, so cosine reduces to a dot product doable in a
few lines of JS) picks the nearest precomputed result and plays it, labeled
"closest existing example." Zero risk, zero moving parts, but every result is
still one of N fixed videos someone already picked — it doesn't prove
generalization, just breadth.

### B. Live storyboard planner with an editable timeline (recommended)
Reviewer picks one of the existing precomputed source videos and types **any**
keyword. A minimal serverless function runs the *actual* Clips2Story-NF
retrieval + planning step from the paper — reusing the real prompt template
verbatim (`src/pipeline/planner_llm_no_narration.py`, which matches
Appendix B exactly) — against that video's precomputed shot descriptors, and
returns a real storyboard JSON in well under a minute.

Critically, that JSON — not a rendered video — is the primary result the UI
shows. The paper's own framing is that Clips2Story returns "an explicit,
human-readable narrative proposal that creators can inspect and revise before
assembly" (§Introduction); a demo that immediately autoplays a final cut
skips past exactly the artifact the paper is arguing matters. So the result
renders as an **editable storyboard timeline** — draggable, deletable,
swappable segment cards — and only *then* does the reviewer hit "preview" to
play it. See §4a for the full component design. Because *preview* playback is
done by seeking within already-hosted clip files (no rendering, no ffmpeg, no
GPU, ever), every edit the reviewer makes re-previews instantly and purely
client-side — no round trip to the LLM or any backend is needed to see the
effect of a reorder or a deletion.

Once satisfied with the edited storyboard, the reviewer can go one step
further and **render it into a real, single, downloadable video** — not just
the seek-based preview. Rendering is genuinely different work from planning
(frame-accurate cuts need ffmpeg re-encoding via `filter_complex` trim, not a
fast keyframe-aligned stream-copy — see `FRAME_ACCURATE_RENDERING_FIX.md` for
why the naive approach loses seconds of accuracy), which normally means a
real server process with ffmpeg installed. With no persistent host available,
this instead runs as **`ffmpeg.wasm` in the reviewer's own browser**: fetch
the already-hosted source clip bytes for just the segments in the current
storyboard, run the same trim-filter + concat approach client-side, and hand
back a real MP4 blob with a download link. No server of ours is involved at
all. It mirrors the *approach* in `src/pipeline/renderer.py` /
`FRAME_ACCURATE_RENDERING_FIX.md` (trim filters, not keyframe-aligned concat)
rather than literally calling that Python function, and the UI copy should
say so plainly rather than implying it's the identical code path — see §7.
It will also be somewhat slower than native ffmpeg (WASM overhead, one-time
~25–30MB library download cached after first use) — worth surfacing as a
realistic wait, not hiding it.

This works because of a fact already visible in the paper: multimodal
metadata extraction is the only genuinely slow, GPU-bound stage, and it is
explicitly reusable across prompts ("Multimodal metadata is extracted only
once for each input video and can be reused across different editing
prompts," §Computational Cost). Everything downstream of that — keyword
retrieval and LLM planning — is fast (the appendix's per-stage latency table
puts keyword retrieval + LLM generation at under ~2.5 minutes combined for a
54-minute source video; a demo video's small pool will be faster still).

**Scope: NF live only. ND stays precomputed, not a near-term phase 2.** The
live path is Clips2Story-NF, full stop. NF needs nothing beyond the LLM call
itself — no TTS, no narration-visual matching — which is exactly what keeps
this achievable with zero persistent infrastructure. ND would need:
- **Narration-to-visual matching**, which actually *could* stay
  infra-free — precompute frame-level CLIP embeddings for the demo videos'
  candidate pools (the pipeline already extracts CLIP features for
  background classification) and reduce matching to a client-side
  nearest-neighbor lookup, the same trick as clip retrieval in §5.
- **TTS synthesis (VITS)**, which cannot: it needs a real PyTorch
  model-serving runtime, and there is no persistent host to put one on.
  Swapping in a different TTS engine (e.g. the browser's built-in Web Speech
  API) to dodge that would produce a different voice than the one actually
  evaluated in the paper — a fidelity loss significant enough to not be worth
  it just to check the "live" box, per the "don't overstate" goal in §7.

So: this plan does not include a path to live ND generation. If persistent
compute becomes available later (e.g. institutional hosting credits, a
collaborator with a spare server), narration-visual matching could be added
cheaply, but VITS synthesis is the actual blocker and should be the thing
that decides whether ND-live is worth revisiting. Until then, the existing
precomputed ND gallery entries (already on the site) remain the reviewer's
only way to experience ND — which is fine, since NF is what the live/editable
path is designed to showcase, and Table 5's ND numbers are already visible
in the gallery today.

### C. Full pipeline on reviewer-uploaded footage — not recommended
Would require running shot detection, WhisperX, BLIP, GroundingDINO, and CLIP
live, i.e. the paper's own reported ~8–30 minutes per video, on a GPU box that
has to stay up and unattended through the entire review period, plus queuing
for concurrent reviewers. It also cuts against the paper's own stated
limitation about "misleading recontextualization" of uncurated footage
(§Discussion) — an anonymous, unmoderated live pipeline on arbitrary uploads
is the worst-case version of that risk. Good camera-ready-stage ambition, bad
review-period bet.

## 4. Recommended design and exact reviewer flow

Ship **B**, with **A** wired in underneath as the automatic fallback whenever
B is slow, over quota, or erroring — so the "try it yourself" panel never
dead-ends.

**Flow:**

1. Reviewer opens a new **"Try it yourself"** panel, placed above the existing
   genre gallery on Home. It shows a row of ~8–10 thumbnails (the existing
   precomputed source videos, reusing the genre tabs already in the sidebar)
   plus a text box: *"Type a theme (e.g. 'friendship', 'betrayal', 'career
   change')"* with 3–4 clickable example chips.
2. On submit, a status strip appears that mirrors the wording already used in
   the home-panel walkthrough — "Retrieving relevant clips…" → "Planning
   storyboard with GPT…" → "Ready" — so the live run visibly maps onto the
   pipeline the reviewer just read about two scrolls up.
3. The result renders first as the **storyboard editor** (§4a), not a video:
   an ordered list of segment cards the LLM proposed, labeled **"Clips2Story-NF
   storyboard — generated live for your keyword just now,"** clearly distinct
   from gallery entries labeled **"Precomputed example."** The reviewer can
   reorder, delete, or swap cards before ever watching a frame — this is
   the point of the demo, not a step on the way to the point.
4. A **"▶ Preview cut"** button plays the current (possibly edited) sequence
   via in-browser EDL playback across the precomputed clip files — no
   rendering, no backend call, works identically whether the sequence is the
   original AI proposal or the reviewer's edited version. This is always
   available and never depends on anything but the browser.
5. When the reviewer is happy with the edit, a **"🎬 Render final video"**
   button runs `ffmpeg.wasm` in their own browser against the current
   segment list, producing one real MP4 and a **"Download MP4"** link — no
   request to us at all. This step is explicitly optional and additive — the
   free instant preview from step 4 keeps working even if the reviewer's
   browser can't or won't run it (see §5).
6. Below the editor, three foldable panels (reusing the `createDetails`
   component already in `app.js`): the retrieved clip pool (including
   unselected candidates, feeding the "swap" action in §4a), the exact prompt
   sent, and the raw JSON the LLM returned — extending the transparency the
   home panel already provides to this new live path instead of introducing a
   different idiom.
7. On planning timeout (~45s) or error: swap in nearest precomputed match from
   design A with an inline note ("Live planning is temporarily unavailable —
   showing a precomputed example for a similar theme") and a retry button.
   If `ffmpeg.wasm` fails, is too slow, or the reviewer's browser doesn't
   support it: keep the step-4 preview as the experience, with a note that it
   approximates but doesn't exactly equal the frame-accurate final cut. Never
   a blank or broken state, at either stage.

### 4a. The storyboard editor component

This is the new centerpiece, not a variation on the existing video grid — it
needs its own component because nothing on the site today shows an *ordered,
mutable* sequence.

- **Layout**: a vertical list of cards (works on mobile without redesign;
  reuses the card/`createDetails` visual language already on the site rather
  than introducing a horizontal timeline-scrubber idiom that would need much
  more custom CSS/JS to get right). Each card shows:
  - a poster-frame thumbnail (reuse the existing per-clip
    `frames/frame_XXXXXX.png` extraction already used by `buildFramesGrid` —
    just pick the frame nearest `start_time`)
  - source video + original clip id, trimmed duration, and the transcript
    text falling inside that trim (already returned by the LLM per the NF
    prompt's output schema — no extra step needed)
  - a drag handle (native HTML5 Drag-and-Drop API — no external
    sortable-list dependency needed for a single-column list)
  - a **"×" delete** button, with a toast + "Undo" (edits should be cheap to
    try and cheap to take back, or reviewers will be reluctant to touch
    anything)
  - a **"⇄ Swap"** button opening a small popover of retrieved-but-unused
    clips from the same pool (thumbnail + caption), so reviewers can see and
    use the alternates the retrieval step surfaced but the LLM didn't pick —
    good evidence retrieval is doing real filtering, and directly exercises
    the "creators can revise" claim.
- **Live total-duration badge** at the top ("42s — target 30–60s" — shortened
  from the paper's 3-5 min target so the in-browser render stays fast),
  colored to match the target range, updating on every edit — mirrors the
  paper's own duration-vs-target analysis (Fig. 2 / §Results) and gives
  reorder/delete edits an immediate, legible consequence.
- **"↩ Reset to AI proposal"** to discard edits and return to the original
  LLM output — makes experimentation feel safe.
- All of the above is **pure client-side state** (an in-memory array of
  segment objects) — reordering, deleting, swapping, and re-previewing never
  touch the network. Only the *initial* proposal requires the LLM call; every
  edit after that is local, instant, and can't fail or time out. This is a
  reliability win as much as a UX one.
- **Three clearly labeled states**, so the reviewer always knows what they're
  looking at: **"AI proposal"** (untouched LLM output) → **"Edited
  storyboard"** (once any card has been moved/deleted/swapped) →
  **"Rendered final video"** (once "Render final video" has completed). The
  first two are always free/instant/client-only; the third runs entirely in
  the browser too, just noticeably slower.
- **"🎬 Render final video"**: runs `ffmpeg.wasm` in the browser against the
  current segment array (fetching only the byte ranges/clip files it needs
  from the same already-hosted media used for playback), applying trim +
  concat filters mirroring the approach in `FRAME_ACCURATE_RENDERING_FIX.md`,
  and produces a downloadable MP4 blob + **"Download MP4"** button — no
  network request to any service of ours. Shows a status message set to
  realistic expectations — *"Rendering final video in your browser
  (~1–3 min depending on device)…"* — since WASM ffmpeg is slower than
  native and shouldn't be presented as instant. Re-editing the storyboard
  after a render simply drops back to the "Edited storyboard" state and
  re-enables this button.
- **ND is out of scope for this component** (see §3's scope note) — the
  editor ships for Clips2Story-NF only; ND remains available solely through
  the existing precomputed gallery.

## 5. Precomputed vs. live vs. fallback

**Precomputed (build time, committed to the repo/LFS, unchanged from what
already exists for these stages):**
- Shot segmentation and all multimodal descriptors (transcript, caption,
  entities, background) for the ~8–10 demo videos — already produced by the
  existing pipeline and already partly shipped under `example/` for the home
  panel.
- Per-shot sentence-transformer embeddings for retrieval, L2-normalized
  (`src/pipeline/embeddings`) — export as JSON alongside each demo video.
- Today's 20 fixed gallery combinations — keep as-is, they're good reference
  points and the fallback target for design A.

**Live at request time — planning (fast, no GPU, stateless edge function):**
- Embed the reviewer's typed keyword — either one call to a hosted embeddings
  endpoint, or (nicer, removes even that network hop) the same small
  sentence-transformer model bundled client-side via `transformers.js`/ONNX.
- Cosine-similarity ranking + the paper's duration-budget filter — pure
  arithmetic over already-shipped vectors, runs entirely in the browser.
- One LLM call using the verbatim NF prompt template, against only that one
  video's small retrieved pool (not the full 100-video corpus) — this is the
  only step that must go through a backend, because it's the only step that
  needs a secret API key.
- Client-side EDL playback assembly for the free "Preview cut" — no
  rendering, just `currentTime` seeks across existing hosted clip files.

**Live at request time — rendering (slower, entirely in the reviewer's
browser, no service of ours involved, only triggered when they explicitly
ask for it):**
- The edited segment list drives `ffmpeg.wasm`, running in-browser, which
  fetches only the needed clip bytes from the already-hosted media, applies
  trim + concat filters mirroring the frame-accurate approach in
  `src/pipeline/renderer.py` / `FRAME_ACCURATE_RENDERING_FIX.md`, and
  produces a downloadable MP4.
- This is opt-in and additive by design: nobody is blocked on it, since
  "Preview cut" (below) already gives a working, instant experience of any
  edit. Rendering only upgrades that into a real downloadable file, and if a
  reviewer's device can't handle it, nothing else in the demo is affected.

**Client-side only (no network at all, including after the initial LLM call):**
- Every storyboard edit — reorder, delete, swap-in-alternate, reset — is a
  local array mutation. "Preview cut" always re-runs the same in-browser EDL
  player against whatever the current array is, and "Render final video"
  (above) is also entirely client-side. This is what makes the storyboard
  editor (§4a) safe to expose live: after the one initial LLM call, nothing a
  reviewer does can fail due to something on our end being down.

**Fallback / abuse handling:**
- Planning: hard timeout ~45–60s, then automatic fallback to design A's
  nearest precomputed match. Per-IP rate limit (e.g. 8 live generations/hour)
  enforced in the serverless function; beyond that, the panel explains the
  limit and points at the gallery. Response cache keyed on
  `(video_id, normalized_keyword)` in the same function (KV store) — repeat
  or concurrent identical requests from different reviewers are instant and
  free after the first.
- Rendering: since it runs in the reviewer's own browser, there's no server
  quota or shared queue to protect — the only failure modes are per-device
  (older/low-memory browsers, WASM disabled, tab backgrounded mid-render).
  Wrap the `ffmpeg.wasm` call in its own timeout (~3 min) and try/catch, and
  on any failure fall back to the step-4 EDL preview with a note that it
  approximates the frame-accurate final cut. No rate limiting needed here —
  there's nothing shared to rate-limit.
- A single config flag (in `data.json` or a small `config.json`) to disable
  the live planning panel entirely without a redeploy, for whenever the
  serverless function needs maintenance — degrades gracefully to
  gallery-only. Rendering has no equivalent "outage" mode since it depends on
  nothing of ours; it can only fail per-device, handled above.

## 6. Concrete sections, components, tech

Keep the existing stack (static HTML + one vanilla-JS module + Tailwind CDN +
GitHub Pages + Git LFS for media) — it already works, is dependency-free, and
matches the double-blind anonymity constraints. Add:

- **New home-page section**, above the genre gallery: `<section id="try-it">`
  — video picker + text input + status strip + storyboard editor + folded
  detail panels. Implemented as new functions in `app.js` (or a split-out
  `planner.js` module) alongside the existing `renderHomePanel`.
- **`storyboardEditor(segments, pool)`** component: renders the card list
  described in §4a from an in-memory array of segments plus the full
  retrieved pool (for the swap popover); owns reorder/delete/swap/reset state;
  re-renders the duration badge on every mutation; exposes the current
  segment array to the preview button. This is the main new piece of client
  logic.
- **`sequencePlayer(edl)`** component: given a list of
  `{clip_path, start_time, end_time}` (the storyboard editor's current
  state), drives a single `<video>` element through them in order (listen
  for `timeupdate`/`ended`, swap `src`/seek, small crossfade via opacity to
  hide the cut). Everything else reuses existing patterns
  (`setVideoMp4FromRepoPath`, `createDetails`, `resolveMediaPath`).
- **`renderStoryboard(edl)`** component: loads `ffmpeg.wasm` (lazily, only
  when "Render final video" is first clicked, to avoid paying the ~25–30MB
  download cost for reviewers who never use it), fetches the needed clip
  bytes, runs trim + concat filters mirroring the frame-accurate approach in
  `src/pipeline/renderer.py`, and resolves to a downloadable `Blob` URL. The
  only genuinely new piece of client logic besides the editor itself.
- **`embeddings/<video_id>.json`** per demo video: shot ids + L2-normalized
  vectors, exported straight from the existing pipeline module.
- **One serverless function**, for planning only (Cloudflare Worker is the
  natural fit: generous free tier at low review-period volume, edge latency
  worldwide, a `*.workers.dev` subdomain that stays anonymous, built-in KV
  for the cache/rate-limit). Responsibilities: validate input, embed the
  query (or accept a client-computed embedding), call the LLM with the exact
  NF prompt template, return JSON, cache, rate-limit. This is the only piece
  of infrastructure beyond GitHub Pages and a university HPC cluster (the latter used only to
  precompute demo-video assets at build time, not at request time) — no
  GPU, no persistent process, no author-identifying strings in code or error
  messages.
- **Config flag** in `data.json` (or a small `config.json`):
  `"liveDemoEnabled"`, checked at page load, to disable the planning panel
  without a redeploy if the serverless function needs maintenance. Rendering
  needs no equivalent flag since it has no shared backend to take down.

## 7. Making it more persuasive without overstating

- The "Render final video" button runs `ffmpeg.wasm` in the browser using the
  same *frame-accurate trim-filter approach* as the paper's actual renderer
  (`src/pipeline/renderer.py`, per `FRAME_ACCURATE_RENDERING_FIX.md`) — but
  it is a separate, browser-side reimplementation, not a call into that exact
  code. Say so precisely in the UI copy ("rendered client-side using the same
  frame-accurate cutting approach as the paper's pipeline") rather than
  implying literal code reuse — accurate framing here matters more than a
  slightly stronger-sounding claim, especially since a technically-minded
  reviewer could ask.
- Label every clip **"Clips2Story-NF"** or **"Clips2Story-ND"** explicitly,
  never just "our method" — the paper's human evaluation only scored
  narration-effectiveness for ND, and NF has no narration; the UI shouldn't
  blur that distinction.
- Put the actual Table 5 numbers next to the gallery, not just the videos —
  e.g. "+1.26 coherence, +1.31 keyword alignment vs. REGen (human eval, 5-pt
  Likert)" — so the demo visibly cashes out into the paper's quantitative
  claims instead of relying on vibes alone.
- Keep showing rejected-but-retrieved clips (the home panel's "all keyframes"
  vs. "filtered keyframes" contrast) for the new live path too — it's concrete
  evidence the retrieval step is doing real filtering, not cherry-picking.
- Add a short, visible line echoing the paper's own Discussion section: *"This
  is an editorial proposal for a human editor to revise, not an authoritative
  final cut."* Surfacing a limitation the authors already state in the paper
  reads as intellectual honesty to a reviewer, not a weakness — and it's
  specifically relevant to the sensitive-domain (news/documentary) misuse risk
  the paper itself raises.
- Be explicit in the UI copy about what's live vs. precomputed ("using
  pre-extracted descriptors for this video, we plan a new storyboard live for
  your keyword") so nobody reads the demo as claiming the *whole* pipeline —
  including shot detection and captioning — runs on demand.

## Build order

1. Export embeddings + expand the keyword bank for design A (low risk,
   ships value immediately, becomes the fallback for B).
2. Stand up the serverless function (NF only) + "Try it yourself" panel
   against 2–3 demo videos first; validate latency and failure handling
   before wiring in all ~8–10.
3. Build `storyboardEditor` (reorder/delete/swap/duration badge/reset) and
   `sequencePlayer`, wired to the same 2–3 videos — this is the part worth
   the most iteration, since it's the artifact reviewers will actually judge
   the "editable storyboard" claim by. Ships with preview-only (no render
   button yet) and is already a complete, demoable experience on its own.
4. Add `renderStoryboard` (`ffmpeg.wasm` in-browser rendering) and wire up
   "Render final video" / "Download MP4" — kept as its own milestone since
   it needs its own testing across browsers/devices for performance and
   failure handling (§5), even though it needs no infrastructure of ours.
5. Add the persuasiveness copy/labels from §7 across the new panel and the
   existing gallery.

ND live generation is not on this roadmap (§3) — VITS synthesis needs a
persistent model-serving process this plan doesn't have available. Revisit
only if persistent compute becomes available separately from a university HPC cluster.
