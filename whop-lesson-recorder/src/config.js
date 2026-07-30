const path = require("path");

module.exports = {
  START_URL:
    process.env.WHOP_COURSE_URL ||
    "https://whop.com/joined/stock-levels-university/courses-94JIiuIOk0rF9Z/app/courses/cors_735fYA0y1gm56dsInBAzCi/lessons/lesn_24d1KEJuSVPyap52CjyJ8c/",
  OUTPUT_DIR: path.resolve(__dirname, "..", "output"),
  BROWSER_DATA_DIR: path.resolve(__dirname, "..", "browser-data"),
  BLACKHOLE_DEVICE: process.env.BLACKHOLE_DEVICE || "BlackHole 2ch",
  BUFFER_SECONDS: Number(process.env.BUFFER_SECONDS || 5),
  LESSON_LOAD_TIMEOUT_MS: 30000,
  VIDEO_READY_TIMEOUT_MS: 30000,
  HEADLESS: process.env.HEADLESS === "true",
};
