// Ported from sailing-tracker-v4.html. DOMParser is forgiving of odd GPX
// variants, but building a full DOM for a 60 MB+ file either throws or
// brings the tab to its knees. Above this threshold we switch to a
// streaming/chunked regex scan that never builds a DOM at all.
const LARGE_GPX_THRESHOLD = 8 * 1024 * 1024; // ~8 MB of decoded text

function assignPointIndices(points) {
  for (let i = 0; i < points.length; i++) points[i].idx = i;
  return points;
}

function parseGPXDom(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const parserErr = doc.querySelector("parsererror");
  if (parserErr) throw new Error("GPX XML is invalid (parser error)");
  const nameMatch = /<name>([^<]*)<\/name>/.exec(xmlText);
  const nameEl = doc.querySelector("name");
  const name = nameEl ? nameEl.textContent : (nameMatch ? nameMatch[1] : "Unnamed Track");
  const trkpts = doc.querySelectorAll("trkpt");
  if (trkpts.length === 0) throw new Error("No track points found");
  const points = [];
  trkpts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    const eleEl = pt.querySelector("ele");
    const timeEl = pt.querySelector("time");
    const speedEl = pt.querySelector("speed");
    const courseEl = pt.querySelector("course");
    points.push({
      lat, lon,
      ele: eleEl ? parseFloat(eleEl.textContent) : 0,
      time: timeEl ? new Date(timeEl.textContent) : null,
      gpsSpeed: speedEl ? parseFloat(speedEl.textContent) : null,
      course: courseEl ? parseFloat(courseEl.textContent) : null,
      speed: 0, speedKn: 0, speedKmh: 0,
      heading: 0, distance: 0, totalDist: 0,
    });
  });
  if (points.length === 0) throw new Error("No points with valid lat/lon coordinates");
  return { name, points: assignPointIndices(points) };
}

// Regex-based scanner for very large files. Matches both self-closing
// <trkpt .../> and open/close <trkpt ...>...</trkpt> forms without assuming
// an attribute order.
const RE_TRKPT_GENERIC = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
const RE_LAT_ATTR = /\blat="([-\d.eE+]+)"/;
const RE_LON_ATTR = /\blon="([-\d.eE+]+)"/;
const RE_ELE_TAG = /<ele>([^<]*)<\/ele>/;
const RE_TIME_TAG = /<time>([^<]*)<\/time>/;
const RE_SPEED_TAG = /<speed>([^<]*)<\/speed>/;
const RE_COURSE_TAG = /<course>([^<]*)<\/course>/;
const RE_NAME_TAG = /<name>([^<]*)<\/name>/;
const STREAM_CHUNK_POINTS = 20000;

async function parseGPXStreaming(xmlText, onProgress) {
  const nameMatch = RE_NAME_TAG.exec(xmlText);
  const name = nameMatch ? nameMatch[1] : "Unnamed Track";

  const points = [];
  let match;
  let sawAnyTrkpt = false;
  let count = 0;

  RE_TRKPT_GENERIC.lastIndex = 0;
  while ((match = RE_TRKPT_GENERIC.exec(xmlText)) !== null) {
    sawAnyTrkpt = true;
    const attrs = match[1] || "";
    const inner = match[2] || "";

    const latM = RE_LAT_ATTR.exec(attrs);
    const lonM = RE_LON_ATTR.exec(attrs);
    const lat = latM ? parseFloat(latM[1]) : NaN;
    const lon = lonM ? parseFloat(lonM[1]) : NaN;
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const eleM = RE_ELE_TAG.exec(inner);
    const timeM = RE_TIME_TAG.exec(inner);
    const speedM = RE_SPEED_TAG.exec(inner);
    const courseM = RE_COURSE_TAG.exec(inner);

    points.push({
      lat, lon,
      ele: eleM ? parseFloat(eleM[1]) : 0,
      time: timeM ? new Date(timeM[1]) : null,
      gpsSpeed: speedM ? parseFloat(speedM[1]) : null,
      course: courseM ? parseFloat(courseM[1]) : null,
      speed: 0, speedKn: 0, speedKmh: 0,
      heading: 0, distance: 0, totalDist: 0,
    });

    count++;
    if (count % STREAM_CHUNK_POINTS === 0) {
      if (onProgress) onProgress(count);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (!sawAnyTrkpt) throw new Error("No track points found");
  if (points.length === 0) throw new Error("No points with valid lat/lon coordinates");
  if (onProgress) onProgress(count);
  return { name, points: assignPointIndices(points) };
}

// Public entry point. `onProgress(count)` is optional and only called during
// the streaming path (the DOM path is effectively instantaneous below 8 MB).
export async function parseGPX(xmlText, onProgress) {
  if (typeof xmlText !== "string") xmlText = String(xmlText);
  if (xmlText.length < LARGE_GPX_THRESHOLD) {
    return parseGPXDom(xmlText);
  }
  return await parseGPXStreaming(xmlText, onProgress);
}
