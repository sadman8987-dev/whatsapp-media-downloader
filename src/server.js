import express from "express";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || "";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 45);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 180000);

app.get("/health", (_req, res) => res.json({ ok: true, service: "media-downloader" }));

function isPublicHttpUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) return false;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function runYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Download timed out"));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.slice(-4000) });
      else reject(new Error(stderr.slice(-3000) || `yt-dlp exited with code ${code}`));
    });
  });
}

app.post("/download", async (req, res) => {
  if (!API_KEY || req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { url, format = "video" } = req.body || {};
  if (typeof url !== "string" || !isPublicHttpUrl(url)) {
    return res.status(400).json({ error: "A valid public http(s) URL is required" });
  }
  if (!["video", "audio"].includes(format)) {
    return res.status(400).json({ error: "format must be video or audio" });
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "media-dl-"));
  const outputTemplate = path.join(workDir, "%(id)s.%(ext)s");
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--max-filesize", `${MAX_FILE_MB}M`,
    "--socket-timeout", "20",
    "--retries", "2",
    "-o", outputTemplate
  ];
  if (format === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "5");
  } else {
    args.push("-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4");
  }
  args.push("--print", "after_move:filepath", url);

  try {
    const result = await runYtDlp(args, DOWNLOAD_TIMEOUT_MS);
    const filePath = result.stdout.split("\n").filter(Boolean).at(-1);
    if (!filePath || !filePath.startsWith(workDir)) {
      throw new Error("Could not locate downloaded media");
    }
    const info = await stat(filePath);
    if (info.size > MAX_FILE_MB * 1024 * 1024) {
      throw new Error(`File exceeds ${MAX_FILE_MB} MB limit`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = format === "audio" ? "audio/mpeg" :
      ext === ".webm" ? "video/webm" : "video/mp4";
    const filename = `media-${randomUUID().slice(0, 8)}${format === "audio" ? ".mp3" : (ext || ".mp4")}`;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", info.size);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.on("close", async () => {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    });
    stream.pipe(res);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    console.error("Download failed:", error.message);
    if (!res.headersSent) res.status(422).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Media downloader listening on ${PORT}`);
});
