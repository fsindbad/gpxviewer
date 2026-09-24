// Boat/buoy/target icon markup, ported from sailing-tracker-v4.html.
// A small sailboat from above: pointed bow, hull tapering to the stern, a
// white sail on top. Faces north (0°), rotates with heading. One shared path
// for 2D (SVG) and 3D (Canvas via Path2D).
const BOAT_HULL_PATH = "M16,2 C19.2,7 20.6,13 20.6,18.5 L19.8,25 Q16,27.4 12.2,25 L11.4,18.5 C11.4,13 12.8,7 16,2 Z";
const BOAT_SAIL_PATH = "M16,5.5 L16,22 L20.2,19.6 C19.6,13.4 18.2,9 16,5.5 Z";
const BOAT_JIB_PATH = "M15.2,7.5 L15.2,20.5 L12,19 C12.4,14.2 13.5,10.4 15.2,7.5 Z";

export const boatSVGMarkup = `<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg">
  <path d="${BOAT_HULL_PATH}" fill="#e94560" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="${BOAT_JIB_PATH}" fill="#ffffff" opacity="0.75"/>
  <path d="${BOAT_SAIL_PATH}" fill="#ffffff" opacity="0.95"/>
  <line x1="16" y1="4" x2="16" y2="23" stroke="#20304a" stroke-width="1" opacity="0.8"/>
</svg>`;

// Cesium can load SVG data URIs unreliably as a WebGL texture, so the same
// boat is drawn onto a canvas instead — that always works.
export function makeBoatCanvas(size) {
  const s = size || 64;
  const c = document.createElement("canvas");
  c.width = s; c.height = s;
  const g = c.getContext("2d");
  const k = s / 32;
  g.scale(k, k);
  g.lineJoin = "round";

  const hull = new Path2D(BOAT_HULL_PATH);
  g.fillStyle = "#e94560";
  g.fill(hull);
  g.lineWidth = 1.5;
  g.strokeStyle = "#ffffff";
  g.stroke(hull);

  g.globalAlpha = 0.75;
  g.fillStyle = "#ffffff";
  g.fill(new Path2D(BOAT_JIB_PATH));
  g.globalAlpha = 0.95;
  g.fill(new Path2D(BOAT_SAIL_PATH));
  g.globalAlpha = 1;

  g.beginPath();
  g.moveTo(16, 4); g.lineTo(16, 23);
  g.lineWidth = 1;
  g.strokeStyle = "rgba(32,48,74,0.8)";
  g.stroke();
  return c;
}

export const buoySVGMarkup = `<svg viewBox="0 0 28 34" width="28" height="34" xmlns="http://www.w3.org/2000/svg">
  <polygon points="14,0 20,10 8,10" fill="#ffa500" stroke="#cc8400" stroke-width="0.6"/>
  <circle cx="14" cy="19" r="9" fill="#ffa500" stroke="#fff" stroke-width="2"/>
  <rect x="12" y="28" width="4" height="6" fill="#cc8400"/>
</svg>`;

export function svgToDataUri(svgStr) {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgStr)));
}

export const targetIconDataUri = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4IiBzdHJva2U9IiNmZmE1MDAiIHN0cm9rZS13aWR0aD0iMiIgZmlsbD0ibm9uZSIvPjxwb2x5Z29uIHBvaW50cz0iMTIsMCAxNiw4IDI0LDEyIDE2LDE2IDEyLDI0IDgsIDE2IDAsIDEyIDgsOCIgZmlsbD0iI2ZmYTUwMCIvPjwvc3ZnPg==";

export function createBoatIcon(L, heading) {
  return L.divIcon({
    html: `<div style="transform:rotate(${heading}deg);transform-origin:16px 16px;width:32px;height:32px;">${boatSVGMarkup}</div>`,
    className: "", iconSize: [32, 32], iconAnchor: [16, 16],
  });
}

export function createBuoyIcon(L, buoyDataUri) {
  return L.icon({ iconUrl: buoyDataUri, iconSize: [28, 34], iconAnchor: [14, 32] });
}
