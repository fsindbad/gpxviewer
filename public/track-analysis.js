// Pure analysis/geometry helpers ported from sailing-tracker-v4.html.
// No DOM, no Leaflet/Cesium — safe to unit-test and reuse from any view.
import { haversine, calcBearing, DEG } from "./geo.js";

export function analyzeTrack(points) {
  let totalDist = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], curr = points[i];
    const dist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    curr.distance = dist;
    totalDist += dist;
    curr.totalDist = totalDist;
    if (curr.gpsSpeed !== null && curr.gpsSpeed > 0) {
      curr.speed = curr.gpsSpeed;
    } else if (curr.time && prev.time) {
      const dt = (curr.time - prev.time) / 1000;
      curr.speed = dt > 0 ? dist / dt : 0;
    }
    curr.speedKn = curr.speed * 1.94384;
    curr.speedKmh = curr.speed * 3.6;
    curr.heading = calcBearing(prev.lat, prev.lon, curr.lat, curr.lon);
  }
  if (points.length > 1) points[0].heading = points[1].heading;

  // A single loop instead of Math.max(...array)/map/filter/reduce over the
  // raw points — at 125k+ points the spread operator blows the call stack.
  let maxSpeed = 0, movingSum = 0, movingCount = 0;
  for (let i = 0; i < points.length; i++) {
    const s = points[i].speedKn;
    if (s > maxSpeed) maxSpeed = s;
    if (s > 0.5) { movingSum += s; movingCount++; }
  }

  const duration = points.length > 1 && points[0].time && points[points.length - 1].time
    ? (points[points.length - 1].time - points[0].time) / 1000 : 0;
  const avgInt = points.length > 1 && duration > 0 ? duration / (points.length - 1) : 0;
  return {
    totalDist, duration, maxSpeed,
    avgSpeed: movingCount > 0 ? movingSum / movingCount : 0,
    pointCount: points.length,
    avgInterval: Math.round(avgInt) || 1,
  };
}

// Even-stride thinning — right for time series like the speed chart, where
// equal spacing matters more than geometric fidelity.
export function strideSubset(points, maxPoints) {
  const n = points.length;
  if (n <= maxPoints) return points;
  const stride = n / maxPoints;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(points[Math.min(n - 1, Math.round(i * stride))]);
  }
  if (result[result.length - 1] !== points[n - 1]) result.push(points[n - 1]);
  return result;
}

// Douglas-Peucker, iterative with its own stack (recursion would blow the
// call stack past a few hundred thousand points). Computed in local meters.
export function simplifyDouglasPeucker(points, toleranceM) {
  const n = points.length;
  if (n < 3) return points.slice();

  const lat0 = points[0].lat * DEG;
  const mPerLat = 111132, mPerLon = 111320 * Math.cos(lat0);
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = (points[i].lon - points[0].lon) * mPerLon;
    Y[i] = (points[i].lat - points[0].lat) * mPerLat;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = toleranceM * toleranceM;

  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b <= a + 1) continue;
    const ax = X[a], ay = Y[a];
    const dx = X[b] - ax, dy = Y[b] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestIdx = -1;
    for (let i = a + 1; i < b; i++) {
      let d2;
      if (len2 === 0) {
        const ex = X[i] - ax, ey = Y[i] - ay;
        d2 = ex * ex + ey * ey;
      } else {
        let t = ((X[i] - ax) * dx + (Y[i] - ay) * dy) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = X[i] - (ax + t * dx), ey = Y[i] - (ay + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > best) { best = d2; bestIdx = i; }
    }
    if (best > tol2) { keep[bestIdx] = 1; stack.push(a, bestIdx); stack.push(bestIdx, b); }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export const DISPLAY_TOLERANCE_M = 1.0; // 1 m is below GPS accuracy
export const DISPLAY_MAX_POINTS = 150000;

export function buildDisplayPoints(points, maxPoints) {
  maxPoints = maxPoints || DISPLAY_MAX_POINTS;
  const n = points.length;
  if (n <= 2) return points;

  let tol = DISPLAY_TOLERANCE_M;
  let simplified = simplifyDouglasPeucker(points, tol);
  let guard = 0;
  while (simplified.length > maxPoints && guard++ < 8) {
    tol *= 2;
    simplified = simplifyDouglasPeucker(points, tol);
  }
  return simplified;
}

// GPS speed is noisy; smoothing it with a moving average roughly halves to
// quarters the number of color changes (and thus map layers) when coloring
// the track by speed.
export const COLOR_SMOOTH_WINDOW = 9;
export function assignSmoothedSpeed(points, window) {
  const w = window || COLOR_SMOOTH_WINDOW;
  const h = Math.floor(w / 2);
  const n = points.length;
  if (n === 0) return points;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (points[i].speedKn || 0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    points[i].speedSmooth = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return points;
}

export function nearestPointTo(latlng, points) {
  let best = points[0], bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dLat = p.lat - latlng.lat, dLon = p.lon - latlng.lng;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ---- Speed color ----
const SPEED_COLOR_STOPS = [
  [0.00, 49, 54, 149], [0.15, 69, 117, 180], [0.30, 116, 173, 209],
  [0.45, 171, 217, 233], [0.55, 254, 224, 144], [0.70, 253, 174, 97],
  [0.85, 244, 109, 67], [1.00, 215, 48, 39],
];

// Returns [r,g,b] in 0-255, or null if maxSpeed <= 0 (caller picks a gray fallback).
export function speedColorRgb(speed, maxSpeed) {
  if (maxSpeed <= 0) return null;
  const t = Math.min(speed / maxSpeed, 1);
  let lo = SPEED_COLOR_STOPS[0], hi = SPEED_COLOR_STOPS[SPEED_COLOR_STOPS.length - 1];
  for (let i = 0; i < SPEED_COLOR_STOPS.length - 1; i++) {
    if (t >= SPEED_COLOR_STOPS[i][0] && t <= SPEED_COLOR_STOPS[i + 1][0]) {
      lo = SPEED_COLOR_STOPS[i]; hi = SPEED_COLOR_STOPS[i + 1]; break;
    }
  }
  const f = (hi[0] - lo[0]) > 0 ? (t - lo[0]) / (hi[0] - lo[0]) : 0;
  return [
    Math.round(lo[1] + f * (hi[1] - lo[1])),
    Math.round(lo[2] + f * (hi[2] - lo[2])),
    Math.round(lo[3] + f * (hi[3] - lo[3])),
  ];
}

export function speedColorCss(speed, maxSpeed) {
  const rgb = speedColorRgb(speed, maxSpeed);
  return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : "#666";
}

const SPEED_BUCKET_COUNT = 8;
export function speedBucketIndex(speedKn, maxSpd) {
  if (maxSpd <= 0) return 0;
  const t = Math.min(Math.max(speedKn, 0) / maxSpd, 1);
  return Math.min(SPEED_BUCKET_COUNT - 1, Math.floor(t * SPEED_BUCKET_COUNT));
}
export function colorBucketOf(pt, maxSpd) {
  const v = (pt.speedSmooth !== undefined && pt.speedSmooth !== null) ? pt.speedSmooth : pt.speedKn;
  return speedBucketIndex(v, maxSpd);
}
export function colorForSpeedBucket(bucket, maxSpd) {
  return speedColorCss(((bucket + 0.5) / SPEED_BUCKET_COUNT) * maxSpd, maxSpd);
}
export { SPEED_BUCKET_COUNT };

// ---- Interpolation ----
export function lerp(a, b, t) { return a + (b - a) * t; }
export function lerpAngle(a, b, t) {
  const diff = ((b - a + 180) % 360 + 360) % 360 - 180;
  return (a + diff * t + 360) % 360;
}

export function pointAtFloatIndex(points, pos) {
  pos = Math.max(0, Math.min(pos, points.length - 1));
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, points.length - 1);
  const frac = pos - i0;
  const p0 = points[i0], p1 = points[i1];
  if (frac === 0 || i0 === i1) return p0;
  return {
    lat: lerp(p0.lat, p1.lat, frac),
    lon: lerp(p0.lon, p1.lon, frac),
    heading: lerpAngle(p0.heading, p1.heading, frac),
    speed: lerp(p0.speed, p1.speed, frac),
    speedKn: lerp(p0.speedKn, p1.speedKn, frac),
    speedKmh: lerp(p0.speedKmh, p1.speedKmh, frac),
    totalDist: lerp(p0.totalDist, p1.totalDist, frac),
    time: (p0.time && p1.time) ? new Date(p0.time.getTime() + (p1.time - p0.time) * frac) : p0.time,
  };
}

// VMG (velocity made good) toward a target mark's lat/lon.
export function calculateVMG(boatHeading, boatSpeed, targetLat, targetLon, boatLat, boatLon) {
  if (targetLat === null || targetLon === null) return null;
  const bearingToTarget = calcBearing(boatLat, boatLon, targetLat, targetLon);
  const angleDiff = ((bearingToTarget - boatHeading + 180) % 360) - 180;
  const vmg = boatSpeed * Math.cos(angleDiff * DEG);
  return { vmg, bearing: bearingToTarget, angleDiff };
}

export function fmtDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
