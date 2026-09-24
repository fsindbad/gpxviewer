export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) throw new Error("Invalid GPX file");

  const name = doc.querySelector("trk > name, metadata > name")?.textContent?.trim() || "Untitled track";

  const points = Array.from(doc.querySelectorAll("trkpt")).map((pt) => ({
    lat: parseFloat(pt.getAttribute("lat")),
    lon: parseFloat(pt.getAttribute("lon")),
    ele: parseFloat(pt.querySelector("ele")?.textContent ?? "NaN"),
    time: pt.querySelector("time")?.textContent ? new Date(pt.querySelector("time").textContent) : null,
  }));

  if (points.length === 0) throw new Error("No track points found in GPX file");

  return { name, points };
}
