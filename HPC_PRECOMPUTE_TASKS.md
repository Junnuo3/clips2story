# HPC precompute tasks for the Clips2Story live demo

Hand this file to Claude (or whoever/whatever is running the extraction) on
the HPC cluster. It's self-contained -- no other context from the demo repo
conversation is assumed. It describes exactly what to produce, in what
format, for which videos, and how to hand the result back.

## What this is for

This repo (`clips2story-demo-v2`) has a "Live Demo" page where a visitor
types a keyword and gets a real, LLM-planned storyboard generated live from
one of the site's source videos. That only works for a video if it has a
**precomputed per-shot descriptor bundle**: shot boundaries + a caption,
transcript, background label, and detected entities for every shot. Today
only one of the site's 10 source videos (`documentary/2`, "Can Dogs Talk?")
has this bundle. This task is to produce it for the other 9.

**This repo does not contain the extraction pipeline itself** (shot
detection, captioning, ASR, entity/background extraction) -- that code lives
in the main Clips2Story research repo (`src/pipeline/`), separately from
this demo site fork. If you have that repo checked out on the cluster, use
it directly -- it's already tuned to produce exactly this schema (the demo's
`example/` bundle is real pipeline output). If you don't have access to it
here, the schema below is the actual contract this demo depends on --
produce it with whatever models are available (suggestions per field below)
and it will work the same either way.

## Output contract (exact schema, from real committed output)

For a video with descriptor-bundle id `<id>` (defined below, e.g.
`film-2`), produce 5 JSON files and place them at:

```
example/<id>/shots.json
example/<id>/captions.json
example/<id>/asr.json
example/<id>/entities.json
example/<id>/background.json
```

(A per-video folder with flat filenames. This is a new, simpler layout
added alongside the original single-video layout at `example/shots/shots.json`
etc. -- both are supported by the demo's build script, so just use the
`example/<id>/*.json` flat form for every new video.)

All of `captions.json` / `asr.json` / `entities.json` / `background.json`
are objects keyed by `shot_id` (every shot from `shots.json` must have a key
in each, even if the value is an empty list). Every shot ID inside one
video's bundle is self-contained to that bundle -- no need for global
uniqueness across videos.

### `shots.json` -- array, one shot per entry, in chronological order

```json
[
  { "shot_id": "v1_s0000", "start_time": 0.0,  "end_time": 0.55, "video_id": "v1" },
  { "shot_id": "v1_s0001", "start_time": 0.55, "end_time": 7.62, "video_id": "v1" }
]
```
- `shot_id`: `v1_s%04d` (always `video_id="v1"` for a per-video bundle --
  it's just a local tag, not a global identifier).
- `start_time` / `end_time`: seconds from the start of the source video.
- Shot boundary detection: any content-aware scene-cut detector is fine
  (e.g. PySceneDetect's `ContentDetector`). CPU-only, no GPU needed. For
  reference, the one existing bundle (`documentary/2`, 53:55 long) produced
  695 shots -- expect roughly that density (~7-8s average shot length).

### `captions.json` -- object, `shot_id` -> array with one caption entry

```json
{
  "v1_s0000": [{ "caption": "a dark blue background with the words pbs" }],
  "v1_s0001": [{ "caption": "a blue and white logo with the letter p in the middle" }]
}
```
- One short, plain-English visual caption per shot (caption a representative
  keyframe, e.g. the shot's midpoint frame). **GPU strongly recommended** --
  an image captioning model (BLIP / BLIP-2 / similar) over ~500-1500 shots
  per video is slow on CPU.

### `asr.json` -- object, `shot_id` -> array of transcript segments (or `[]`)

```json
{
  "v1_s0000": [],
  "v1_s0003": [
    { "start": 11.34, "end": 13.09, "text": "Have you ever wanted to know what your", "speaker": "SPEAKER_14" }
  ]
}
```
- `start` / `end` are **absolute seconds in the source video** (not
  relative to the shot) -- the demo build script converts to shot-relative
  itself.
- `speaker` is a diarization label (`SPEAKER_00`, `SPEAKER_01`, ...); omit
  or use `null` if you don't run diarization -- it degrades gracefully.
- Shots with no speech get `[]`, not a missing key. In the one existing
  bundle, 641/695 shots had at least one segment (mostly-narrated content) --
  expect this to vary a lot by genre (vlogs/lectures likely near-continuous
  speech; some b-roll-heavy shots in film/documentary genres will be empty).
- **GPU strongly recommended.** Whisper (`large-v3`) or WhisperX for
  transcription; WhisperX or pyannote for diarization. A 30-90 minute source
  video on CPU-only ASR is impractically slow for this task.

### `entities.json` -- object, `shot_id` -> array with one entities list

```json
{
  "v1_s0000": [{ "entities": [] }],
  "v1_s0002": [{ "entities": [{ "name": "dog" }] }]
}
```
- Detected object/entity classes visible in the shot's keyframe(s), as
  simple `{"name": "<label>"}` objects. Empty list is fine and common.
- Any reasonably-labeled object detector works (YOLOv8, Detic, OWL-ViT,
  etc.) -- exact vocabulary doesn't need to match anything specific, this
  just needs to be evidence text an LLM can read later. GPU recommended,
  not strictly required.

### `background.json` -- object, `shot_id` -> array with one background label

```json
{
  "v1_s0000": [{ "background": { "label": "tv_studio" } }],
  "v1_s0002": [{ "background": { "label": "farmland" } }]
}
```
- One scene/setting label per shot (a lightweight scene classifier, e.g. a
  Places365-style CNN, works well). GPU optional -- these models are small.
- Labels observed in the existing bundle (reuse where they fit, but you're
  not restricted to this list -- it's free text, not an enum): `alley`,
  `beach`, `bedroom`, `bus_interior`, `cafe`, `car_interior`, `classroom`,
  `concert_venue`, `conference_room`, `corridor`, `dining_room`, `factory`,
  `farmland`, `forest`, `gym`, `highway`, `home_office`, `hospital`,
  `intersection`, `interview_set`, `jungle`, `kitchen`, `lab`,
  `lecture_hall`, `living_room`, `mountain`, `newsroom`, `ocean`, `office`,
  `park`, `tv_studio`, and more.

If you have real per-pipeline-stage output already (not this exact JSON
shape), a short conversion script is fine as long as the final files match
the schema above.

## Videos to process, in priority order

### Tier 1 -- do these first (source video already in the repo)

These already have their raw source file checked into this repo, so once
their bundle exists the video is fully usable end-to-end (retrieval +
LLM planning + in-browser render, since the renderer downloads the source
file directly). `id` is the descriptor-bundle folder name.

| id | genre/set | source video path (repo-relative) |
|---|---|---|
| `documentary-1` | documentary/1 | `documentary/1/Mammal Origins ｜ Full Documentary ｜ NOVA ｜ PBS-23BGbVBxXdQ.mp4` |
| `film-2` | film/2 | `film/2/The Little Shop of Horrors 1960 Full Movie HD 1080p.mp4` |
| `vlog-1` | vlog/1 | `vlog/1/Attempting VEDA？ ｜ Meals, Planner Sticker Haul, Bathroom Organizing Project-n2YNMJShKKA.mp4` |

For each: run the full pipeline (shot detection → captioning → ASR → entity
detection → background classification) on that file, write the 5 JSON files
to `example/<id>/`.

### Tier 2 -- do these next (source video needs downloading first)

These only have their *output* clips checked into the repo, not the
original source -- download it from the YouTube link below and save it at
`{genre}/{id}/<title>.mp4` first (matches the Tier 1 videos' convention).
Downloading + transcoding isn't itself GPU/CPU-heavy in the same way as the
extraction models, but it's a hard prerequisite, so it's listed here.

| id | genre/set | YouTube source |
|---|---|---|
| `film-1` | film/1 | https://www.youtube.com/watch?v=kmYcT5gT6a4 |
| `lecture-1` | lecture/1 | https://www.youtube.com/watch?v=wvXDB9dMdEo |
| `lecture-2` | lecture/2 | https://www.youtube.com/watch?v=0sKPkJME2Jw |
| `news-1` | news/1 | https://www.youtube.com/watch?v=tX80LkEqytg |
| `news-2` | news/2 | https://www.youtube.com/watch?v=fbgQG61Irvs |
| `vlog-2` | vlog/2 | https://www.youtube.com/watch?v=Tn7CL9rL27I |

Notes:
- GitHub LFS rejects any single file over 2GB. If the downloaded video is
  close to or over that, compress it first:
  `python3 scripts/downsample_media.py` (run from repo root, no extra flags
  needed -- it auto-scans every `{genre}/{1,2}/` folder and downsamples
  video/image files it finds in place, resumable if interrupted). Default
  target is 1280x720, CRF 28, 96kbps audio -- adjust flags if you need it
  smaller; see `--help`.
- After downloading+placing the video, run the same 5-stage pipeline as
  Tier 1 and write `example/<id>/*.json`.

## After producing a bundle: wiring it into the demo

From the repo root (Node.js >= 18; `npm install` once if `node_modules/`
isn't there yet):

```bash
npm run build:embeddings   # embeds every video with a ready bundle into embeddings/<id>.json
npm run build:data         # regenerates data.json; auto-picks up any embeddings/*.json present
```

`build:embeddings` prints one line per video: either it embedded
successfully (`[<id>] wrote embeddings/<id>.json (... KB)`), or -- if a
video's `example/<id>/*.json` bundle is missing or incomplete -- a `[skip]`
line naming exactly which file(s) are missing. Re-run it any time after
adding more bundles; it only processes what's ready, so there's no need to
wait for all 9.

**If a video isn't in the `DEMO_VIDEOS` list yet:** open
`scripts/export-embeddings.mjs` and check whether an entry for your `id`
already exists (Tier 1's 3 videos already have one). If not, add one
following the existing pattern, e.g.:

```js
{
  id: "film-1",
  videoId: "v1",
  label: "Film — <a short human-readable title>",
  sourceVideo: "film/1/<exact filename you saved>.mp4",
  exampleDir: path.join(ROOT, "example", "film-1"),
},
```

No other code change is needed -- `scripts/generate-data.mjs` discovers the
video automatically from whatever's in `embeddings/` when you run
`npm run build:data`.

### Sanity-check before handing back

```bash
python3 -c "import json; d=json.load(open('embeddings/<id>.json')); print(len(d['shots']), 'shots')"
python3 -c "import json; d=json.load(open('data.json')); print([v['id'] for v in d['liveDemo']['videos']])"
```
The second command's output should include your video's `id`.

## What to hand back

For each video you complete: the 5 files under `example/<id>/`, the source
video file (Tier 2 only, if newly downloaded/compressed), the resulting
`embeddings/<id>.json`, and the regenerated `data.json`. If you added a
`DEMO_VIDEOS` entry, include that diff to `scripts/export-embeddings.mjs`
too (and, for Tier 2, a `SOURCE_LOCAL_OVERRIDES` entry in
`scripts/generate-data.mjs` so the video's original-source player uses the
local file instead of the YouTube embed -- same pattern as the existing 4
entries there).
