const { spawn } = require("child_process");

function startRecording({ outputPath, durationSeconds, blackholeDevice }) {
  const args = [
    "-y",
    "-f",
    "avfoundation",
    "-i",
    `:${blackholeDevice}`,
    "-t",
    String(durationSeconds),
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to start ffmpeg. Is ffmpeg installed? ${err.message}`
        )
      );
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(outputPath);
        return;
      }
      reject(
        new Error(
          `ffmpeg exited with code ${code}. Device ":${blackholeDevice}" may be missing. stderr: ${stderr.slice(-500)}`
        )
      );
    });
  });
}

module.exports = { startRecording };
