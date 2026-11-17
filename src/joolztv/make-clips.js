// Makes the tiny test clips the first-run "device check" plays (2 seconds each, a few KB). Run at image build time:  node make-clips.js <outDir>
// A clip that cannot be encoded here is simply left out of the list, so the check only tests what exists.
"use strict";
const { spawnSync } = require("child_process"), fs = require("fs"), path = require("path");
const out = path.resolve(process.argv[2] || path.join(__dirname, "devtest")), FFMPEG = process.env.FFMPEG || "ffmpeg";
fs.mkdirSync(out, { recursive: true });
const V = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-preset", "veryfast", "-crf", "35"];
const SPECS = [
  { id: "h264", trait: "h264", label: "H.264 video, AAC audio", kind: "video", ext: "mp4", mime: "video/mp4", args: [...V, "-c:a", "aac", "-b:a", "64k"] },
  { id: "hevc", trait: "hevc", label: "HEVC (H.265) video", kind: "video", ext: "mp4", mime: "video/mp4", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-x265-params", "log-level=error", "-crf", "35", "-c:a", "aac"] },
  { id: "hevc10", trait: "hevc10", label: "10-bit HEVC / HDR video", kind: "video", ext: "mp4", mime: "video/mp4", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params", "log-level=error:profile=main10", "-crf", "35", "-c:a", "aac"] },
  { id: "av1", trait: "av1", label: "AV1 video", kind: "video", ext: "mp4", mime: "video/mp4", args: ["-c:v", "libsvtav1", "-crf", "45", "-preset", "12", "-pix_fmt", "yuv420p", "-c:a", "aac"], alt: ["-c:v", "libaom-av1", "-crf", "50", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-c:a", "aac"] },
  { id: "h264hi10", trait: "h264hi10", label: "10-bit H.264", kind: "video", ext: "mp4", mime: "video/mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-profile:v", "high10", "-preset", "veryfast", "-crf", "35", "-c:a", "aac"] },
  { id: "xvid", trait: "oldvid", label: "XviD / AVI files", kind: "video", ext: "avi", mime: "video/x-msvideo", args: ["-c:v", "libxvid", "-vtag", "XVID", "-q:v", "8", "-c:a", "libmp3lame", "-b:a", "64k"], alt: ["-c:v", "mpeg4", "-vtag", "XVID", "-q:v", "8", "-c:a", "libmp3lame", "-b:a", "64k"] },
  { id: "mkv", needs: "h264", trait: "mkv", label: "MKV files", kind: "video", ext: "mkv", mime: "video/x-matroska", args: [...V, "-c:a", "aac", "-b:a", "64k"] },
  { id: "ts", needs: "h264", trait: "ts", label: "TS files", kind: "video", ext: "ts", mime: "video/mp2t", args: [...V, "-c:a", "aac", "-b:a", "64k", "-f", "mpegts"] },
  { id: "ac3", needs: "h264", trait: "ac3", label: "Dolby Digital audio", kind: "audio", ext: "mp4", mime: "video/mp4", args: [...V, "-c:a", "ac3", "-b:a", "192k", "-ar", "48000"] },
  { id: "eac3", needs: "h264", trait: "eac3", label: "Dolby Digital Plus audio", kind: "audio", ext: "mp4", mime: "video/mp4", args: [...V, "-c:a", "eac3", "-b:a", "192k", "-ar", "48000"] },
  { id: "dts", needs: "h264", trait: "dts", label: "DTS audio", kind: "audio", ext: "mkv", mime: "video/x-matroska", args: [...V, "-c:a", "dca", "-strict", "-2", "-b:a", "768k", "-ar", "48000"] },
  { id: "truehd", needs: "h264", trait: "truehd", label: "TrueHD audio", kind: "audio", ext: "mkv", mime: "video/x-matroska", args: [...V, "-c:a", "truehd", "-strict", "-2", "-ar", "48000"] },
];
const SRC = ["-f", "lavfi", "-i", "testsrc=duration=2:size=256x144:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000", "-shortest"];
const manifest = [];
for (const sp of SPECS) {
  const file = sp.id + "." + sp.ext, dest = path.join(out, file);
  let ok = false;
  for (const args of [sp.args, sp.alt].filter(Boolean)) {
    const r = spawnSync(FFMPEG, ["-v", "error", "-y", ...SRC, ...args, dest], { timeout: 90000 });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 500) { ok = true; break; }
  }
  if (ok) manifest.push({ id: sp.id, needs: sp.needs || "", trait: sp.trait, label: sp.label, kind: sp.kind, file, mime: sp.mime, bytes: fs.statSync(dest).size });
  else console.log("skipped", sp.id, "(could not be encoded here)");
}
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ v: 1, clips: manifest }));
console.log("device-check clips:", manifest.map(m => m.id + " " + m.bytes + "B").join(", "));
