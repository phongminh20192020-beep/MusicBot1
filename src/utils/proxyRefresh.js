"use strict";

/**
 * Auto-pulls a fresh proxy list from ProxyScrape's free public API, quickly
 * validates each proxy actually works (dead free proxies are extremely
 * common), and writes the survivors to proxies.txt in the format /mv
 * download already knows how to read (see mv.js -> loadProxies()).
 *
 * Zero extra npm dependencies — uses only Node's built-in https/net modules.
 *
 * Usage:
 *   node scripts/refresh-proxies.js          (one-off run)
 *   require("./utils/proxyRefresh").schedule()  (background auto-refresh)
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const https = require("https");

const PROXIES_PATH = process.env.MV_PROXIES_PATH || path.join(__dirname, "..", "..", "proxies.txt");

// Protocols to pull from ProxyScrape. http proxies also cover CONNECT
// tunneling for https:// targets (which is all yt-dlp needs against YouTube).
const PROTOCOLS = (process.env.PROXY_PROTOCOLS || "http,socks5").split(",").map((p) => p.trim()).filter(Boolean);
const COUNTRY = process.env.PROXY_COUNTRY || "all";

// How many *working* proxies to keep in proxies.txt after validation.
const MAX_PROXIES = parseInt(process.env.PROXY_MAX || "15", 10);

// Validation: how long to wait for a proxy to prove itself, and how many to
// test in parallel. Free lists are mostly dead, so we test generously and
// keep only what actually answers.
const TEST_TIMEOUT_MS = parseInt(process.env.PROXY_TEST_TIMEOUT_MS || "5000", 10);
const TEST_CONCURRENCY = parseInt(process.env.PROXY_TEST_CONCURRENCY || "40", 10);
const TEST_TARGET_HOST = process.env.PROXY_TEST_TARGET_HOST || "www.youtube.com";
const TEST_TARGET_PORT = parseInt(process.env.PROXY_TEST_TARGET_PORT || "443", 10);

/** Fetches one protocol's list from ProxyScrape as "scheme://ip:port" lines. */
function fetchProxyScrapeList(protocol) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      request: "getproxies",
      protocol,
      proxy_format: "protocolipport",
      format: "text",
      timeout: "10000",
      country: COUNTRY,
    });
    const url = `https://api.proxyscrape.com/v4/free-proxy-list/get?${qs.toString()}`;

    https.get(url, { timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        const lines = body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && /^(https?|socks[45]):\/\//i.test(l));
        resolve(lines);
      });
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

/**
 * Validates an http(s)-scheme proxy by opening a raw TCP connection and
 * issuing an HTTP CONNECT to the test target — exactly what yt-dlp needs to
 * tunnel an HTTPS request through it.
 */
function testHttpProxy(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(TEST_TIMEOUT_MS, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${TEST_TARGET_HOST}:${TEST_TARGET_PORT} HTTP/1.1\r\nHost: ${TEST_TARGET_HOST}:${TEST_TARGET_PORT}\r\nConnection: close\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      const line = chunk.toString("utf8", 0, 20);
      finish(/^HTTP\/1\.[01]\s+2\d\d/.test(line));
    });
  });
}

/**
 * Validates a SOCKS5 proxy with a minimal no-auth greeting handshake
 * (client hello -> expect \x05\x00 back). Doesn't do a full CONNECT since
 * many free SOCKS5 proxies require no auth but still confirms it's a real,
 * responsive SOCKS5 server rather than a dead IP:port.
 */
function testSocks5Proxy(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(TEST_TIMEOUT_MS, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // ver=5, 1 method, no-auth
    });
    socket.on("data", (chunk) => {
      finish(chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] === 0x00);
    });
  });
}

function testProxy(proxyUrl) {
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    return Promise.resolve(false);
  }
  const host = u.hostname;
  const port = parseInt(u.port, 10);
  if (!host || !port) return Promise.resolve(false);

  if (u.protocol === "socks5:" || u.protocol === "socks4:") return testSocks5Proxy(host, port);
  return testHttpProxy(host, port); // http:// and https:// schemes both mean "HTTP proxy, use CONNECT"
}

/** Runs `items` through `worker` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * Pulls fresh candidates from ProxyScrape, validates them, and overwrites
 * proxies.txt with the working ones (fastest first). Returns a summary.
 */
async function refreshProxies({ log = console.log } = {}) {
  log(`[ProxyRefresh] Fetching candidate proxies (${PROTOCOLS.join(", ")})...`);

  const lists = await Promise.all(
    PROTOCOLS.map((p) => fetchProxyScrapeList(p).catch((err) => {
      log(`[ProxyRefresh] Failed to fetch ${p} list: ${err.message}`);
      return [];
    }))
  );
  const candidates = [...new Set(lists.flat())];

  if (!candidates.length) {
    log("[ProxyRefresh] No candidates returned — leaving proxies.txt untouched.");
    return { candidates: 0, working: 0 };
  }

  log(`[ProxyRefresh] Testing ${candidates.length} candidates (concurrency ${TEST_CONCURRENCY})...`);

  const working = [];
  await mapWithConcurrency(candidates, TEST_CONCURRENCY, async (proxyUrl) => {
    const started = Date.now();
    const ok = await testProxy(proxyUrl);
    if (ok) working.push({ proxyUrl, ms: Date.now() - started });
  });

  working.sort((a, b) => a.ms - b.ms);
  const chosen = working.slice(0, MAX_PROXIES);

  const header =
    `# Auto-generated by proxyRefresh.js on ${new Date().toISOString()}\n` +
    `# Source: ProxyScrape free API — ${chosen.length}/${candidates.length} candidates passed validation.\n` +
    `# Regenerated automatically; manual edits will be overwritten on next refresh.\n\n`;

  fs.writeFileSync(PROXIES_PATH, header + chosen.map((c) => c.proxyUrl).join("\n") + "\n", "utf8");

  log(`[ProxyRefresh] Wrote ${chosen.length} working proxies to ${PROXIES_PATH}.`);
  return { candidates: candidates.length, working: chosen.length };
}

let intervalHandle = null;

/** Starts an immediate refresh, then repeats every PROXY_REFRESH_INTERVAL_MS. */
function schedule() {
  const intervalMs = parseInt(process.env.PROXY_REFRESH_INTERVAL_MS || String(30 * 60 * 1000), 10); // 30 min default

  refreshProxies().catch((err) => console.error("[ProxyRefresh] Initial refresh failed:", err.message));

  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    refreshProxies().catch((err) => console.error("[ProxyRefresh] Scheduled refresh failed:", err.message));
  }, intervalMs);
  intervalHandle.unref?.(); // don't keep the process alive just for this timer

  console.log(`[ProxyRefresh] Auto-refresh scheduled every ${Math.round(intervalMs / 60000)} min.`);
  return intervalHandle;
}

function stopSchedule() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { refreshProxies, schedule, stopSchedule, PROXIES_PATH };
