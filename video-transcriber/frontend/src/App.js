import { useState } from "react";
import "./App.css";

const ACCEPTED_TYPES = "video/mp4,video/quicktime,video/x-msvideo,video/webm,video/x-matroska,audio/mpeg,audio/mp4,audio/x-m4a,audio/mp3,.mp4,.mov,.avi,.mkv,.webm,.m4v,.mp3,.m4a,.mp4a";
const API_BASE = process.env.REACT_APP_API_URL || "";

function App() {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!file) {
      setError("Please select a video or audio file.");
      return;
    }

    setLoading(true);
    setError("");
    setTranscript("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`${API_BASE}/api/transcribe`, {
        method: "POST",
        body: formData,
      });

      const contentType = response.headers.get("content-type") || "";
      let data;
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        const text = await response.text();
        throw new Error(text || `Request failed (${response.status})`);
      }

      if (!response.ok) {
        const detail = data.detail;
        const message = Array.isArray(detail)
          ? detail.map((item) => item.msg || String(item)).join(", ")
          : detail;
        throw new Error(message || "Transcription failed.");
      }

      setTranscript(data.transcript);
    } catch (err) {
      const message = err.message || "Something went wrong.";
      if (message.includes("408") || message.includes("Timeout") || message.includes("CONNECTION_RESET")) {
        setError(
          "The request timed out or the server stopped. Try a shorter video, restart the backend, and wait — transcription can take several minutes."
        );
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <h1>Video Transcriber</h1>
      <p className="subtitle">Upload a video or audio file (MP3, M4A) to generate a transcript.</p>

      <form className="upload-form" onSubmit={handleSubmit}>
        <input
          className="file-input"
          type="file"
          accept={ACCEPTED_TYPES}
          onChange={(e) => setFile(e.target.files[0] || null)}
        />
        <button className="submit-btn" type="submit" disabled={loading || !file}>
          {loading ? "Processing…" : "Transcribe"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {transcript && (
        <section className="transcript-section">
          <h2>Transcript</h2>
          <div className="transcript">{transcript}</div>
        </section>
      )}
    </div>
  );
}

export default App;
