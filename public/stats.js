import { haversineMeters, bearingDegrees } from "./geo.js";

const MOVING_SPEED_THRESHOLD_MS = 0.5;

// One entry per point-to-point leg: distance, elapsed time, speed, and bearing of travel.
export function buildSegments(points) {
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const distanceM = haversineMeters(a, b);
    const dtS = a.time && b.time ? (b.time - a.time) / 1000 : null;
    segments.push({
      from: a,
      to: b,
      distanceM,
      dtS,
      speedMs: dtS && dtS > 0 ? distanceM / dtS : null,
      bearing: bearingDegrees(a, b),
    });
  }
  return segments;
}

export function computeStats(points, segments) {
  const distanceM = segments.reduce((sum, s) => sum + s.distanceM, 0);

  const hasTime = points[0]?.time && points.at(-1)?.time;
  const durationS = hasTime ? (points.at(-1).time - points[0].time) / 1000 : null;
  const movingS = hasTime
    ? segments.reduce((sum, s) => sum + (s.dtS && s.speedMs > MOVING_SPEED_THRESHOLD_MS ? s.dtS : 0), 0)
    : null;

  const elevationGainM = points.reduce((sum, p, i) => {
    if (i === 0 || Number.isNaN(p.ele) || Number.isNaN(points[i - 1].ele)) return sum;
    const delta = p.ele - points[i - 1].ele;
    return sum + (delta > 0 ? delta : 0);
  }, 0);

  const speeds = segments.map((s) => s.speedMs).filter((v) => v != null);
  const maxSpeedMs = speeds.length ? Math.max(...speeds) : null;
  const avgSpeedMs = movingS ? distanceM / movingS : null;

  return { distanceM, durationS, movingS, elevationGainM, avgSpeedMs, maxSpeedMs };
}

// VMG (velocity made good) toward/away from a wind-from direction, in degrees.
// Positive upwind VMG = closing the distance to the wind source; downwind VMG = opening it.
export function computeVMG(segments, windFromDeg) {
  let upwindSum = 0, upwindCount = 0;
  let downwindSum = 0, downwindCount = 0;

  for (const s of segments) {
    if (s.speedMs == null) continue;
    const diff = Math.abs(((s.bearing - windFromDeg + 540) % 360) - 180);
    const component = s.speedMs * Math.cos((diff * Math.PI) / 180);
    if (component > 0) {
      upwindSum += component;
      upwindCount++;
    } else if (component < 0) {
      downwindSum += -component;
      downwindCount++;
    }
  }

  return {
    avgUpwindMs: upwindCount ? upwindSum / upwindCount : null,
    avgDownwindMs: downwindCount ? downwindSum / downwindCount : null,
  };
}

export function formatDistance(m) {
  if (m == null) return "–";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}

export function formatDuration(s) {
  if (s == null) return "–";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatSpeed(ms) {
  if (ms == null) return "–";
  return `${(ms * 1.94384).toFixed(1)} kn`;
}

export function formatElevation(m) {
  if (m == null || Number.isNaN(m)) return "–";
  return `${m.toFixed(0)} m`;
}
