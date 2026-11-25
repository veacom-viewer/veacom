import json
import subprocess
import sys
from pathlib import Path

for build in ("reference", "candidate"):
    directory = Path(sys.argv[1]) / build
    captured = json.loads((directory / "captured.json").read_text())
    assert len(captured) > 3 and captured[0]["ms"] < 0 < captured[-1]["ms"]
    lines = ["ffconcat version 1.0"]
    for frame, following in zip(captured, captured[1:]):
        lines.extend([f"file {frame['file']}", "option framerate 1000",
                      f"duration {(following['ms'] - frame['ms']) / 1000:.6f}"])
    lines.extend([f"file {captured[-1]['file']}", "option framerate 1000",
                  "duration 0.5", f"file {captured[-1]['file']}", "option framerate 1000"])
    (directory / "frames.ffconcat").write_text("\n".join(lines) + "\n")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-safe", "0",
                    "-f", "concat", "-i", "frames.ffconcat", "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart",
                    str(directory.parent / (build + ".mp4"))], cwd=directory, check=True)
