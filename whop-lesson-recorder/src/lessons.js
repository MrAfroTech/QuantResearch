const { DURATION_REGEX, parseDurationToSeconds } = require("./utils");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function extractLessons(page) {
  await page.waitForFunction(
    () => /Multimedia\s*•\s*\d+:\d{2}/i.test(document.body.innerText || ""),
    { timeout: 60000 }
  );

  const lessons = await page.evaluate(() => {
    const durationRegex = /Multimedia\s*•\s*(\d+):(\d{2})(?::(\d{2}))?/i;
    const results = [];
    const seen = new Set();

    const durationNodes = Array.from(
      document.querySelectorAll("span, p, div, li, button, a")
    ).filter((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      return durationRegex.test(text) && text.length < 80;
    });

    for (const durationEl of durationNodes) {
      const durationText = (durationEl.innerText || durationEl.textContent || "").trim();
      const match = durationText.match(durationRegex);
      if (!match) continue;

      const container =
        durationEl.closest("li, article, [role='listitem'], [data-testid], div") ||
        durationEl.parentElement;
      if (!container) continue;

      const title = (() => {
        const clone = container.cloneNode(true);
        clone.querySelectorAll("*").forEach((node) => {
          if (durationRegex.test(node.textContent || "")) {
            node.remove();
          }
        });
        const lines = (clone.textContent || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !durationRegex.test(line))
          .filter((line) => !/^multimedia$/i.test(line));
        return lines[0] || "untitled_lesson";
      })();

      const dedupeKey = `${title}::${durationText}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        index: results.length,
        title,
        durationText,
        durationMatch: match[0],
      });
    }

    return results;
  });

  return lessons.map((lesson) => ({
    ...lesson,
    duration_seconds: parseDurationToSeconds(lesson.durationText),
  }));
}

async function clickLesson(page, lesson) {
  const titlePattern = new RegExp(escapeRegExp(lesson.title), "i");
  const durationPattern = new RegExp(escapeRegExp(lesson.durationMatch), "i");

  const locator = page
    .locator("li, button, a, [role='button'], [role='listitem'], div")
    .filter({ hasText: titlePattern })
    .filter({ hasText: durationPattern })
    .first();

  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 15000 });
}

async function waitForVideoReady(page, timeoutMs) {
  const video = page.locator("video").first();
  await video.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForTimeout(1500);
}

async function clickPlay(page) {
  const video = page.locator("video").first();
  await video.click({ timeout: 10000 }).catch(() => {});

  const isPaused = await video.evaluate((el) => el.paused).catch(() => true);
  if (isPaused) {
    await page.keyboard.press("Space");
  }

  await page.waitForTimeout(500);

  const stillPaused = await video.evaluate((el) => el.paused).catch(() => true);
  if (stillPaused) {
    await video.click({ force: true });
  }
}

module.exports = {
  extractLessons,
  clickLesson,
  waitForVideoReady,
  clickPlay,
};
