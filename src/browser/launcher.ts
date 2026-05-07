/**
 * Browser launcher.
 *
 * Finds Chrome/Chromium on the system, launches it headless with
 * remote debugging enabled, and returns the DevTools WebSocket URL.
 *
 * Zero npm dependencies — uses child_process and http.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";

export interface LaunchOptions {
  /** Path to Chrome/Chromium binary. Auto-detected if not provided. */
  executablePath?: string;
  /** Run headless. Default: true */
  headless?: boolean;
  /** Viewport width. Default: 1280 */
  width?: number;
  /** Viewport height. Default: 720 */
  height?: number;
  /** Additional Chrome flags */
  args?: string[];
}

export interface BrowserProcess {
  /** The child process */
  process: ChildProcess;
  /** WebSocket URL for DevTools Protocol */
  wsEndpoint: string;
  /** Temporary user data directory */
  userDataDir: string;
  /** Kill the browser and clean up */
  close: () => Promise<void>;
}

/**
 * Find Chrome/Chromium on the system.
 */
export async function findChrome(): Promise<string | null> {
  const platform = process.platform;

  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (platform === "linux") {
    candidates.push(
      "google-chrome",
      "google-chrome-stable",
      "chromium-browser",
      "chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    );
  } else if (platform === "win32") {
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    candidates.push(
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  }

  // Check which exists
  const { execFileSync } = await import("node:child_process");
  const { accessSync } = await import("node:fs");
  for (const candidate of candidates) {
    try {
      if (candidate.includes("/") || candidate.includes("\\")) {
        accessSync(candidate);
        return candidate;
      }
      execFileSync("which", [candidate], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Launch a headless Chrome and return the DevTools connection info.
 */
export async function launchBrowser(options?: LaunchOptions): Promise<BrowserProcess> {
  let execPath = options?.executablePath ?? await findChrome();

  // No system Chrome found — try cached download, then auto-download
  if (!execPath) {
    const { getCachedChromium, ensureChromium } = await import("./download.js");
    execPath = await getCachedChromium();
    if (!execPath) {
      console.log("No Chrome found on system. Downloading Chrome for Testing...");
      execPath = await ensureChromium({ verbose: true });
    }
  }

  const headless = options?.headless ?? true;
  const width = options?.width ?? 1280;
  const height = options?.height ?? 720;

  // Create temp user data dir
  const userDataDir = await mkdtemp(join(tmpdir(), "agentlens-"));

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-sandbox",
    "--safebrowsing-disable-auto-update",
    // Anti-detection: look like a real browser
    "--disable-blink-features=AutomationControlled",
    `--window-size=${width},${height}`,
    ...(headless ? ["--headless=new"] : []),
    ...(options?.args ?? []),
    "about:blank",
  ];

  const proc = spawn(execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Parse the DevTools WebSocket URL from stderr
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Browser launch timed out — no DevTools URL after 15s"));
    }, 15000);

    let stderrData = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
      // Chrome outputs: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID"
      const match = stderrData.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (!stderrData.includes("DevTools")) {
        reject(new Error(`Browser exited with code ${code} before DevTools URL was available.\nstderr: ${stderrData.slice(0, 500)}`));
      }
    });
  });

  const close = async () => {
    proc.kill();
    // Wait a moment for process to exit, then clean up
    await new Promise<void>((resolve) => {
      proc.on("exit", () => resolve());
      setTimeout(resolve, 2000);
    });
    try {
      await rm(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  return { process: proc, wsEndpoint, userDataDir, close };
}

/**
 * Get the list of open pages/targets from the DevTools HTTP API.
 */
export async function getTargets(debugPort: number): Promise<Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string }>> {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${debugPort}/json/list`, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

/**
 * Create a new page/tab via the DevTools HTTP API.
 */
export async function createTarget(debugPort: number, url = "about:blank"): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${debugPort}/json/new?${url}`, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}
