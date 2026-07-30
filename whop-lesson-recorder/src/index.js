const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const config = require("./config");
const { extractLessons, clickLesson, waitForVideoReady, clickPlay } = require("./lessons");
const { startRecording } = require("./recorder");
const { ensureOutputDir, uniqueOutputPath, sleep } = require("./utils");

async function waitForCourseUi(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(
    () => /Multimedia\s*•\s*\d+:\d{2}/i.test(document.body.innerText || ""),
    { timeout: 120000 }
  );
}

async function recordLesson(page, lesson, outputDir) {
  const recordSeconds = lesson.duration_seconds + config.BUFFER_SECONDS;
  const outputPath = uniqueOutputPath(outputDir, lesson.title);

  console.log(`\n[${lesson.index + 1}] ${lesson.title}`);
  console.log(`    Duration: ${lesson.durationText} (${lesson.duration_seconds}s + ${config.BUFFER_SECONDS}s buffer)`);
  console.log(`    Output: ${outputPath}`);

  await clickLesson(page, lesson);
  await waitForVideoReady(page, config.VIDEO_READY_TIMEOUT_MS);

  const recordingPromise = startRecording({
    outputPath,
    durationSeconds: recordSeconds,
    blackholeDevice: config.BLACKHOLE_DEVICE,
  });

  await sleep(300);
  await clickPlay(page);

  await recordingPromise;

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`Recording failed or produced an empty file: ${outputPath}`);
  }

  console.log(`    Saved: ${outputPath}`);
  return outputPath;
}

async function main() {
  ensureOutputDir(config.OUTPUT_DIR);

  console.log("Whop lesson recorder");
  console.log("====================");
  console.log(`Course URL: ${config.START_URL}`);
  console.log(`Output dir: ${config.OUTPUT_DIR}`);
  console.log(`BlackHole device: :${config.BLACKHOLE_DEVICE}`);
  console.log("");
  console.log("Before running:");
  console.log("  1. Install BlackHole (https://existential.audio/blackhole/)");
  console.log("  2. Route Chromium audio to BlackHole via Audio MIDI Setup");
  console.log("  3. Log into Whop in the browser profile on first run if needed");
  console.log("");

  const context = await chromium.launchPersistentContext(config.BROWSER_DATA_DIR, {
    headless: config.HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.START_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitForCourseUi(page);

    const lessons = await extractLessons(page);
    if (lessons.length === 0) {
      throw new Error("No lessons found in the left sidebar.");
    }

    console.log(`Found ${lessons.length} lessons.`);

    const manifestPath = path.join(config.OUTPUT_DIR, "manifest.json");
    const results = [];

    for (const lesson of lessons) {
      try {
        const outputPath = await recordLesson(page, lesson, config.OUTPUT_DIR);
        results.push({
          title: lesson.title,
          duration_seconds: lesson.duration_seconds,
          duration_text: lesson.durationText,
          output_path: outputPath,
          status: "ok",
        });
      } catch (err) {
        console.error(`    Failed: ${err.message}`);
        results.push({
          title: lesson.title,
          duration_seconds: lesson.duration_seconds,
          duration_text: lesson.durationText,
          status: "failed",
          error: err.message,
        });
      }
    }

    fs.writeFileSync(manifestPath, JSON.stringify(results, null, 2));
    console.log(`\nDone. Manifest written to ${manifestPath}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
