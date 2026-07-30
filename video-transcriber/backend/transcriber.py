import subprocess
import tempfile
from pathlib import Path

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".mp4a"}
ALLOWED_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS

_model = None
_model_device = None


def get_model(device=None):
    global _model, _model_device
    if _model is None or _model_device != device:
        from transformers import pipeline

        _model_device = device
        _model = pipeline(
            "automatic-speech-recognition",
            model="openai/whisper-base",
            device=device,
            chunk_length_s=30,
        )
    return _model


def _pick_device():
    import os

    import torch

    forced = os.getenv("WHISPER_DEVICE", "cpu").lower()
    if forced in {"cpu", "-1"}:
        return -1
    if forced == "mps":
        return "mps"
    if forced in {"cuda", "gpu", "0"} and torch.cuda.is_available():
        return 0

    if torch.cuda.is_available():
        return 0
    return -1


def prepare_audio(input_path: Path, audio_path: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(audio_path),
    ]
    if input_path.suffix.lower() in VIDEO_EXTENSIONS:
        command.insert(4, "-vn")

    subprocess.run(command, check=True, capture_output=True)


def _run_transcription(audio_path: Path, device) -> str:
    result = get_model(device)(
        str(audio_path),
        generate_kwargs={"language": "en", "task": "transcribe"},
    )
    return result["text"].strip()


def transcribe_video(media_path: Path) -> str:
    with tempfile.TemporaryDirectory() as tmp_dir:
        audio_path = Path(tmp_dir) / "audio.wav"
        prepare_audio(media_path, audio_path)
        device = _pick_device()
        try:
            return _run_transcription(audio_path, device)
        except Exception:
            if device not in (-1, "cpu"):
                return _run_transcription(audio_path, -1)
            raise
