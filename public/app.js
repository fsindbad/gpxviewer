import { parseGPX } from "./gpx.js";
import { buildSegments, computeStats, computeVMG, formatDistance, formatDuration, formatSpeed, formatElevation } from "./stats.js";

const fileInput = document.getElementById("file-input");
const sampleBtn = document.getElementById("sample-btn");
const sailingToggle = document.getElementById("sailing-toggle");
const sailingSection = document.getElementById("sailing-section");
const windDirInput = document.getElementById("wind-dir");
const windDirValue = document.getElementById("wind-dir-value");
const emptyState = document.getElementById("empty-state");
const content = document.getElementById("content");
const trackNameEl = document.getElementById("track-name");
const speedChart = document.getElementById("speed-chart");

const map = L.map("map", { zoomControl: true }).setView([47.23, 8.8], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

let trackLayer = null;
let currentSegments = [];

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  loadTrack(await file.text());
});

sampleBtn.addEventListener("click", async () => {
  const res = await fetch("tracks/sample1.gpx");
  loadTrack(await res.text());
});

sailingToggle.addEventListener("change", () => {
  sailingSection.hidden = !sailingToggle.checked;
  renderTrackLayer();
  updateSailingStats();
});

windDirInput.addEventListener("input", () => {
  windDirValue.textContent = `${windDirInput.value}°`;
  updateSailingStats();
});

function loadTrack(xmlText) {
  let track;
  try {
    track = parseGPX(xmlText);
  } catch (err) {
    alert(err.message);
    return;
  }

  currentSegments = buildSegments(track.points);
  const stats = computeStats(track.points, currentSegments);

  trackNameEl.textContent = track.name;
  document.getElementById("stat-distance").textContent = formatDistance(stats.distanceM);
  document.getElementById("stat-duration").textContent = formatDuration(stats.durationS);
  document.getElementById("stat-elevation").textContent = formatElevation(stats.elevationGainM);
  document.getElementById("stat-avg-speed").textContent = formatSpeed(stats.avgSpeedMs);
  document.getElementById("stat-max-speed").textContent = formatSpeed(stats.maxSpeedMs);
  document.getElementById("stat-moving-time").textContent = formatDuration(stats.movingS);

  emptyState.hidden = true;
  content.hidden = false;

  renderTrackLayer(track.points);
  drawSpeedChart(currentSegments);
  updateSailingStats();
}

function renderTrackLayer(points) {
  if (trackLayer) {
    map.removeLayer(trackLayer);
    trackLayer = null;
  }
  if (!points && currentSegments.length === 0) return;

  const pts = points || [currentSegments[0].from, ...currentSegments.map((s) => s.to)];

  const lineLayers = sailingToggle.checked && currentSegments.length > 0
    ? coloredBySpeed(currentSegments)
    : [L.polyline(pts.map((p) => [p.lat, p.lon]), { color: "#e94560", weight: 3 })];

  const startEndMarkers = [
    L.marker([pts[0].lat, pts[0].lon]).bindTooltip("Start"),
    L.marker([pts.at(-1).lat, pts.at(-1).lon]).bindTooltip("End"),
  ];

  trackLayer = L.layerGroup([...lineLayers, ...startEndMarkers]).addTo(map);
  map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [20, 20] });
}

function coloredBySpeed(segments) {
  const maxSpeed = Math.max(...segments.map((s) => s.speedMs ?? 0), 0.01);
  return segments.map((s) =>
    L.polyline(
      [[s.from.lat, s.from.lon], [s.to.lat, s.to.lon]],
      { color: speedColor((s.speedMs ?? 0) / maxSpeed), weight: 4 }
    )
  );
}

function speedColor(ratio) {
  // 0 = slow (blue) -> 1 = fast (red)
  const hue = 220 - 220 * Math.min(1, Math.max(0, ratio));
  return `hsl(${hue}, 80%, 55%)`;
}

function updateSailingStats() {
  if (!sailingToggle.checked || currentSegments.length === 0) return;
  const { avgUpwindMs, avgDownwindMs } = computeVMG(currentSegments, Number(windDirInput.value));
  document.getElementById("stat-vmg-up").textContent = formatSpeed(avgUpwindMs);
  document.getElementById("stat-vmg-down").textContent = formatSpeed(avgDownwindMs);
}

function drawSpeedChart(segments) {
  const ctx = speedChart.getContext("2d");
  const { width, height } = speedChart;
  ctx.clearRect(0, 0, width, height);

  const speeds = segments.map((s) => s.speedMs ?? 0);
  if (speeds.length === 0) return;
  const maxSpeed = Math.max(...speeds, 0.01);

  ctx.beginPath();
  ctx.strokeStyle = "#e94560";
  ctx.lineWidth = 1.5;
  speeds.forEach((v, i) => {
    const x = (i / (speeds.length - 1)) * width;
    const y = height - (v / maxSpeed) * height;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}
