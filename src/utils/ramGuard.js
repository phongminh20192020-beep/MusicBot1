"use strict";

// Watches this process's own memory usage and exits cleanly *before* the
// host's hard RAM ceiling kills it mid-operation (which tends to happen at
// the worst possible moment -- mid-download, mid-stream, mid-write).
//
// This module only notices the problem and bows out gracefully with a
// non-zero exit code; it does NOT bring the process back up itself. Pair it
// with a host/process manager that restarts on crash/exit, e.g.:
//   - Discloud: set AUTORESTART=true in discloud.config
//   - PM2:      pm2 start ... (restarts on exit by default)
//   - systemd:  Restart=on-failure in the unit file
//
// Configure the limit via MAX_RAM_MB (falls back to DISCLOUD_RAM_MB, since
// that's the number you already type into discloud.config's RAM= field --
// no need to keep the two in sync by hand). If neither is set, monitoring
// is skipped entirely rather than guessing a limit.

const fs = require("fs");
const path = require("path");

const CHECK_INTERVAL_MS = 20_000;
const CONSECUTIVE_OVER_LIMIT_TO_TRIGGER = 3; // ~60s sustained high usage, ignores brief GC-timed spikes

/** Reads RAM=<mb> straight out of discloud.config, if present, so the limit
 * only has to be set in one place instead of kept in sync by hand. */
function readDiscloudConfigRam() {
  try {
    const configPath = path.join(__dirname, "..", "..", "discloud.config");
    const content = fs.readFileSync(configPath, "utf8");
    const match = content.match(/^\s*RAM\s*=\s*(\d+)/mi);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0; // no discloud.config present -- fine, just means another env is in use
  }
}

function startRamGuard({ limitMb, warnAtPercent = 0.85, restartAtPercent = 0.95, onBeforeExit } = {}) {
  const resolvedLimit =
    limitMb ||
    parseInt(process.env.MAX_RAM_MB || process.env.DISCLOUD_RAM_MB || "0", 10) ||
    readDiscloudConfigRam();

  if (!resolvedLimit || resolvedLimit <= 0) {
    console.warn("[RamGuard] No RAM limit configured (set MAX_RAM_MB, DISCLOUD_RAM_MB, or add RAM= to discloud.config) — memory monitoring disabled.");
    return () => {};
  }

  const limitBytes = resolvedLimit * 1024 * 1024;
  const warnBytes = limitBytes * warnAtPercent;
  const restartBytes = limitBytes * restartAtPercent;
  let overCount = 0;
  let warned = false;
  let stopped = false;

  console.log(`[RamGuard] Monitoring memory against a ${resolvedLimit}MB limit (warn at ${Math.round(warnAtPercent * 100)}%, restart at ${Math.round(restartAtPercent * 100)}% sustained).`);

  const timer = setInterval(async () => {
    if (stopped) return;
    const rss = process.memoryUsage().rss;
    const pct = ((rss / limitBytes) * 100).toFixed(1);

    if (rss >= restartBytes) {
      overCount++;
      console.warn(`[RamGuard] RAM at ${pct}% of ${resolvedLimit}MB (${overCount}/${CONSECUTIVE_OVER_LIMIT_TO_TRIGGER} consecutive checks over threshold)`);
      if (overCount >= CONSECUTIVE_OVER_LIMIT_TO_TRIGGER) {
        stopped = true;
        clearInterval(timer);
        console.error(`[RamGuard] Sustained high memory usage (${pct}%) — restarting now to avoid an out-of-memory kill mid-operation.`);
        try {
          if (onBeforeExit) await onBeforeExit();
        } catch (e) {
          console.error("[RamGuard] Error during graceful shutdown:", e.message);
        } finally {
          process.exit(1); // non-zero so the host/process manager treats this as a crash-restart, not a clean stop
        }
      }
      return;
    }

    if (overCount > 0) console.log("[RamGuard] Memory usage back under the restart threshold, resetting counter.");
    overCount = 0;

    if (rss >= warnBytes && !warned) {
      warned = true;
      console.warn(`[RamGuard] RAM usage at ${pct}% of ${resolvedLimit}MB — approaching the restart threshold.`);
    } else if (rss < warnBytes) {
      warned = false;
    }
  }, CHECK_INTERVAL_MS);

  timer.unref(); // a pending interval alone shouldn't keep the process alive
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { startRamGuard };
