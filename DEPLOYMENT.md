# Deployment guide

Two independent things need to be deployed: the static site (GitHub Pages)
and the planning Worker (Cloudflare). The site works and is reviewable with
just the first one -- the gallery and pipeline walkthrough don't need the
Worker at all. The Worker only powers the new "Try it yourself" live panel.

## 0. Prerequisites

- Node.js 18+ and `git` (already needed to work in this folder)
- `git-lfs` (`git lfs install` once, globally) -- the demo videos are LFS
  objects
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account, if you
  want the live panel (skip if you're fine shipping gallery-only)
- An API key from an OpenAI-compatible chat completions endpoint, if you
  want the live panel

## 1. Publish the static site to GitHub Pages

```bash
# from this folder
git init                                   # if you haven't already (see "git init new repo" below)
git add -A
git commit -m "Initial import: Clips2Story interactive demo fork"

# create a new, empty repository on GitHub first (web UI or `gh repo create`),
# then:
git remote add origin https://github.com/<your-account>/<new-repo-name>.git
git branch -M main
git push -u origin main
```

Then in the new repo's GitHub settings: **Settings → Pages → Build and
deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)`**.
GitHub Pages will build and serve `index.html` at
`https://<your-account>.github.io/<new-repo-name>/`.

**Git LFS bandwidth**: GitHub's free tier includes 1GB/month of LFS
bandwidth per repository. This demo's video files will exceed that under
real review traffic. Before sharing the link widely, either purchase a
[GitHub LFS data pack](https://docs.github.com/en/billing/managing-billing-for-git-large-file-storage)
or move media to a CDN with `resolveMediaPath()` in
`assets/js/dom-helpers.js` pointed at it instead of
`media.githubusercontent.com`. This is a preexisting property of the
original site's hosting approach, not something new in this fork.

## 2. Deploy the planning Worker

```bash
cd worker
npm install
npx wrangler login          # opens a browser to authorize the CLI
```

### 2a. Create the two KV namespaces (rate limiting + response cache)

```bash
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create PLAN_CACHE
```

Each command prints an `id`. Paste them into `worker/wrangler.toml`,
uncommenting the two `[[kv_namespaces]]` blocks:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "paste-the-first-id-here"

[[kv_namespaces]]
binding = "PLAN_CACHE"
id = "paste-the-second-id-here"
```

(The Worker runs without these bound too -- no rate limiting, no caching --
which is fine for local testing but not for a public demo link.)

### 2b. Set the LLM API key as a secret (never as a `vars` entry)

```bash
npx wrangler secret put LLM_API_KEY
# paste your key when prompted
```

### 2c. Review the non-secret config in `worker/wrangler.toml`

- `LLM_MODEL` -- defaults to `gpt-4o-mini`; change to whatever model your
  key has access to. `worker/src/index.js`'s `callLlm()` calls
  `https://api.openai.com/v1/chat/completions` -- if you're using a
  different OpenAI-compatible provider, change that URL too.
- `ALLOWED_ORIGIN` -- defaults to `"*"` (fine for local testing). Before
  sharing the demo link, set it to your actual GitHub Pages origin, e.g.
  `"https://<your-account>.github.io"`, so only your site can call the
  Worker.
- `RATE_LIMIT_PER_HOUR` -- per-IP cap on live generations (default 8).
- `CACHE_TTL_SECONDS` -- how long an identical `(video, keyword)` planning
  result is served from cache before re-asking the LLM (default 1 day).

### 2d. Deploy

```bash
npx wrangler deploy
```

This prints your Worker's URL, something like
`https://clips2story-planner.<your-subdomain>.workers.dev`. That default
`*.workers.dev` subdomain is anonymous by construction -- do **not** attach
a custom domain that could identify you or your institution before the
paper is de-anonymized.

## 3. Wire the deployed Worker URL into the site

Edit `data.json`'s `liveDemo.plannerEndpoint` (and, for reproducibility, the
matching `LIVE_DEMO.plannerEndpoint` in `scripts/generate-data.mjs`) to the
URL from step 2d, then commit and push:

```bash
git add data.json scripts/generate-data.mjs
git commit -m "Point live demo at deployed Worker"
git push
```

## 4. Generate embeddings (if you haven't already)

```bash
npm run build:embeddings
git add embeddings/
git commit -m "Add live-demo retrieval embeddings"
git push
```

This is a build artifact (derived from `example/`'s checked-in shot
descriptors); regenerate it any time with the same command, no network
access needed at demo time either way.

## 5. Verify end to end

1. Open your GitHub Pages URL.
2. Under "Try it yourself," pick the documentary video, type a keyword (or
   click an example chip), click **Generate storyboard**.
3. Confirm: retrieval status appears, then planning status, then an editable
   storyboard with a working **Preview cut**.
4. Try reordering a card, deleting one, and swapping one in from the pool --
   each should re-preview instantly with no network activity (check your
   browser's network tab if you want to confirm).
5. Click **Render final video** and confirm a real MP4 appears with a
   working download link. This step is the slowest and the most likely to
   need a second look on your specific source video's file size -- see
   README "Known limitations."
6. Turn off Wi-Fi / block the Worker's domain and re-submit a keyword to
   confirm the fallback message appears instead of a broken page.

## 6. Turning the live panel off

If the Worker needs maintenance, or you want to ship gallery-only for a
while, set `"liveDemo": {"enabled": false, ...}` in `data.json` and push --
no redeploy of anything else needed. The panel simply doesn't render; the
rest of the site is unaffected.

## Double-blind anonymity checklist

- [ ] GitHub account used to host this repo doesn't reveal author identity
      (same requirement as the original site -- this fork doesn't change it)
- [ ] Worker deployed to the default `*.workers.dev` subdomain, no custom
      domain
- [ ] `worker/wrangler.toml` and all source files contain no author names,
      institution names, or emails (grep the diff before pushing)
- [ ] `LLM_API_KEY` set only via `wrangler secret put`, never committed
- [ ] Commit history and messages in this new repo don't reference the
      original (non-anonymous, if applicable) project name or authors
