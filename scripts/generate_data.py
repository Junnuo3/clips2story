#!/usr/bin/env python3
"""Parse CSV and local {genre}/{id}/ dirs -> data.json (anonymous demo)."""
from __future__ import annotations

import csv
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "demo_video_links.csv"
OUT_PATH = ROOT / "data.json"

GENRES = ["documentary", "film", "lecture", "news", "vlog"]

# For certain examples, we use a local MP4 for the source video instead of YouTube.
# Keys are (genre, id) and values are filenames inside {genre}/{id}/.
# GitHub LFS rejects files > 2GB per object — keep local sources under that (compress if needed).
SOURCE_LOCAL_OVERRIDES: dict[tuple[str, str], str] = {
    ("documentary", "1"): "Mammal Origins ｜ Full Documentary ｜ NOVA ｜ PBS-23BGbVBxXdQ.mp4",
    ("documentary", "2"): "Can Dogs Talk？ ｜ Full Documentary ｜ NOVA ｜ PBS-jfLAaGtNc7U.mp4",
    ("film", "2"): "The Little Shop of Horrors 1960 Full Movie HD 1080p.mp4",
    ("vlog", "1"): "Attempting VEDA？ ｜ Meals, Planner Sticker Haul, Bathroom Organizing Project-n2YNMJShKKA.mp4",
}


def is_local_source_path(link: str) -> bool:
    t = (link or "").strip()
    return bool(t) and not re.match(r"^https?://", t, re.I) and t.endswith(".mp4")


def youtube_watch_to_embed(watch_url: str) -> str | None:
    try:
        u = urlparse(watch_url)
        q = parse_qs(u.query)
        vid = (q.get("v") or [None])[0]
        if not vid and u.netloc.replace("www.", "") in ("youtu.be",):
            vid = u.path.strip("/").split("/")[0]
        if not vid:
            return None
        return f"https://www.youtube.com/embed/{vid}"
    except Exception:
        return None


def list_mp4(d: Path) -> list[str]:
    if not d.is_dir():
        return []
    return [f.name for f in d.iterdir() if f.suffix.lower() == ".mp4"]

def pick_single(files: list[str], suffix: str) -> str | None:
    hits = [f for f in files if f.lower().endswith(suffix.lower())]
    if not hits:
        return None
    if len(hits) > 1:
        hits.sort()
    return hits[0]


def build_example(genre: str, id_str: str, youtube_embed: str | None) -> dict | None:
    dir_path = ROOT / genre / id_str
    files = list_mp4(dir_path)
    nf_files = [f for f in files if f.endswith("_no_narration.mp4")]

    keyword_clips: list[dict] = []
    for nf in nf_files:
        keyword = nf.replace("_no_narration.mp4", "").replace("_no_narration.MP4", "")
        ours_name = f"{keyword}_ours.mp4"
        if ours_name not in files:
            print(f"[skip] {dir_path}: missing {ours_name} for keyword {keyword!r}")
            continue
        keyword_clips.append({"keyword": keyword, "nf": nf, "ours": ours_name})

    keyword_clips.sort(key=lambda x: x["keyword"])
    if len(keyword_clips) < 2:
        print(f"[skip] {dir_path}: expected >=2 keywords, found {len(keyword_clips)}")
        return None

    base = f"{genre}/{id_str}"

    a2summ_name = pick_single(files, "_a2summ.mp4")
    teasergen_name = pick_single(files, "_teasergen.mp4")
    regen_name = pick_single(files, "_regen.mp4")
    fixed = {
        "a2summ": f"{base}/{a2summ_name}" if a2summ_name else None,
        "teasergen": f"{base}/{teasergen_name}" if teasergen_name else None,
        "regen": f"{base}/{regen_name}" if regen_name else None,
    }
    for k, v in fixed.items():
        if not v:
            print(f"[warn] {dir_path}: missing fixed output {k} (*{k}.mp4)")

    selected = keyword_clips[:2]
    source_local = None
    override = SOURCE_LOCAL_OVERRIDES.get((genre, id_str))
    if override:
        if override in files:
            source_local = f"{base}/{override}"
        else:
            print(f"[warn] {dir_path}: missing sourceLocal override file ({override})")
    return {
        "id": id_str,
        "youtubeEmbed": youtube_embed,
        "sourceLocal": source_local,
        "keywords": [
            {
                "keyword": s["keyword"],
                "local": {"nf": f"{base}/{s['nf']}", "ours": f"{base}/{s['ours']}"},
            }
            for s in selected
        ],
        "fixed": fixed,
    }


def main() -> None:
    rows = []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    by_genre: dict[str, list] = {g: [] for g in GENRES}

    for row in rows:
        genre = (row.get("genre") or "").strip()
        id_str = str((row.get("id") or "").strip())
        link = (row.get("youtube_link") or "").strip()
        if genre not in GENRES:
            print(f"Unknown genre in CSV: {genre}")
            continue
        embed = youtube_watch_to_embed(link)
        if not embed:
            key = (genre, id_str)
            if key in SOURCE_LOCAL_OVERRIDES or is_local_source_path(link):
                embed = None  # type: ignore[assignment]
            else:
                print(f"Could not parse YouTube URL for {genre}/{id_str}")
                continue
        ex = build_example(genre, id_str, embed)
        if ex:
            by_genre[genre].append(ex)

    payload = {
        "projectTitle": "Clips2Story: Training-free Video Storyboarding and Editing using Multimodal Retrieval-Embedded Generation",
        "abstractPlaceholder": (
            "[Abstract text will appear here in the camera-ready version. "
            "This anonymous demo page is for double-blind review.]"
        ),
        "pipeline": [
            "Multimodal retrieval aligns candidate clips with story intent without task-specific training.",
            "Embedded generation composes a coherent narrative structure from retrieved visual segments.",
            "The pipeline outputs editable storyboard timelines for comparison across baselines.",
        ],
        "genres": [
            {
                "id": g,
                "label": g[0].upper() + g[1:] if g else g,
                "sets": by_genre[g],
            }
            for g in GENRES
        ],
    }

    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
