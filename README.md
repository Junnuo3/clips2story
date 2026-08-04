# Clips2Story interactive demo (fork)

An interactive fork of the anonymous Clips2Story demo website, built for
double-blind NeurIPS Creative AI Track review. It keeps the original
precomputed example gallery and pipeline walkthrough as-is, and adds a live
**"Try it yourself" storyboard planner**: type any keyword, watch
Clips2Story-NF retrieve real footage and plan a real storyboard for it, then
reorder / delete / swap clips in an editable timeline, preview the edit
instantly, and optionally render a real downloadable video -- all client-side
except for one small LLM call. See [`docs/design-plan.md`](docs/design-plan.md)
for the full design rationale (why this shape, what was ruled out, and why).

**This is a separate, self-contained project.** It was produced by cloning
the original demo site's repository, modifying it here, and is meant to be
pushed to its own new GitHub repository -- nothing in this folder writes back
to the original.

## What's new here vs. the original site

| | Original site | This fork |
|---|---|---|
| Example gallery (5 genres × 2 videos × 2 keywords, NF/ND/baselines) | ✅ | ✅ unchanged |
| Home-page pipeline walkthrough (shots → metadata → prompt → LLM → render) | ✅ | ✅ unchanged |
| Live storyboard generation for a reviewer-typed keyword | ❌ | ✅ new, on its own "Live Demo" nav page |
| Choice of source video for live generation | ❌ | ✅ new -- auto-discovered from `embeddings/*.json`, one video wired today |
| Editable storyboard timeline (reorder/delete/swap, live duration badge) | ❌ | ✅ new -- target output is 30-60s (short, so rendering stays fast) |
| Long transcript/caption text on a storyboard card | n/a | ✅ clamps to 2 lines with a "Show more" toggle instead of being cut off |
| "Render final video" -- a real downloadable MP4 of the edited storyboard | ❌ | ✅ new (in-browser, via ffmpeg.wasm) |

## Why this shape (short version)

Compute access for this project is a university HPC cluster only -- a SLURM batch cluster,
not a place to host an always-on public web service. So the live demo is
built around **zero persistent servers**:

- **Retrieval** (matching a typed keyword to candidate footage) runs
  entirely in the browser: shot embeddings are precomputed at build time
  (`scripts/export-embeddings.mjs`), the reviewer's keyword is embedded with
  the same small model client-side, and cosine similarity is a dot product.
- **Storyboard editing and previewing** are pure client-side state and
  `<video>` seeking -- no network call, ever, for any edit.
- **Rendering the final video** runs in the browser too, via `ffmpeg.wasm`.
- The **one exception** is the LLM planning call itself, which needs a secret
  API key held somewhere public -- that's a single small, stateless
  Cloudflare Worker (`worker/`), not a compute host. See
  [`docs/design-plan.md`](docs/design-plan.md) for the full reasoning.

## Repository layout

```
index.html, app.js              the original site shell + gallery logic (lightly modified,
                                 see "Changes to the original files" below)
data.json                       gallery data + new "liveDemo" config block
{documentary,film,lecture,news,vlog}/   precomputed example media (Git LFS)
example/                        real per-shot pipeline artifacts. example/{shots,captions,asr,
                                 entities,background} is the original worked example (documentary/2,
                                 used by both the pipeline walkthrough and its live-demo bundle).
                                 example/<video-id>/ (e.g. example/documentary-1/) holds the same
                                 5 files for additional live-demo videos, one folder per video.
plots/, visuals/                paper figures used elsewhere on the site

assets/js/
  dom-helpers.js                 el()/createDetails()/resolveMediaPath() etc., shared by
                                  app.js and everything below (split out to avoid a
                                  circular import between app.js and try-it-panel.js)
  semantic-search.js             client-side keyword embedding + cosine-similarity retrieval
  storyboard-editor.js           the editable timeline component (the centerpiece)
  render-ffmpeg.js               "Render final video" via ffmpeg.wasm, in the browser
  try-it-panel.js                glues the above together into the panel mounted on the
                                  standalone "Live Demo" page (app.js's renderLiveDemoPanel)

embeddings/                      build output of scripts/export-embeddings.mjs (see below).
                                  Generated, not hand-written -- but DOES need to be committed:
                                  GitHub Pages serves static files as-is, with no build step,
                                  so the browser needs this file to already exist in the repo.

worker/                          the one server-side piece: a Cloudflare Worker that holds
                                  the LLM API key and runs the planning call
  src/index.js
  wrangler.toml
  package.json

scripts/
  generate-data.mjs              (from the original site) rebuilds data.json from
                                  demo_video_links.csv + the {genre}/{id}/ folders; also
                                  auto-discovers liveDemo.videos from embeddings/*.json
  export-embeddings.mjs          NEW: embeds each live-demo video's per-shot descriptors
                                  (DEMO_VIDEOS list); skips any video whose bundle isn't
                                  precomputed yet instead of failing the whole run
  dev-server.mjs                 NEW: zero-dependency local static file server

docs/design-plan.md              full design rationale for the live-demo feature
DEPLOYMENT.md                    step-by-step: go from this folder to a live, reviewable site
```

## Changes to the original files

- `app.js`: added one import and a new routable "Live Demo" nav page
  (`renderLiveDemoPanel`, mounting `mountTryItPanel(...)`) alongside the
  existing Home/genre pages; the Home page keeps a small teaser link to it
  instead of embedding the panel inline. Moved the small DOM/media-path
  helpers it already had into `assets/js/dom-helpers.js` so the new modules
  could reuse them without a circular import. Nothing about the existing
  gallery/pipeline-walkthrough rendering logic changed.
- `data.json`: added one new top-level key, `"liveDemo"` (config for the new
  panel -- which videos are live-enabled, the Worker URL, example keyword
  chips). Everything else is untouched.
- `scripts/generate-data.mjs`: added `buildLiveDemo()`, which auto-discovers
  the `liveDemo.videos` list from `embeddings/*.json` at build time (instead
  of a hand-maintained list) and writes it into `data.json`'s new key.
- Removed the original repo's own scratch `instruction.md` (a prior build
  instruction for an unrelated "Figures" page addition, not part of the
  site itself).

## Quick start

```bash
npm install
npm run serve            # http://localhost:8080 -- static site, gallery works immediately
```

The gallery and pipeline walkthrough work immediately (same content as the
original site). The **live "Try it yourself" panel** lives on its own "Live
Demo" nav page and **is disabled by default** until you generate embeddings
and deploy the Worker -- see below and [`DEPLOYMENT.md`](DEPLOYMENT.md).
Until then it fails gracefully to a "browse the genre pages instead" message;
it never breaks the rest of the site.

### Generating embeddings for the live demo

```bash
npm run build:embeddings   # then: npm run build:data (picks up the new video automatically)
```

Downloads a small (~30MB) sentence-embedding model from the Hugging Face hub
on first run (needs outbound internet once; nothing at demo time does), then
embeds every video listed in `DEMO_VIDEOS`
(`scripts/export-embeddings.mjs`) that already has a precomputed per-shot
descriptor bundle, writing one `embeddings/<id>.json` per video.
`scripts/generate-data.mjs` then auto-discovers `liveDemo.videos` from
whatever's in `embeddings/` -- no manual list to keep in sync. Today only
`documentary-2` ("Can Dogs Talk?") has its bundle checked in, so it's the
only video that shows up in the picker -- see "Known limitations" below for
what's needed to add the other three that already have a local source video
(`documentary-1`, `film-2`, `vlog-1`), and how to go beyond those.

### Deploying so reviewers can actually use it

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full walkthrough: publishing
this folder to GitHub Pages, and deploying the Worker (Cloudflare account,
KV namespaces, secret API key, locking down CORS, double-blind anonymity
checklist).

## Known limitations

- **Only one demo video is wired for live generation today**: `documentary/2`
  ("Can Dogs Talk?"), because it's the only source video with a precomputed
  per-shot descriptor bundle (`shots`, `captions`, `asr`, `entities`,
  `background` JSON -- checked into `example/`) -- the same bundle the
  original site's pipeline walkthrough already used. The picker UI and build
  scripts already support any number of videos (see "Generating embeddings"
  above); adding one is a **precompute step, not a code change**:
  1. Run the shot detection + multimodal metadata pipeline (`src/pipeline/`
     in the main research repo -- shot boundaries, captioning, ASR, entity
     and background extraction; captioning/ASR want a GPU, the rest run
     fine on CPU) on the video's source file, producing the same 5 JSON
     files as `example/shots/shots.json` etc.
  2. Drop them at `example/<id>/{shots,captions,asr,entities,background}.json`
     (flat) or `example/<id>/<name>/<name>.json` (nested, matching the
     original layout) -- `<id>` is `<genre>-<setId>`, e.g. `film-2`.
  3. **The video's source file must also be a real local file in this repo**
     (not just a YouTube link), because the ffmpeg.wasm renderer downloads
     it directly by path (see the next limitation). `documentary-1`,
     `film-2`, and `vlog-1` already have one checked in and are the natural
     next 3 -- their `DEMO_VIDEOS` entries are already in
     `scripts/export-embeddings.mjs`, just waiting on their bundle. The
     remaining 6 videos (`film-1`, `lecture-1`, `lecture-2`, `news-1`,
     `news-2`, `vlog-2`) only have their *output* clips checked in, not the
     original source -- that needs downloading from the YouTube link in
     `demo_video_links.csv` and adding it to the repo (GitHub LFS caps a
     single object at 2GB; `scripts/downsample_media.py` can compress it
     down first) before step 1, plus a new `DEMO_VIDEOS` entry.
  4. Run `npm run build` (`build:embeddings` then `build:data`). No other
     code change needed -- the video shows up in the live-demo picker
     automatically.
- **"Render final video" downloads the whole source video into the browser**
  before trimming it, because each wired video's "clips" are timestamp
  ranges within one long source file, not separate per-clip media files.
  This is fine for a handful of demo videos but doesn't scale to a
  multi-hundred-MB feature-length source -- `render-ffmpeg.js` enforces a
  300MB size cap and surfaces a clear error (rather than hanging or crashing
  the tab) so the reviewer can edit the storyboard down and retry. A real
  fix (pre-slicing a small "candidate reel" at build time) is a follow-up,
  not done here.
- **"Render final video" is a browser-side reimplementation**, not a call
  into the paper's actual Python renderer (`src/pipeline/renderer.py`'s
  `render_from_timeline()`). It mirrors the same frame-accurate trim + concat
  *approach* (see `FRAME_ACCURATE_RENDERING_FIX.md` in the main research
  repo) using `ffmpeg.wasm`, but it is separate code. Say so in any
  reviewer-facing copy -- don't imply literal code reuse.
- **Live generation is Clips2Story-NF only.** ND needs narration-visual
  matching (feasible client-side with precomputed frame embeddings, not yet
  built) and real VITS TTS synthesis (needs an actual PyTorch runtime, which
  has no home given this project's no-persistent-server constraint). See
  `docs/design-plan.md` §3 for the full reasoning. ND stays available through
  the existing precomputed gallery.
- **Two external CDN dependencies at runtime**: `@huggingface/transformers`
  (retrieval embeddings) and `@ffmpeg/ffmpeg`/`@ffmpeg/core` (rendering),
  both loaded from jsDelivr. If a reviewer's network blocks that CDN, live
  planning still works (it doesn't need `ffmpeg.wasm`) but "Render final
  video" surfaces a clear error rather than hanging.
- **The Worker has no LLM API key by default.** Without one deployed and
  wired into `data.json`'s `liveDemo.plannerEndpoint`, every submission hits
  the fallback path. This is intentional -- an unconfigured deployment should
  degrade, not error.

## License / anonymity note

This fork carries no author-identifying information (same convention as the
original repo). Before deploying, double-check `worker/wrangler.toml`,
commit messages, and any custom domains you add don't introduce any --
see the checklist in `DEPLOYMENT.md`.
