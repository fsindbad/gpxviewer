// Thin client for the Worker-backed R2 track library (replaces v4's
// Firebase/Hazu auto-discovery). Same-origin, no CORS proxies needed.
export async function listTracks() {
  const res = await fetch("/api/tracks");
  if (!res.ok) throw new Error(`Failed to list tracks (HTTP ${res.status})`);
  const data = await res.json();
  return data.tracks || [];
}

export async function fetchTrack(key) {
  const res = await fetch(`/api/tracks/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Failed to load track (HTTP ${res.status})`);
  return await res.text();
}

function getPasscode() {
  let code = localStorage.getItem("gpxviewer-upload-passcode");
  if (!code) {
    code = window.prompt("Upload passcode:") || "";
    if (code) localStorage.setItem("gpxviewer-upload-passcode", code);
  }
  return code;
}

export async function uploadTrack(file) {
  const res = await fetch(`/api/tracks/${encodeURIComponent(file.name)}`, {
    method: "PUT",
    headers: { "x-upload-passcode": getPasscode() },
    body: file,
  });
  if (res.status === 401) {
    localStorage.removeItem("gpxviewer-upload-passcode");
    throw new Error("Wrong passcode — try again");
  }
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
  return await res.json();
}
