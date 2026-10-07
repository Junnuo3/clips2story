/**
 * Small DOM + media-path helpers shared between app.js (the original demo
 * gallery) and the new live-demo modules in this directory. Pulled out of
 * app.js into their own module specifically so the live-demo modules don't
 * need a circular import back into app.js.
 */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A slim horizontal progress bar for steps with no reliable duration (an
 * LLM call, a WASM download, etc). `set(pct, { pulse })` moves the fill to
 * an approximate target percentage; `pulse: true` animates it to signal
 * "still working" rather than "stuck" while the real duration is unknown.
 */
export function createProgressBar() {
  const track = el("div", "h-1.5 w-full overflow-hidden rounded-full bg-slate-100");
  const fill = el("div", "h-full rounded-full bg-blue-600 transition-all duration-500 ease-out");
  fill.style.width = "0%";
  track.appendChild(fill);
  return {
    el: track,
    set(pct, { pulse = false } = {}) {
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      fill.classList.toggle("animate-pulse", pulse);
    },
    reset() {
      fill.classList.remove("animate-pulse");
      fill.style.width = "0%";
    },
  };
}

export function createDetails({ title, subtitle, open = false, content }) {
  const d = document.createElement("details");
  d.open = open;
  d.className = "group rounded-xl border border-surface-border bg-surface-raised";

  const s = document.createElement("summary");
  s.className = "cursor-pointer list-none select-none px-4 py-3 hover:bg-slate-50";

  const row = el("div", "flex items-start justify-between gap-4");
  const left = el("div", "min-w-0");
  left.appendChild(el("p", "text-sm font-semibold text-slate-900", title));
  if (subtitle) {
    left.appendChild(el("p", "mt-1 text-xs text-slate-600", subtitle));
  }
  const chevron = el(
    "span",
    "mt-0.5 shrink-0 text-slate-600 transition-transform group-open:rotate-90",
    "›"
  );
  row.appendChild(left);
  row.appendChild(chevron);
  s.appendChild(row);

  const body = el("div", "px-4 pb-4 pt-1");
  body.appendChild(content);
  d.appendChild(s);
  d.appendChild(body);
  return d;
}

/**
 * Infer GitHub owner/repo from a *.github.io URL so raw media URLs work for any fork or account.
 * - Project site: https://owner.github.io/repo-name/… → owner/repo-name
 * - User/org root site: https://owner.github.io/… → owner/owner.github.io
 */
function inferGitHubPagesRepo() {
  const host = window.location.hostname;
  if (!host.endsWith(".github.io")) return null;
  const owner = host.slice(0, -".github.io".length);
  if (!owner) return null;
  const segments = window.location.pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first && !/\.html?$/i.test(first)) {
    return { owner, repo: first };
  }
  return { owner, repo: `${owner}.github.io` };
}

/** Default branch for GitHub-hosted media (must match where demo assets live). */
const GITHUB_PAGES_MEDIA_BRANCH = "master";

/**
 * Direct LFS CDN URL (Git LFS blobs are not on raw.githubusercontent.com as bytes).
 * Used for <video> only: github.com/.../raw/... 302 chains break range/metadata requests.
 */
function githubPagesMediaUrl(gh, encodedRepoRelativePath) {
  const o = encodeURIComponent(gh.owner);
  const r = encodeURIComponent(gh.repo);
  return `https://media.githubusercontent.com/media/${o}/${r}/${GITHUB_PAGES_MEDIA_BRANCH}/${encodedRepoRelativePath}`;
}

function githubPagesRawRedirectUrl(gh, encodedRepoRelativePath) {
  const o = encodeURIComponent(gh.owner);
  const r = encodeURIComponent(gh.repo);
  return `https://github.com/${o}/${r}/raw/${GITHUB_PAGES_MEDIA_BRANCH}/${encodedRepoRelativePath}`;
}

/**
 * Extensions tracked in Git LFS (.gitattributes). On GitHub Pages the site origin
 * serves LFS pointer stubs, not real bytes — load these from media.githubusercontent.com.
 */
function isGitHubLfsMediaPath(cleaned) {
  return /\.(mp4|webm|mov|m4v|ogv|png)$/i.test(cleaned);
}

/**
 * GitHub Pages does not serve Git LFS objects from the Pages origin; it serves the tiny LFS pointer file.
 * When deployed under github.io, point at GitHub-hosted URLs instead of same-origin ./…
 *
 * - LFS (mp4, png per .gitattributes): media.githubusercontent.com/…/media/…
 * - Other assets: github.com/…/raw/… (302 → raw.githubusercontent.com)
 */
export function resolveMediaPath(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const cleaned = path.replace(/^[./]+/, "");
  // Encode per-segment so spaces/unicode in filenames resolve correctly,
  // while preserving "/" path separators.
  const encoded = cleaned
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const isGitHubPages = window.location.hostname.endsWith("github.io");
  if (!isGitHubPages) return `./${encoded}`;
  const gh = inferGitHubPagesRepo();
  if (!gh) return `./${encoded}`;
  if (isGitHubLfsMediaPath(cleaned)) return githubPagesMediaUrl(gh, encoded);
  return githubPagesRawRedirectUrl(gh, encoded);
}

/** Wire <video> to a repo-relative MP4 via <source type="video/mp4"> (helps with GitHub octet-stream). */
export function setVideoMp4FromRepoPath(vid, repoRelativePath) {
  if (!vid || !repoRelativePath) return;
  const url = resolveMediaPath(repoRelativePath);
  vid.replaceChildren();
  const source = document.createElement("source");
  source.src = url;
  source.type = "video/mp4";
  vid.appendChild(source);
  try {
    vid.load();
  } catch {
    // ignore
  }
}
