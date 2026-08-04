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
| Live storyboard generation for a reviewer-typed keyword | ❌ | ✅ new |
| Editable storyboard timeline (reorder/delete/swap, live duration badge) | ❌ | ✅ new |
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
example/                        real per-shot pipeline artifacts for one worked example
                                 (used by both the original pipeline walkthrough and, now,
                                 as the source data for the live demo's one wired video)
plots/, visuals/                paper figures used elsewhere on the site

assets/js/
  dom-helpers.js                 el()/createDetails()/resolveMediaPath() etc., shared by
                                  app.js and everything below (split out to avoid a
                                  circular import between app.js and try-it-panel.js)
  semantic-search.js             client-side keyword embedding + cosine-similarity retrieval
  storyboard-editor.js           the editable timeline component (the centerpiece)
  render-ffmpeg.js               "Render final video" via ffmpeg.wasm, in the browser
  try-it-panel.js                glues the above together into the Home-page panel

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
                                  demo_video_links.csv + the {genre}/{id}/ folders
  export-embeddings.mjs          NEW: embeds example/'s per-shot descriptors for the live demo
  dev-server.mjs                 NEW: zero-dependency local static file server

docs/design-plan.md              full design rationale for the live-demo feature
DEPLOYMENT.md                    step-by-step: go from this folder to a live, reviewable site
```

## Changes to the original files

- `app.js`: added one import and three call sites to mount the new panel at
  the top of the Home page (`mountTryItPanel(...)`); moved the small
  DOM/media-path helpers it already had into `assets/js/dom-helpers.js` so
  the new modules could reuse them without a circular import. Nothing about
  the existing gallery/pipeline-walkthrough rendering logic changed.
- `data.json`: added one new top-level key, `"liveDemo"` (config for the new
  panel -- which videos are live-enabled, the Worker URL, example keyword
  chips). Everything else is untouched.
- `scripts/generate-data.mjs`: added the `LIVE_DEMO` config object that gets
  written into `data.json`'s new key, so regenerating data.json doesn't lose
  it.
- Removed the original repo's own scratch `instruction.md` (a prior build
  instruction for an unrelated "Figures" page addition, not part of the
  site itself).

## Quick start

```bash
npm install
npm run serve            # http://localhost:8080 -- static site, gallery works immediately
```

The gallery and pipeline walkthrough work immediately (same content as the
original site). The **live "Try it yourself" panel is disabled by default**
until you generate embeddings and deploy the Worker -- see below and
[`DEPLOYMENT.md`](DEPLOYMENT.md). Until then it fails gracefully to a
"browse the gallery below" message; it never breaks the rest of the page.

### Generating embeddings for the live demo

```bash
npm run build:embeddings
```

Downloads a small (~30MB) sentence-embedding model from the Hugging Face hub
on first run (needs outbound internet once; nothing at demo time does) and
writes `embeddings/documentary-2.json` from the real per-shot descriptors
already checked into `example/`. This is the one demo video fully wired for
live generation right now -- see "Known limitations" below for why only one,
and how to add more.

### Deploying so reviewers can actually use it

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full walkthrough: publishing
this folder to GitHub Pages, and deploying the Worker (Cloudflare account,
KV namespaces, secret API key, locking down CORS, double-blind anonymity
checklist).

## Known limitations

- **Only one demo video is wired for live generation**: `documentary/2`
  ("Can Dogs Talk?"), because it's the only source video with full per-shot
  descriptors (`example/shots`, `captions`, `asr`, `entities`, `background`)
  checked into this repo -- the same bundle the original site's pipeline
  walkthrough already used. To add another video, export its `example/`-style
  descriptor bundle from the actual pipeline (`src/pipeline/` in the main
  research repo), add an entry to `DEMO_VIDEOS` in
  `scripts/export-embeddings.mjs` and to `LIVE_DEMO.videos` in
  `scripts/generate-data.mjs`, then re-run both build scripts.
- **"Render final video" downloads the whole source video into the browser**
  before trimming it, because `documentary/2`'s "clips" are timestamp ranges
  within one long source file, not separate per-clip media files. This is
  fine for a single demo video but doesn't scale to a multi-hundred-MB
  feature-length source -- `render-ffmpeg.js` enforces a 300MB size cap and
  surfaces a clear error (rather than hanging or crashing the tab) so the
  reviewer can edit the storyboard down and retry. A real fix (pre-slicing a
  small "candidate reel" at build time) is a follow-up, not done here.
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
