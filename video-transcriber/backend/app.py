import logging
import os
import subprocess
import tempfile
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from transcriber import ALLOWED_EXTENSIONS, transcribe_video

app = FastAPI()

allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in allowed_origins if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(os.getenv("STATIC_DIR", ""))


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided.")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    with tempfile.TemporaryDirectory() as tmp_dir:
        video_path = Path(tmp_dir) / f"upload{suffix}"
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file.")
        video_path.write_bytes(content)

        try:
            transcript = transcribe_video(video_path)
        except subprocess.CalledProcessError as exc:
            logger.error("ffmpeg failed: %s", exc.stderr.decode(errors="replace") if exc.stderr else exc)
            raise HTTPException(
                status_code=422,
                detail="Could not extract audio from the file.",
            )
        except Exception as exc:
            logger.exception("Transcription failed")
            raise HTTPException(
                status_code=500,
                detail=f"Transcription failed: {exc}",
            )

    return {"transcript": transcript}


if STATIC_DIR.is_dir():
    assets_dir = STATIC_DIR / "static"
    if assets_dir.is_dir():
        app.mount("/static", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found.")

        file_path = STATIC_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
