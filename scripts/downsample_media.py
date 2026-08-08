#!/usr/bin/env python3
"""
Downsample videos under {genre}/{1,2}/ and images under {genre}/{1,2}/frames/,
then replace originals in place.

Resumable: completed paths are appended to a state file after each successful
replace. Re-runs skip paths that are still present on disk and listed as done.

Requires ffmpeg (and ffprobe) on PATH.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parent
DEFAULT_STATE = SCRIPT_DIR / ".downsample_media.state"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def have_ffmpeg() -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            check=True,
            timeout=10,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def load_done(state_path: Path) -> set[str]:
    if not state_path.is_file():
        return set()
    out: set[str] = set()
    for line in state_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line)
    return out


def append_done(state_path: Path, rel_posix: str) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with state_path.open("a", encoding="utf-8") as f:
        f.write(rel_posix + "\n")
        f.flush()
        os.fsync(f.fileno())


def rel_posix(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def collect_targets(root: Path) -> tuple[list[Path], list[Path]]:
    videos: list[Path] = []
    images: list[Path] = []
    root = root.resolve()

    for genre_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        for sid in ("1", "2"):
            base = genre_dir / sid
            if not base.is_dir():
                continue
            for f in sorted(base.iterdir()):
                if not f.is_file():
                    continue
                if f.suffix.lower() in VIDEO_EXTS:
                    videos.append(f)
            frames_root = base / "frames"
            if frames_root.is_dir():
                for f in sorted(frames_root.rglob("*")):
                    if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                        images.append(f)

    return videos, images


def video_has_audio(path: Path) -> bool:
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError:
        return True
    return bool(r.stdout.strip())


def sibling_tmp(path: Path) -> Path:
    """Temp path keeps the real extension so ffmpeg can infer the muxer/format."""
    return path.with_name(f"{path.stem}.downsample.tmp{path.suffix}")


def run_ffmpeg(args: list[str], *, dry_run: bool) -> bool:
    if dry_run:
        print(" ".join(args))
        return True
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "ffmpeg failed\n")
        return False
    return True


def downsample_video(
    path: Path,
    *,
    max_w: int,
    max_h: int,
    crf: int,
    audio_kbps: int,
    dry_run: bool,
) -> bool:
    tmp = sibling_tmp(path)
    if tmp.exists():
        tmp.unlink()

    vf = (
        f"scale=w='min({max_w},iw)':h='min({max_h},ih)':force_original_aspect_ratio=decrease:"
        f"force_divisible_by=2,"
        "format=yuv420p"
    )
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(path),
        "-map_metadata",
        "-1",
        "-map",
        "0:v:0",
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-crf",
        str(crf),
        "-preset",
        "medium",
        "-movflags",
        "+faststart",
    ]
    if video_has_audio(path):
        cmd += [
            "-map",
            "0:a:0",
            "-c:a",
            "aac",
            "-b:a",
            f"{audio_kbps}k",
            "-ac",
            "2",
        ]
    cmd.append(str(tmp))
    if not run_ffmpeg(cmd, dry_run=dry_run):
        if tmp.exists():
            tmp.unlink()
        return False
    if dry_run:
        return True
    os.replace(tmp, path)
    return True


def downsample_image(
    path: Path,
    *,
    max_w: int,
    max_h: int,
    dry_run: bool,
) -> bool:
    tmp = sibling_tmp(path)
    if tmp.exists():
        tmp.unlink()

    vf = (
        f"scale=w='min({max_w},iw)':h='min({max_h},ih)':force_original_aspect_ratio=decrease:"
        "force_divisible_by=2"
    )
    ext = path.suffix.lower()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(path),
        "-vf",
        vf,
        "-frames:v",
        "1",
    ]
    if ext == ".png":
        cmd += ["-compression_level", "9"]
    elif ext in (".jpg", ".jpeg"):
        cmd += ["-q:v", "5"]
    elif ext == ".webp":
        cmd += ["-compression_level", "6"]
    cmd.append(str(tmp))

    if not run_ffmpeg(cmd, dry_run=dry_run):
        if tmp.exists():
            tmp.unlink()
        return False
    if dry_run:
        return True
    os.replace(tmp, path)
    return True


def should_skip(path: Path, done: set[str], root: Path) -> bool:
    if not path.is_file():
        return True
    key = rel_posix(root, path)
    return key in done


def main() -> int:
    p = argparse.ArgumentParser(description="Downsample genre/1|2 videos and frames; resumable.")
    p.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help=f"Project root (default: {DEFAULT_ROOT})",
    )
    p.add_argument(
        "--state-file",
        type=Path,
        default=DEFAULT_STATE,
        help=f"Append-only log of finished relative paths (default: {DEFAULT_STATE})",
    )
    p.add_argument("--max-video-w", type=int, default=1280, help="Max video width (fit inside box)")
    p.add_argument("--max-video-h", type=int, default=720, help="Max video height (fit inside box)")
    p.add_argument("--video-crf", type=int, default=28, help="libx264 CRF (higher = smaller)")
    p.add_argument("--audio-kbps", type=int, default=96, help="AAC audio bitrate")
    p.add_argument("--max-image-w", type=int, default=960, help="Max image width (fit inside box)")
    p.add_argument("--max-image-h", type=int, default=540, help="Max image height (fit inside box)")
    p.add_argument("--dry-run", action="store_true", help="Print ffmpeg commands only")
    p.add_argument(
        "--reset-state",
        action="store_true",
        help="Delete state file before running (re-process everything)",
    )
    args = p.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        print(f"Root is not a directory: {root}", file=sys.stderr)
        return 1

    if not args.dry_run and not have_ffmpeg():
        print("ffmpeg not found on PATH.", file=sys.stderr)
        return 1

    state_path = args.state_file
    if args.reset_state and state_path.exists():
        state_path.unlink()

    done = load_done(state_path)
    videos, images = collect_targets(root)
    targets = [("video", v) for v in videos] + [("image", im) for im in images]

    skipped = 0
    processed = 0
    failed = 0

    for kind, path in targets:
        if should_skip(path, done, root):
            if path.is_file() and rel_posix(root, path) in done:
                skipped += 1
            continue

        rel = rel_posix(root, path)
        print(f"[{kind}] {rel}")

        if kind == "video":
            ok = downsample_video(
                path,
                max_w=args.max_video_w,
                max_h=args.max_video_h,
                crf=args.video_crf,
                audio_kbps=args.audio_kbps,
                dry_run=args.dry_run,
            )
        else:
            ok = downsample_image(
                path,
                max_w=args.max_image_w,
                max_h=args.max_image_h,
                dry_run=args.dry_run,
            )

        if not ok:
            failed += 1
            continue

        processed += 1
        if not args.dry_run:
            append_done(state_path, rel)

    print(f"Done. processed={processed} skipped(already done)={skipped} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
