"use strict";

// ─── Cool startup banner ───────────────────────────────────────────────────────
// Pure ANSI escape codes — no extra dependencies (chalk/figlet) required.

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";

function rgb(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

// Smooth hue -> RGB so we can rainbow-sweep text across a gradient.
function hslToRgb(h, s, l) {
  h /= 360;
  const k = n => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Colors a string with a smooth gradient sweeping across a hue range.
function gradient(text, startHue, endHue) {
  const chars = [...text];
  const n = Math.max(chars.length - 1, 1);
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const hue = startHue + ((endHue - startHue) * i) / n;
      const [r, g, b] = hslToRgb(hue, 0.85, 0.62);
      return `${rgb(r, g, b)}${ch}`;
    })
    .join("") + RESET;
}

const LOGO = [
  "  ███╗   ██╗ ██████╗ ███╗   ██╗ █████╗ ███╗   ███╗███████╗",
  "  ████╗  ██║██╔═══██╗████╗  ██║██╔══██╗████╗ ████║██╔════╝",
  "  ██╔██╗ ██║██║   ██║██╔██╗ ██║███████║██╔████╔██║█████╗  ",
  "  ██║╚██╗██║██║   ██║██║╚██╗██║██╔══██║██║╚██╔╝██║██╔══╝  ",
  "  ██║ ╚████║╚██████╔╝██║ ╚████║██║  ██║██║ ╚═╝ ██║███████╗",
  "  ╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝",
  "               M U S I C   B O T",
];

function bar(width, hueStart, hueEnd) {
  return gradient("─".repeat(width), hueStart, hueEnd);
}

function pad(label, value, labelWidth) {
  return `  ${DIM}${label.padEnd(labelWidth)}${RESET}${BOLD}${value}${RESET}`;
}

function printLoginBanner(client) {
  const startHue = Math.random() * 360;
  console.log("");
  for (let i = 0; i < LOGO.length; i++) {
    console.log(gradient(LOGO[i], (startHue + i * 12) % 360, (startHue + i * 12 + 140) % 360));
  }
  console.log(bar(62, startHue, (startHue + 280) % 360));

  const guildCount = client.guilds.cache.size;
  const shardInfo  = client.shard ? `#${client.shard.ids.join(",")}` : "0";
  const memMb      = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  console.log(pad("Logged in as", `${client.user.tag}`, 16));
  console.log(pad("Client ID", client.user.id, 16));
  console.log(pad("Guilds", `${guildCount}`, 16));
  console.log(pad("Shard", shardInfo, 16));
  console.log(pad("Node.js", process.version, 16));
  console.log(pad("Memory", `${memMb} MB`, 16));
  console.log(pad("Ready at", new Date().toLocaleString(), 16));
  console.log(bar(62, (startHue + 280) % 360, startHue));
  console.log("");
}

module.exports = { printLoginBanner, gradient };
