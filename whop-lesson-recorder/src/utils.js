const fs = require("fs");
const path = require("path");

const DURATION_REGEX = /Multimedia\s*•\s*(\d+):(\d{2})(?::(\d{2}))?/i;

function parseDurationToSeconds(durationText) {
  const match = durationText.match(DURATION_REGEX);
  if (!match) {
    throw new Error(`Could not parse duration from: ${durationText}`);
  }

  const part1 = Number(match[1]);
  const part2 = Number(match[2]);
  const part3 = match[3] ? Number(match[3]) : null;

  if (part3 !== null) {
    return part1 * 3600 + part2 * 60 + part3;
  }
  return part1 * 60 + part2;
}

function sanitizeFilename(title) {
  return title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
}

function ensureOutputDir(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function uniqueOutputPath(outputDir, title, extension = ".mp3") {
  const base = sanitizeFilename(title) || "untitled_lesson";
  let candidate = path.join(outputDir, `${base}${extension}`);
  let counter = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${base}_${counter}${extension}`);
    counter += 1;
  }

  return candidate;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DURATION_REGEX,
  parseDurationToSeconds,
  sanitizeFilename,
  ensureOutputDir,
  uniqueOutputPath,
  sleep,
};
