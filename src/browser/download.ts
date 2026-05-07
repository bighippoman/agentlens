/**
 * Auto-download Chromium when no system Chrome is found.
 *
 * Uses Google's "Chrome for Testing" builds — official, stable, purpose-built
 * for automation. Downloads once, caches in ~/.agentlens/chromium/.
 *
 * Zero npm dependencies. Uses node:https + node:child_process.
 */

import { mkdir, access, writeFile, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { get as httpsGet } from "node:https";

const CACHE_DIR = join(homedir(), ".agentlens");
const CHROMIUM_DIR = join(CACHE_DIR, "chromium");
const VERSION_FILE = join(CHROMIUM_DIR, ".version");

const CFT_ENDPOINT = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

interface CFTResponse {
  channels: {
    Stable: {
      version: string;
      downloads: {
        chrome: Array<{ platform: string; url: string }>;
      };
    };
  };
}

function getCFTPlatform(): string {
  const p = platform();
  const a = arch();
  if (p === "darwin") return a === "arm64" ? "mac-arm64" : "mac-x64";
  if (p === "linux") return a === "arm64" ? "linux-arm64" : "linux64";
  if (p === "win32") return a === "x64" ? "win64" : "win32";
  throw new Error(`Unsupported platform: ${p} ${a}`);
}

/**
 * Get the path to the cached Chromium executable, or null if not downloaded.
 */
export async function getCachedChromium(): Promise<string | null> {
  const execPath = getChromiumExecPath();
  try {
    await access(execPath);
    return execPath;
  } catch {
    return null;
  }
}

function getChromiumExecPath(): string {
  const p = platform();
  if (p === "darwin") {
    const platDir = arch() === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
    return join(CHROMIUM_DIR, platDir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (p === "linux") {
    const platDir = arch() === "arm64" ? "chrome-linux-arm64" : "chrome-linux64";
    return join(CHROMIUM_DIR, platDir, "chrome");
  }
  if (p === "win32") {
    const platDir = arch() === "x64" ? "chrome-win64" : "chrome-win32";
    return join(CHROMIUM_DIR, platDir, "chrome.exe");
  }
  throw new Error(`Unsupported platform: ${p}`);
}

/**
 * Download Chromium if not already cached.
 * Returns the path to the executable.
 */
export async function ensureChromium(options?: { verbose?: boolean }): Promise<string> {
  const verbose = options?.verbose ?? false;

  const cached = await getCachedChromium();
  if (cached) {
    if (verbose) console.log(`Using cached Chromium: ${cached}`);
    return cached;
  }

  if (verbose) console.log("Chromium not found. Downloading Chrome for Testing...");

  await mkdir(CHROMIUM_DIR, { recursive: true });

  // Fetch download URL
  const cftData = await fetchJSON(CFT_ENDPOINT) as CFTResponse;
  const version = cftData.channels.Stable.version;
  const platKey = getCFTPlatform();

  const downloads = cftData.channels.Stable.downloads.chrome;
  const download = downloads.find((d) => d.platform === platKey);
  if (!download) {
    throw new Error(`No Chrome for Testing build for platform: ${platKey}\nAvailable: ${downloads.map((d) => d.platform).join(", ")}`);
  }

  if (verbose) console.log(`Downloading Chrome ${version} for ${platKey}...`);

  const zipPath = join(CHROMIUM_DIR, "chrome.zip");
  await downloadFile(download.url, zipPath, verbose);

  if (verbose) console.log("Extracting...");

  // Extract using execFileSync (safe — no shell, no user input in args)
  const p = platform();
  if (p === "win32") {
    execFileSync("powershell", [
      "-command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${CHROMIUM_DIR}' -Force`,
    ], { stdio: verbose ? "inherit" : "ignore" });
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", CHROMIUM_DIR], {
      stdio: verbose ? "inherit" : "ignore",
    });
  }

  await rm(zipPath, { force: true });

  // Make executable on unix
  if (p !== "win32") {
    const execPath = getChromiumExecPath();
    try {
      execFileSync("chmod", ["+x", execPath]);
    } catch {
      // May already be executable
    }
  }

  await writeFile(VERSION_FILE, version, "utf-8");

  const execPath = getChromiumExecPath();
  try {
    await access(execPath);
  } catch {
    throw new Error(`Downloaded Chromium but executable not found at: ${execPath}`);
  }

  if (verbose) console.log(`Chrome ${version} installed to ${CHROMIUM_DIR}`);
  return execPath;
}

/**
 * Get the version of the cached Chromium, or null.
 */
export async function getCachedVersion(): Promise<string | null> {
  try {
    return (await readFile(VERSION_FILE, "utf-8")).trim();
  } catch {
    return null;
  }
}

/**
 * Remove the cached Chromium.
 */
export async function removeCachedChromium(): Promise<void> {
  await rm(CHROMIUM_DIR, { recursive: true, force: true });
}

// ── HTTP helpers (zero deps) ──

function fetchJSON(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location).then(resolve, reject);
        return;
      }
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function downloadFile(url: string, dest: string, verbose: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest, verbose).then(resolve, reject);
        return;
      }
      const totalBytes = parseInt(res.headers["content-length"] ?? "0", 10);
      let downloaded = 0;
      let lastPct = -1;
      const file = createWriteStream(dest);
      res.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (verbose && totalBytes > 0) {
          const pct = Math.floor((downloaded / totalBytes) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`\r  ${pct}% (${Math.round(downloaded / 1048576)}MB / ${Math.round(totalBytes / 1048576)}MB)`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); if (verbose) process.stdout.write("\n"); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}
