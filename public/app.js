'use strict';
// Sailing Tracker — ported from the old gpx-viewer repo's sailing-tracker-v4.html.
// Kept as one file (like the source) because nearly every function here
// shares mutable UI/map state (trackData, leafletMap, cesiumViewer, buoys...);
// splitting it into independently-imported pieces would add indirection
// without a real reuse boundary. Pure, stateless logic lives in the
// imported modules instead.
import { parseGPX } from "./gpx.js";
import { R_EARTH, DEG } from "./geo.js";
import {
  analyzeTrack, assignSmoothedSpeed, buildDisplayPoints, simplifyDouglasPeucker,
  strideSubset, nearestPointTo, speedColorCss, speedColorRgb, colorBucketOf,
  colorForSpeedBucket, pointAtFloatIndex, calculateVMG, lerp, lerpAngle, fmtDur,
} from "./track-analysis.js";
import {
  makeBoatCanvas, buoySVGMarkup, svgToDataUri, targetIconDataUri,
  createBoatIcon, createBuoyIcon,
} from "./icons.js";
import { listTracks, fetchTrack, uploadTrack } from "./track-library.js";

function speedColorCesium(speed, maxSpeed) {
  const rgb = speedColorRgb(speed, maxSpeed);
  if (!rgb) return Cesium.Color.GRAY;
  return new Cesium.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1.0);
}

const boatCanvas3D = makeBoatCanvas(64);
const buoyDataUri3D = svgToDataUri(buoySVGMarkup);

// ============================================================
// 2D MAP (Leaflet)
// ============================================================
const leafletMap = L.map('map-2d', { zoomControl: true, preferCanvas: true })
  .setView([47.23, 8.80], 14);

const trackRenderer = L.canvas({ padding: 0.3 });

const tileLayers = {
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '&copy; Esri'
  }),
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OSM'
  }),
  'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '&copy; OpenTopoMap'
  }),
};
tileLayers['Satellite'].addTo(leafletMap);
L.control.layers(tileLayers, null, { position: 'topright' }).addTo(leafletMap);

function switchBaseLayer(name) {
  if (!tileLayers[name]) return;
  Object.values(tileLayers).forEach(l => { if (leafletMap.hasLayer(l)) leafletMap.removeLayer(l); });
  tileLayers[name].addTo(leafletMap);
}

// ============================================================
// 3D GLOBE (CesiumJS) — no Ion token: Esri World Imagery tiles instead, so
// there's no black globe if a token ever expired.
// ============================================================
let cesiumViewer = null;
let cesiumReady = false;

function makeEsriImagery() {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, Maxar, Earthstar Geographics',
    maximumLevel: 19,
  });
}

function initCesium() {
  if (cesiumReady) return;

  try {
    const opts = {
      animation: false, timeline: false, fullscreenButton: false, homeButton: false,
      geocoder: false, navigationHelpButton: false, sceneModePicker: false,
      baseLayerPicker: false, infoBox: false, selectionIndicator: false,
      creditContainer: document.createElement('div'),
      // A flat ellipsoid instead of World Terrain — water is flat anyway, and
      // it needs no Ion token.
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    };

    if (Cesium.ImageryLayer && Cesium.ImageryLayer.fromProviderAsync) {
      opts.baseLayer = Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(makeEsriImagery()), {});
    } else {
      opts.imageryProvider = makeEsriImagery();
    }

    cesiumViewer = new Cesium.Viewer('globe-3d', opts);

    const layers = cesiumViewer.scene.imageryLayers;
    if (layers.length === 0) {
      layers.addImageryProvider(makeEsriImagery());
    }

    cesiumViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b3d5c');
    cesiumViewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a2e');
    cesiumViewer.scene.globe.enableLighting = false;
    cesiumViewer.scene.globe.showGroundAtmosphere = true;
    cesiumViewer.scene.fog.enabled = false;
    cesiumViewer.scene.requestRenderMode = false;

    cesiumReady = true;
  } catch (e) {
    console.error('CesiumJS init failed, trying OSM fallback:', e);
    try {
      cesiumViewer = new Cesium.Viewer('globe-3d', {
        animation: false, timeline: false, fullscreenButton: false,
        homeButton: false, geocoder: false, navigationHelpButton: false,
        sceneModePicker: false, baseLayerPicker: false, infoBox: false,
        selectionIndicator: false,
        creditContainer: document.createElement('div'),
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      });
      cesiumViewer.scene.imageryLayers.removeAll();
      cesiumViewer.scene.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          credit: 'OpenStreetMap', maximumLevel: 19,
        })
      );
      cesiumViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b3d5c');
      cesiumReady = true;
    } catch (e2) {
      console.error('CesiumJS completely failed:', e2);
      alert('Could not load the 3D view. Please check your internet connection.');
    }
  }

  // Wire up the 3D click handler as soon as Cesium is ready, not only when
  // the user switches to the 3D view — this lets buoys/target work in 3D
  // even if the user starts by placing them there.
  if (cesiumReady) setupCesiumClickHandler();
}

// The billboard rotates in screen space, so in every camera orientation
// (chase cam!) its rotation must be computed relative to the camera heading.
let boatHeadingDeg = 0;
function updateBoatBillboardRotation() {
  if (!boatEntity3d || !boatEntity3d.billboard || !cesiumViewer) return;
  const camHeadingDeg = Cesium.Math.toDegrees(cesiumViewer.camera.heading);
  boatEntity3d.billboard.rotation = -Cesium.Math.toRadians(boatHeadingDeg - camHeadingDeg);
}

// ============================================================
// STATE
// ============================================================
let trackData = null, trackStats = null;
let leafletLayers = [], boatMarker2d = null, trackBounds = null;
let boatEntity3d = null;
let currentView = '2d';
let followMode = false;
let hasFlownIn = false; // only auto-fly-in once per loaded track
let isPlaying = false, playbackTimer = null, currentIndex = 0, lastFrameTime = 0;
let playbackPos = 0; // fractional playback position (float index into points array)

let smoothLat = null, smoothLon = null, smoothHeading = null;

let targetMode = false, buoyMode = false;
let targetMarker2d = null, targetEntity3d = null;
let targetLat = null, targetLon = null;
let buoys = []; // in-memory only
let buoyMarkers2d = {};
let buoyEntities3d = {};
let buoyCounter = 0;

let sheetState = 'collapsed'; // 'collapsed' | 'peek' | 'full'

// ============================================================
// CAMERA HELPERS (chase cam + fly modes)
// ============================================================
function resetCameraLock() {
  if (cesiumViewer) {
    try { cesiumViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch (e) { /* noop */ }
  }
}

function flyInFromGlobe(durationSec) {
  if (!cesiumViewer || !cesiumReady) return;
  if (followMode && isPlaying) return; // chase camera is already driving every frame

  durationSec = durationSec || 3.0;
  resetCameraLock();

  let boundingSphere;
  if (trackData && trackData.points && trackData.points.length > 0) {
    const pts = trackData.displayPoints && trackData.displayPoints.length
      ? trackData.displayPoints : trackData.points;
    const positions = pts.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
    boundingSphere = Cesium.BoundingSphere.fromPoints(positions);
  } else {
    const c = leafletMap.getCenter();
    boundingSphere = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 0), 800);
  }

  const centerCarto = Cesium.Cartographic.fromCartesian(boundingSphere.center);
  const centerLon = Cesium.Math.toDegrees(centerCarto.longitude);
  const centerLat = Cesium.Math.toDegrees(centerCarto.latitude);

  cesiumViewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 15000000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });

  cesiumViewer.camera.flyToBoundingSphere(boundingSphere, {
    duration: durationSec,
    easingFunction: Cesium.EasingFunction.QUINTIC_IN_OUT,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0),
  });
}

function updateChaseCameraSmooth(pt, followDist) {
  if (!cesiumViewer) return;
  if (smoothLat === null) {
    smoothLat = pt.lat; smoothLon = pt.lon; smoothHeading = pt.heading;
  }
  const alpha = 0.08;
  smoothLat = lerp(smoothLat, pt.lat, alpha);
  smoothLon = lerp(smoothLon, pt.lon, alpha);
  smoothHeading = lerpAngle(smoothHeading, pt.heading, alpha);

  const pitchDeg = -25;
  cesiumViewer.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(smoothLon, smoothLat, 10),
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(smoothHeading),
      Cesium.Math.toRadians(pitchDeg),
      followDist
    )
  );
  updateBoatBillboardRotation();
}

function flyToChase(pt, followDist, duration) {
  if (!cesiumViewer) return;
  resetCameraLock();
  const heading = Cesium.Math.toRadians(pt.heading);
  const pitch = Cesium.Math.toRadians(-25);
  const offsetBearing = (pt.heading + 180) % 360;
  const offsetLat = pt.lat + (followDist / R_EARTH / DEG) * Math.cos(offsetBearing * DEG);
  const offsetLon = pt.lon + (followDist / R_EARTH / DEG / Math.cos(pt.lat * DEG)) * Math.sin(offsetBearing * DEG);
  const camHeight = 40 + followDist * 0.35;
  cesiumViewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(offsetLon, offsetLat, camHeight),
    orientation: { heading, pitch, roll: 0 },
    duration,
  });
  smoothLat = pt.lat; smoothLon = pt.lon; smoothHeading = pt.heading;
}

function flyToDefault(pt, duration) {
  if (!cesiumViewer) return;
  resetCameraLock();
  cesiumViewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 500),
    orientation: { heading: Cesium.Math.toRadians(pt.heading), pitch: Cesium.Math.toRadians(-35), roll: 0 },
    duration,
  });
}

function setFollowMode(active) {
  followMode = active;
  document.getElementById('btn-follow').classList.toggle('active', followMode);
  document.getElementById('nav-follow').classList.toggle('active', followMode);
  document.getElementById('camera-mode').style.display = followMode ? 'block' : 'none';
  if (followMode) {
    smoothLat = smoothLon = smoothHeading = null;
  } else {
    resetCameraLock();
  }
}

// ============================================================
// VIEW TOGGLE
// ============================================================
function updateViewIndicators(mode) {
  const other = mode === '2d' ? '3D' : '2D';
  const navLabel = document.getElementById('nav-view-label');
  if (navLabel) navLabel.textContent = other;

  const navView = document.getElementById('nav-view');
  if (navView) {
    navView.classList.toggle('view-tint-2d', mode === '2d');
    navView.classList.toggle('view-tint-3d', mode === '3d');
  }

  const toggle = document.getElementById('view-toggle');
  if (toggle) {
    toggle.classList.toggle('active-2d', mode === '2d');
    toggle.classList.toggle('active-3d', mode === '3d');
  }

  ['view-indicator-desktop', 'view-indicator-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = mode === '2d' ? '2D' : '3D';
    el.classList.toggle('mode-2d', mode === '2d');
    el.classList.toggle('mode-3d', mode === '3d');
  });
}

function setView(mode, opts) {
  opts = opts || {};
  currentView = mode;
  const el2d = document.getElementById('map-2d');
  const el3d = document.getElementById('globe-3d');
  const btn2d = document.getElementById('btn-2d');
  const btn3d = document.getElementById('btn-3d');

  if (mode === '2d') {
    resetCameraLock();
    el2d.classList.remove('hidden');
    el3d.classList.add('hidden');
    btn2d.classList.add('active');
    btn3d.classList.remove('active');
    setTimeout(() => leafletMap.invalidateSize(), 50);
  } else {
    if (!cesiumReady) initCesium();
    el3d.classList.remove('hidden');
    el2d.classList.add('hidden');
    btn3d.classList.add('active');
    btn2d.classList.remove('active');
    if (trackData) {
      const explicit = opts.explicit !== false;
      const wantFlyIn = cesiumReady && (explicit || !hasFlownIn);
      renderTrack3D({ autoFit: !wantFlyIn });
      if (wantFlyIn) {
        hasFlownIn = true;
        flyInFromGlobe(opts.flyDuration || 3.0);
      }
    }
    setupCesiumClickHandler();
    if (cesiumViewer) cesiumViewer.scene.requestRender();
  }

  updateViewIndicators(mode);
}

function triggerFlyInReplay(durationSec) {
  if (!trackData) return;
  if (currentView !== '3d') {
    setView('3d', { explicit: true, flyDuration: durationSec });
  } else {
    hasFlownIn = true;
    flyInFromGlobe(durationSec);
  }
}

// ============================================================
// CLEAR
// ============================================================
function clearTrack() {
  leafletLayers.forEach(l => leafletMap.removeLayer(l));
  leafletLayers = [];
  if (boatMarker2d) { leafletMap.removeLayer(boatMarker2d); boatMarker2d = null; }

  if (cesiumViewer) cesiumViewer.entities.removeAll();
  boatEntity3d = null;

  resetCameraLock();
  smoothLat = smoothLon = smoothHeading = null;
  hasFlownIn = false;

  trackData = null; trackStats = null; trackBounds = null;
  playbackPos = 0;
  stopPlayback();
  updateStatsPanel();
  document.getElementById('empty-state').style.display = 'block';
}

function clearBuoys() {
  Object.values(buoyMarkers2d).forEach(m => leafletMap.removeLayer(m));
  buoyMarkers2d = {};
  Object.values(buoyEntities3d).forEach(e => {
    if (cesiumViewer && cesiumViewer.entities.contains(e)) cesiumViewer.entities.remove(e);
  });
  buoyEntities3d = {};
  buoys = [];
  buoyCounter = 0;
}

function clearBuoyMarkers2d() {
  Object.values(buoyMarkers2d).forEach(m => leafletMap.removeLayer(m));
  buoyMarkers2d = {};
}

// ============================================================
// RENDER 2D — bucketed multi-point polylines instead of one Leaflet layer
// per segment (a 60 MB GPX can have hundreds of thousands of points).
// ============================================================
function metresPerPixel() {
  const lat = leafletMap.getCenter().lat;
  return 156543.03392 * Math.cos(lat * DEG) / Math.pow(2, leafletMap.getZoom());
}

const ZOOM_TOL_PIXELS = 0.4;
let zoomDisplayCache = { key: null, runs: null, tol: null, count: 0 };

// Points for the 2D line: contiguous runs inside the visible viewport, kept
// subpixel-accurate no matter how far you zoom in — see track-analysis.js
// for why plain whole-track simplification isn't enough here.
function runsForCurrentView() {
  if (!trackData) return [];
  const full = trackData.points;
  if (full.length <= 2) return [full];

  const z = leafletMap.getZoom();
  const b = leafletMap.getBounds().pad(0.35);
  const key = z + '|' + b.getSouth().toFixed(4) + ',' + b.getWest().toFixed(4)
                + ',' + b.getNorth().toFixed(4) + ',' + b.getEast().toFixed(4);
  if (zoomDisplayCache.key === key && zoomDisplayCache.runs) return zoomDisplayCache.runs;

  const tol = Math.min(25, Math.max(0.05, metresPerPixel() * ZOOM_TOL_PIXELS));
  const south = b.getSouth(), north = b.getNorth();
  const west = b.getWest(), east = b.getEast();

  const runs = [];
  let cur = null;
  for (let i = 0; i < full.length; i++) {
    const p = full[i];
    const inside = p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east;
    if (inside) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(full[i - 1]);
      }
      cur.push(p);
    } else if (cur) {
      cur.push(p);
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  function simplifyAll(t) {
    let total = 0;
    const out = [];
    for (const run of runs) {
      const s = run.length > 2 ? simplifyDouglasPeucker(run, t) : run;
      total += s.length;
      out.push(s);
    }
    return { runs: out, total: total };
  }

  let useTol = tol;
  let res = simplifyAll(useTol);
  let guard = 0;
  while (res.total > 150000 && guard++ < 6) {
    useTol *= 2;
    res = simplifyAll(useTol);
  }

  zoomDisplayCache = { key: key, runs: res.runs, tol: useTol, count: res.total };
  return res.runs;
}

function renderTrack2D() {
  leafletLayers.forEach(l => leafletMap.removeLayer(l));
  leafletLayers = [];
  if (boatMarker2d) { leafletMap.removeLayer(boatMarker2d); boatMarker2d = null; }
  clearBuoyMarkers2d();

  if (!trackData || !trackStats) return;

  const maxSpd = trackStats.maxSpeed;
  const fullPts = trackData.points;
  const viewRuns = runsForCurrentView();

  function addRun(runPoints) {
    if (runPoints.length < 2) return;
    const bucket = colorBucketOf(runPoints[runPoints.length - 1], maxSpd);
    const latlngs = runPoints.map(p => [p.lat, p.lon]);
    const seg = L.polyline(latlngs, {
      color: colorForSpeedBucket(bucket, maxSpd), weight: 4, opacity: 0.9,
      renderer: trackRenderer, smoothFactor: 0,
    });
    seg.on('mouseover', function(e) {
      const p = nearestPointTo(e.latlng, runPoints);
      L.popup().setLatLng(e.latlng).setContent(`<div class="point-info">
        <b>Speed:</b> <span class="val">${p.speedKn.toFixed(1)} kn</span> (${p.speedKmh.toFixed(1)} km/h)<br>
        <b>Heading:</b> <span class="val">${p.heading.toFixed(0)}°</span><br>
        <b>Dist:</b> <span class="val">${(p.totalDist/1000).toFixed(2)} km</span><br>
        ${p.time ? `<b>Time:</b> ${p.time.toLocaleTimeString()}` : ''}
      </div>`).openOn(leafletMap);
    });
    seg.on('click', function(e) {
      const p = nearestPointTo(e.latlng, runPoints);
      goToPoint(p.idx);
    });
    seg.addTo(leafletMap); leafletLayers.push(seg);
  }

  for (const pts of viewRuns) {
    if (pts.length < 2) continue;
    let runPoints = [pts[0], pts[1]];
    let runBucket = colorBucketOf(pts[1], maxSpd);
    for (let i = 2; i < pts.length; i++) {
      const b = colorBucketOf(pts[i], maxSpd);
      if (b === runBucket) {
        runPoints.push(pts[i]);
      } else {
        addRun(runPoints);
        runBucket = b;
        runPoints = [pts[i - 1], pts[i]];
      }
    }
    addRun(runPoints);
  }

  const s = L.circleMarker([fullPts[0].lat, fullPts[0].lon], {
    radius: 8, color: '#00ff88', fillColor: '#00ff88', fillOpacity: 0.9, weight: 2
  }).bindTooltip('Start', { permanent: true, direction: 'top', className: 'point-info' });
  s.addTo(leafletMap); leafletLayers.push(s);

  const e = L.circleMarker([fullPts[fullPts.length-1].lat, fullPts[fullPts.length-1].lon], {
    radius: 8, color: '#e94560', fillColor: '#e94560', fillOpacity: 0.9, weight: 2
  }).bindTooltip('Finish', { permanent: true, direction: 'top', className: 'point-info' });
  e.addTo(leafletMap); leafletLayers.push(e);

  boatMarker2d = L.marker([fullPts[0].lat, fullPts[0].lon], {
    icon: createBoatIcon(L, fullPts[0].heading), zIndexOffset: 1000
  }).addTo(leafletMap);
  leafletLayers.push(boatMarker2d);

  renderTarget2D();
  renderBuoys2D();

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < fullPts.length; i++) {
    const p = fullPts[i];
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  trackBounds = L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
  leafletMap.fitBounds(trackBounds, { padding: [30, 30] });
}

// ============================================================
// RENDER 3D
// ============================================================
function renderTrack3D(opts) {
  opts = opts || {};
  const autoFit = opts.autoFit !== false;
  if (!cesiumViewer || !trackData || !trackStats) return;

  cesiumViewer.entities.removeAll();
  boatEntity3d = null;
  buoyEntities3d = {};

  const fullPts = trackData.points;
  const pts = trackData.displayPoints || fullPts;
  const maxSpd = trackStats.maxSpeed;

  const batchSize = 20;
  for (let start = 0; start < pts.length - 1; start += batchSize) {
    const end = Math.min(start + batchSize, pts.length - 1);
    const midIdx = Math.floor((start + end) / 2);
    const mid = pts[midIdx];
    const color = speedColorCesium(
      (mid.speedSmooth !== undefined && mid.speedSmooth !== null) ? mid.speedSmooth : mid.speedKn,
      maxSpd);

    const positions = [];
    for (let i = start; i <= end; i++) {
      positions.push(Cesium.Cartesian3.fromDegrees(pts[i].lon, pts[i].lat, 2));
    }

    cesiumViewer.entities.add({
      polyline: { positions: positions, width: 4, material: color, clampToGround: false }
    });
  }

  cesiumViewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(fullPts[0].lon, fullPts[0].lat, 5),
    point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#00ff88'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
    label: { text: 'Start', font: '12px sans-serif', fillColor: Cesium.Color.WHITE,
             style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2,
             verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -12) }
  });

  cesiumViewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(fullPts[fullPts.length-1].lon, fullPts[fullPts.length-1].lat, 5),
    point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#e94560'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
    label: { text: 'Finish', font: '12px sans-serif', fillColor: Cesium.Color.WHITE,
             style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2,
             verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -12) }
  });

  boatEntity3d = cesiumViewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(fullPts[0].lon, fullPts[0].lat, 10),
    billboard: {
      image: boatCanvas3D, scale: 1.0, rotation: 0,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      sizeInMeters: false,
    },
    label: {
      text: `${fullPts[0].speedKn.toFixed(1)} kn`,
      font: 'bold 13px sans-serif', fillColor: Cesium.Color.WHITE,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      verticalOrigin: Cesium.VerticalOrigin.TOP, pixelOffset: new Cesium.Cartesian2(0, 22),
      showBackground: true, backgroundColor: new Cesium.Color(0.06, 0.08, 0.15, 0.85),
      backgroundPadding: new Cesium.Cartesian2(6, 4),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    }
  });

  renderTarget3D();
  renderBuoys3D();

  if (autoFit) {
    resetCameraLock();
    const positions = pts.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
    cesiumViewer.camera.flyToBoundingSphere(
      Cesium.BoundingSphere.fromPoints(positions),
      { duration: 1.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), 0) }
    );
  }
}

// ============================================================
// LOAD TRACK
// ============================================================
function loadTrack(data) {
  clearTrack();
  document.getElementById('empty-state').style.display = 'none';
  trackData = data;
  trackStats = analyzeTrack(data.points);
  assignSmoothedSpeed(data.points);
  trackData.displayPoints = buildDisplayPoints(data.points);
  zoomDisplayCache = { key: null, runs: null, tol: null, count: 0 };
  updateStatsPanel();
  drawSpeedChart();

  const slider = document.getElementById('slider');
  slider.max = data.points.length - 1;
  slider.value = 0;

  playbackPos = 0;
  smoothLat = smoothLon = smoothHeading = null;

  renderTrack2D();
  if (currentView === '3d' && cesiumReady) renderTrack3D();
  goToPoint(0, false);

  if (window.innerWidth < 900 && sheetState === 'collapsed') {
    setSheetState('peek');
  }
}

// ============================================================
// STATS PANEL
// ============================================================
function updateStatsPanel() {
  const mobileName = document.getElementById('mobile-track-name');
  if (!trackData || !trackStats) {
    ['track-name','stat-dist','stat-dur','stat-maxspd','stat-avgspd',
     'stat-maxspd-kmh','stat-avgspd-kmh','stat-points','stat-interval'].forEach(
      id => document.getElementById(id).textContent = '—');
    if (mobileName) mobileName.textContent = 'No track loaded';
    return;
  }
  const s = trackStats;
  document.getElementById('track-name').textContent = trackData.name;
  if (mobileName) mobileName.textContent = trackData.name;
  document.getElementById('stat-dist').textContent = (s.totalDist/1000).toFixed(2);
  document.getElementById('stat-dur').textContent = fmtDur(s.duration);
  document.getElementById('stat-maxspd').textContent = s.maxSpeed.toFixed(1);
  document.getElementById('stat-avgspd').textContent = s.avgSpeed.toFixed(1);
  document.getElementById('stat-maxspd-kmh').textContent = (s.maxSpeed/1.94384*3.6).toFixed(1);
  document.getElementById('stat-avgspd-kmh').textContent = (s.avgSpeed/1.94384*3.6).toFixed(1);
  const drawn = (zoomDisplayCache.count && currentView === '2d')
    ? zoomDisplayCache.count
    : (trackData.displayPoints ? trackData.displayPoints.length : s.pointCount);
  const tolTxt = (zoomDisplayCache.tol && currentView === '2d')
    ? ' · ±' + zoomDisplayCache.tol.toFixed(1) + ' m' : '';
  document.getElementById('stat-points').textContent = drawn < s.pointCount
    ? s.pointCount.toLocaleString() + ' (' + drawn.toLocaleString() + ' drawn' + tolTxt + ')'
    : s.pointCount.toLocaleString();
  document.getElementById('stat-interval').textContent = s.avgInterval;
  document.getElementById('legend-max').textContent = s.maxSpeed.toFixed(1) + ' kn';
}

// ============================================================
// SPEED CHART
// ============================================================
const SPEED_CHART_MAX_BARS = 2000;

function drawSpeedChart() {
  const canvas = document.getElementById('speed-chart');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width - 32; canvas.height = 100;
  if (!trackData || !trackStats) { ctx.clearRect(0,0,canvas.width,canvas.height); return; }
  const maxSpd = trackStats.maxSpeed;
  const pts = strideSubset(trackData.points, SPEED_CHART_MAX_BARS);
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const barW = Math.max(1, w/pts.length);
  for (let i = 0; i < pts.length; i++) {
    const spd = pts[i].speedKn;
    const barH = maxSpd > 0 ? (spd/maxSpd)*(h-4) : 0;
    ctx.fillStyle = speedColorCss(spd, maxSpd);
    ctx.fillRect((i/pts.length)*w, h-barH, barW+0.5, barH);
  }
  canvas.onclick = e => {
    const i = Math.floor((e.offsetX/w)*pts.length);
    if (i >= 0 && i < pts.length) goToPoint(pts[i].idx);
  };
}

// ============================================================
// TARGET MODE
// ============================================================
function setTargetMode(active) {
  targetMode = active;
  document.getElementById('btn-target').classList.toggle('active', active);
  document.getElementById('nav-target').classList.toggle('active', active);
  buoyMode = false;
  document.getElementById('btn-buoy').classList.toggle('active', false);
  document.getElementById('nav-buoy').classList.toggle('active', false);
}

function renderTarget2D() {
  if (targetMarker2d) {
    leafletMap.removeLayer(targetMarker2d);
    targetMarker2d = null;
  }
  if (targetLat !== null && targetLon !== null) {
    targetMarker2d = L.marker([targetLat, targetLon], {
      icon: L.icon({ iconUrl: targetIconDataUri, iconSize: [24, 24], iconAnchor: [12, 12] })
    }).bindTooltip('Target', { permanent: true, direction: 'top' }).addTo(leafletMap);
  }
}

function renderTarget3D() {
  if (targetEntity3d && cesiumViewer && cesiumViewer.entities.contains(targetEntity3d)) {
    cesiumViewer.entities.remove(targetEntity3d);
    targetEntity3d = null;
  }
  if (targetLat !== null && targetLon !== null && cesiumViewer) {
    targetEntity3d = cesiumViewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(targetLon, targetLat, 5),
      billboard: {
        image: targetIconDataUri, scale: 1.2,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { text: 'Target', font: '12px sans-serif', fillColor: Cesium.Color.WHITE,
               style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2,
               verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -16),
               disableDepthTestDistance: Number.POSITIVE_INFINITY }
    });
  }
}

function clearTarget() {
  targetLat = null;
  targetLon = null;
  renderTarget2D();
  if (cesiumReady) renderTarget3D();
  document.getElementById('vmg-section').style.display = 'none';
  document.getElementById('vmg-badge').style.display = 'none';
}

// ============================================================
// BUOY MODE
// ============================================================
function setBuoyMode(active) {
  buoyMode = active;
  document.getElementById('btn-buoy').classList.toggle('active', active);
  document.getElementById('nav-buoy').classList.toggle('active', active);
  targetMode = false;
  document.getElementById('btn-target').classList.toggle('active', false);
  document.getElementById('nav-target').classList.toggle('active', false);
}

function renameBuoy(id, name) {
  const b = buoys.find(x => x.id === id);
  if (!b) return;
  b.name = name || '';
  renderBuoys2D();
  if (cesiumReady) renderBuoys3D();
}

function openBuoyRenamePopup2D(b) {
  const container = document.createElement('div');
  container.className = 'point-info';
  const safeName = (b.name || '').replace(/"/g, '&quot;');
  container.innerHTML = `
    <div style="margin-bottom:6px;">Rename buoy ${b.num}:</div>
    <input type="text" value="${safeName}" placeholder="Name (e.g. Windward)"
           style="width:150px; padding:5px; border-radius:4px; border:1px solid var(--accent);
                  background:var(--bg); color:var(--text); font-family:inherit; font-size:0.9em;" />
    <button class="btn" style="margin-left:4px; padding:5px 10px; min-height:auto;">OK</button>
  `;
  const popup = L.popup({ closeButton: true, className: '' })
    .setLatLng([b.lat, b.lon])
    .setContent(container)
    .openOn(leafletMap);
  const input = container.querySelector('input');
  const button = container.querySelector('button');
  const commit = () => {
    renameBuoy(b.id, input.value.trim());
    leafletMap.closePopup(popup);
  };
  button.addEventListener('click', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
  setTimeout(() => input.focus(), 50);
}

function renderBuoys2D() {
  Object.values(buoyMarkers2d).forEach(m => leafletMap.removeLayer(m));
  buoyMarkers2d = {};
  buoys.forEach(b => {
    const marker = L.marker([b.lat, b.lon], {
      icon: createBuoyIcon(L, buoyDataUri3D)
    }).bindTooltip(b.name ? b.name : `Buoy ${b.num}`, { permanent: true, direction: 'top' }).addTo(leafletMap);
    marker.on('click', () => openBuoyRenamePopup2D(b));
    buoyMarkers2d[b.id] = marker;
  });
}

function renderBuoys3D() {
  Object.values(buoyEntities3d).forEach(e => {
    if (cesiumViewer && cesiumViewer.entities.contains(e)) cesiumViewer.entities.remove(e);
  });
  buoyEntities3d = {};
  if (!cesiumViewer) return;
  buoys.forEach(b => {
    const entity = cesiumViewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 5),
      billboard: {
        image: buoyDataUri3D, scale: 1.3,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { text: b.name ? b.name : `B${b.num}`, font: 'bold 12px sans-serif', fillColor: Cesium.Color.WHITE,
               style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2, outlineColor: Cesium.Color.BLACK,
               verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -34),
               disableDepthTestDistance: Number.POSITIVE_INFINITY }
    });
    buoyEntities3d[b.id] = entity;
  });
}

function addBuoy(lat, lon) {
  buoyCounter++;
  const buoy = { id: Date.now() + Math.random(), lat, lon, num: buoyCounter, name: '' };
  buoys.push(buoy);
  renderBuoys2D();
  if (cesiumReady) renderBuoys3D();
}

// ============================================================
// MARKS EXPORT / IMPORT
// ============================================================
function marksStatus(msg, isError) {
  const el = document.getElementById('marks-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#ff6b6b' : 'var(--text-dim)';
}

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function marksBaseName() {
  const raw = (trackData && trackData.name) ? trackData.name : 'marks';
  return raw.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'marks';
}

function exportMarks() {
  const data = {
    format: 'sailing-tracker-marks',
    version: 1,
    track: trackData ? trackData.name : null,
    exported: new Date().toISOString(),
    target: (targetLat !== null && targetLon !== null) ? { lat: targetLat, lon: targetLon } : null,
    buoys: buoys.map(b => ({ num: b.num, lat: b.lat, lon: b.lon, name: b.name || '' })),
  };
  downloadBlob(JSON.stringify(data, null, 2), 'application/json', marksBaseName() + '-marks.json');
  marksStatus(`Exported: ${buoys.length} buoy(s)${data.target ? ' + target' : ''}`);
}

function exportMarksGpx() {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const rows = buoys.map(b =>
    `  <wpt lat="${b.lat}" lon="${b.lon}"><name>${esc(b.name || ('Buoy ' + b.num))}</name><sym>Buoy</sym></wpt>`
  );
  if (targetLat !== null && targetLon !== null) {
    rows.push(`  <wpt lat="${targetLat}" lon="${targetLon}"><name>Target</name><sym>Diamond</sym></wpt>`);
  }
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sailing Tracker" xmlns="http://www.topografix.com/GPX/1/1">\n${rows.join('\n')}\n</gpx>\n`;
  downloadBlob(gpx, 'application/gpx+xml', marksBaseName() + '-marks.gpx');
  marksStatus(`GPX exported: ${buoys.length} buoy(s)`);
}

function importMarksFile(file) {
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      let data;
      try {
        data = JSON.parse(ev.target.result);
      } catch (e) {
        throw new Error('Not valid JSON');
      }
      if (!data || typeof data !== 'object' || data.format !== 'sailing-tracker-marks') {
        throw new Error('Invalid format (expected "sailing-tracker-marks")');
      }
      clearBuoys();
      clearTarget();

      if (data.target && typeof data.target.lat === 'number' && typeof data.target.lon === 'number') {
        targetLat = data.target.lat;
        targetLon = data.target.lon;
        renderTarget2D();
        if (cesiumReady) renderTarget3D();
        document.getElementById('vmg-section').style.display = 'block';
      }

      let importedBuoys = 0;
      if (Array.isArray(data.buoys)) {
        data.buoys.forEach(b => {
          if (b && typeof b.lat === 'number' && typeof b.lon === 'number') {
            buoyCounter++;
            buoys.push({
              id: Date.now() + Math.random(),
              lat: b.lat, lon: b.lon,
              num: (typeof b.num === 'number' ? b.num : buoyCounter),
              name: b.name || '',
            });
            importedBuoys++;
          }
        });
        renderBuoys2D();
        if (cesiumReady) renderBuoys3D();
      }

      updateDisplay(playbackPos, {});
      marksStatus(`${importedBuoys} buoy(s) imported${data.target ? ' + target' : ''}`);
    } catch (e) {
      marksStatus('Import error: ' + e.message, true);
    }
  };
  reader.onerror = () => marksStatus('Error reading the file', true);
  reader.readAsText(file);
}

// ============================================================
// UNIFIED DISPLAY UPDATE (used by both goToPoint & playback tick)
// ============================================================
function updateDisplay(pos, opts) {
  if (!trackData) return;
  opts = Object.assign({ playback: false, userAction: false }, opts || {});
  const pts = trackData.points;
  pos = Math.max(0, Math.min(pos, pts.length - 1));
  playbackPos = pos;
  currentIndex = Math.round(pos);
  const pt = pointAtFloatIndex(pts, pos);

  if (boatMarker2d) {
    boatMarker2d.setLatLng([pt.lat, pt.lon]);
    boatMarker2d.setIcon(createBoatIcon(L, pt.heading));
  }
  if (followMode && currentView === '2d') {
    leafletMap.setView([pt.lat, pt.lon], leafletMap.getZoom(), { animate: !opts.playback });
  }

  if (boatEntity3d && cesiumReady) {
    boatEntity3d.position = Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 8);
    boatHeadingDeg = pt.heading;
    updateBoatBillboardRotation();
    if (boatEntity3d.label) boatEntity3d.label.text = `${pt.speedKn.toFixed(1)} kn`;
  }

  if (currentView === '3d' && cesiumViewer && cesiumReady) {
    const followDist = parseInt(document.getElementById('follow-distance').value, 10);
    if (followMode) {
      if (opts.playback) {
        updateChaseCameraSmooth(pt, followDist);
      } else {
        flyToChase(pt, followDist, 0.3);
      }
    } else if (opts.userAction) {
      flyToDefault(pt, 1.0);
    }
  }

  document.getElementById('slider').value = pos;
  if (pt.time) document.getElementById('time-display').textContent = pt.time.toLocaleTimeString();

  const vmgBadge = document.getElementById('vmg-badge');
  let vmgHtml = '';
  if (targetLat !== null && targetLon !== null) {
    const vmgData = calculateVMG(pt.heading, pt.speedKn, targetLat, targetLon, pt.lat, pt.lon);
    if (vmgData) {
      const vmgClass = vmgData.vmg >= 0 ? 'positive' : 'negative';
      vmgHtml = `<div class="vmg-box ${vmgClass}" style="margin-top:8px;">
        <div class="label">VMG</div>
        <div><span class="value">${vmgData.vmg.toFixed(1)}</span><span class="unit">kn</span></div>
      </div>`;
      document.getElementById('vmg-section').style.display = 'block';
      document.getElementById('vmg-info').innerHTML = `
        <b>VMG:</b> ${vmgData.vmg.toFixed(1)} kn<br>
        <b>Target:</b> ${vmgData.bearing.toFixed(0)}°<br>
        <b>Angle:</b> ${vmgData.angleDiff.toFixed(0)}°
      `;

      vmgBadge.style.display = 'flex';
      vmgBadge.classList.toggle('positive', vmgData.vmg >= 0);
      vmgBadge.classList.toggle('negative', vmgData.vmg < 0);
      document.getElementById('vmg-badge-num').textContent = vmgData.vmg.toFixed(1);
      document.getElementById('vmg-badge-bearing').textContent = String(Math.round(vmgData.bearing)).padStart(3, '0') + '°';
      document.getElementById('vmg-badge-angle').textContent = Math.round(vmgData.angleDiff) + '°';
    }
  } else {
    vmgBadge.style.display = 'none';
  }

  document.getElementById('current-point').innerHTML = `
    <b>${pt.speedKn.toFixed(1)}</b> kn &nbsp;|&nbsp;
    <b>${pt.speedKmh.toFixed(1)}</b> km/h &nbsp;|&nbsp;
    ${pt.heading.toFixed(0)}° &nbsp;|&nbsp;
    ${(pt.totalDist/1000).toFixed(2)} km
    ${vmgHtml}`;

  highlightChart(pos);
}

function highlightChart(idx) {
  drawSpeedChart();
  if (!trackData) return;
  const canvas = document.getElementById('speed-chart');
  const ctx = canvas.getContext('2d');
  const x = (idx / trackData.points.length) * canvas.width;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x, canvas.height); ctx.stroke();
}

// ============================================================
// NAVIGATION
// ============================================================
function goToPoint(idx, userAction) {
  if (!trackData) return;
  if (userAction === undefined) userAction = true;
  stopPlayback();
  const pts = trackData.points;
  idx = Math.max(0, Math.min(idx, pts.length - 1));
  updateDisplay(idx, { playback: false, userAction: userAction });
}

// ============================================================
// PLAYBACK
// ============================================================
function togglePlayback() { isPlaying ? stopPlayback() : startPlayback(); }

function startPlayback() {
  if (!trackData) return;
  isPlaying = true;
  document.getElementById('btn-play').innerHTML = '&#9646;&#9646;';
  lastFrameTime = performance.now();
  if (followMode) { smoothLat = smoothLon = smoothHeading = null; }

  function tick(now) {
    if (!isPlaying || !trackData) return;
    const delta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    const speed = parseFloat(document.getElementById('playback-speed').value) || 1;
    const pts = trackData.points;

    const i0 = Math.floor(playbackPos);
    const i1 = Math.min(i0 + 1, pts.length - 1);
    let intervalSec = trackStats.avgInterval || 1;
    if (pts[i0] && pts[i0].time && pts[i1] && pts[i1].time && i1 !== i0) {
      const dt = (pts[i1].time - pts[i0].time) / 1000;
      if (dt > 0) intervalSec = dt;
    }

    const advance = (delta * speed) / Math.max(intervalSec, 0.05);
    playbackPos += advance;

    if (playbackPos >= pts.length - 1) {
      playbackPos = 0;
      smoothLat = smoothLon = smoothHeading = null;
    }

    updateDisplay(playbackPos, { playback: true, userAction: false });
    playbackTimer = requestAnimationFrame(tick);
  }
  playbackTimer = requestAnimationFrame(tick);
}

function stopPlayback() {
  isPlaying = false;
  document.getElementById('btn-play').innerHTML = '&#9654;';
  if (playbackTimer) { cancelAnimationFrame(playbackTimer); playbackTimer = null; }
}

// ============================================================
// FIT VIEW
// ============================================================
function fitView() {
  if (!trackData) return;
  if (currentView === '2d' && trackBounds) {
    leafletMap.fitBounds(trackBounds, { padding: [30,30] });
  } else if (currentView === '3d' && cesiumViewer) {
    resetCameraLock();
    const pts = trackData.displayPoints || trackData.points;
    const positions = pts.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
    cesiumViewer.camera.flyToBoundingSphere(
      Cesium.BoundingSphere.fromPoints(positions),
      { duration: 1.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), 0) }
    );
  }
}

// ============================================================
// MAP CLICK HANDLERS
// ============================================================
let zoomRedrawTimer = null;
function scheduleTrackRedraw() {
  if (!trackData || currentView !== '2d') return;
  if (zoomRedrawTimer) clearTimeout(zoomRedrawTimer);
  zoomRedrawTimer = setTimeout(() => {
    zoomRedrawTimer = null;
    renderTrack2D();
    updateStatsPanel();
    goToPoint(Math.round(playbackPos), false);
  }, 150);
}
leafletMap.on('zoomend', scheduleTrackRedraw);
leafletMap.on('moveend', scheduleTrackRedraw);

leafletMap.on('click', function(e) {
  if (targetMode) {
    targetLat = e.latlng.lat;
    targetLon = e.latlng.lng;
    renderTarget2D();
    if (cesiumReady) renderTarget3D();
    document.getElementById('vmg-section').style.display = 'block';
    updateDisplay(playbackPos, {});
  } else if (buoyMode) {
    addBuoy(e.latlng.lat, e.latlng.lng);
  }
});

let cesiumClickHandler = null;
function setupCesiumClickHandler() {
  if (!cesiumViewer || cesiumClickHandler) return;
  const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
  handler.setInputAction(function(click) {
    const pickedObject = Cesium.defaultValue(cesiumViewer.scene.pick(click.position), false);

    if (Cesium.defined(pickedObject) && pickedObject.id) {
      const match = Object.entries(buoyEntities3d).find(([, ent]) => ent === pickedObject.id);
      if (match) {
        const b = buoys.find(bb => String(bb.id) === match[0]);
        if (b) {
          const name = prompt('Name for buoy ' + b.num + ':', b.name || '');
          if (name !== null) renameBuoy(b.id, name.trim());
        }
        return;
      }
    }

    if (!Cesium.defined(pickedObject)) {
      const cartesian = cesiumViewer.camera.pickEllipsoid(click.position);
      if (Cesium.defined(cartesian)) {
        const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(cartographic.latitude);
        const lon = Cesium.Math.toDegrees(cartographic.longitude);
        if (targetMode) {
          targetLat = lat;
          targetLon = lon;
          renderTarget2D();
          renderTarget3D();
          document.getElementById('vmg-section').style.display = 'block';
          updateDisplay(playbackPos, {});
        } else if (buoyMode) {
          addBuoy(lat, lon);
        }
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  cesiumClickHandler = handler;
}

// ============================================================
// LOAD PROGRESS / ERROR OVERLAY
// ============================================================
let loadProgressErrorTimer = null;

function showLoadProgress(text) {
  const el = document.getElementById('load-progress');
  const txt = document.getElementById('load-progress-text');
  const bar = document.getElementById('load-progress-bar');
  if (loadProgressErrorTimer) { clearTimeout(loadProgressErrorTimer); loadProgressErrorTimer = null; }
  txt.classList.remove('error');
  txt.textContent = text || '';
  bar.classList.remove('indeterminate');
  bar.style.width = '0%';
  el.classList.add('visible');
}

function updateLoadProgress(text, pct) {
  const el = document.getElementById('load-progress');
  const txt = document.getElementById('load-progress-text');
  const bar = document.getElementById('load-progress-bar');
  if (!el.classList.contains('visible')) el.classList.add('visible');
  txt.classList.remove('error');
  if (text !== null && text !== undefined) txt.textContent = text;
  if (pct === null || pct === undefined) {
    bar.classList.add('indeterminate');
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
}

function hideLoadProgress() {
  document.getElementById('load-progress').classList.remove('visible');
}

function showLoadError(msg) {
  const el = document.getElementById('load-progress');
  const txt = document.getElementById('load-progress-text');
  const bar = document.getElementById('load-progress-bar');
  el.classList.add('visible');
  txt.classList.add('error');
  txt.textContent = msg;
  bar.classList.remove('indeterminate');
  bar.style.width = '0%';
  if (loadProgressErrorTimer) clearTimeout(loadProgressErrorTimer);
  loadProgressErrorTimer = setTimeout(() => { hideLoadProgress(); }, 6000);
}

function handleLoadError(e) {
  console.error('GPX load error:', e);
  const rawMsg = (e && e.message) || String(e);
  let msg;
  if (e && e.aborted) {
    msg = 'Loading canceled.';
  } else if (e instanceof RangeError || /out of memory|allocation failed|invalid string length/i.test(rawMsg)) {
    msg = 'Not enough memory for this file. Please use a smaller GPX file.';
  } else if (/no track points/i.test(rawMsg)) {
    msg = 'No track points found.';
  } else if (/valid lat\/lon/i.test(rawMsg)) {
    msg = 'All points had invalid lat/lon coordinates.';
  } else if (e && e.name === 'AbortError') {
    msg = 'Canceled (timeout).';
  } else {
    msg = 'Error loading: ' + rawMsg;
  }
  showLoadError(msg);
  libraryStatus(msg, true);
}

function readFileWithProgress(file, onProgress) {
  if (typeof file.text === 'function') {
    if (onProgress) onProgress(0, file.size);
    return file.text().then(text => {
      if (onProgress) onProgress(file.size, file.size);
      return text;
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total); };
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(reader.error || new Error('Error reading the file'));
    reader.onabort = () => { const err = new Error('Canceled'); err.aborted = true; reject(err); };
    reader.readAsText(file);
  });
}

async function confirmLargeFile(file) {
  const MB = 1024 * 1024;
  if (file.size > 150 * MB) {
    const mb = Math.round(file.size / MB);
    const ok = confirm(
      'This GPX file is about ' + mb + ' MB. Loading it can take a long time ' +
      'and may briefly slow down the browser.\n\nLoad anyway?'
    );
    if (!ok) {
      const err = new Error('Canceled');
      err.aborted = true;
      throw err;
    }
  }
}

async function loadGpxFile(file) {
  try {
    await confirmLargeFile(file);
    showLoadProgress('Reading file …');
    const text = await readFileWithProgress(file, (loaded, total) => {
      const pct = total ? (loaded / total) * 100 : null;
      updateLoadProgress('Reading file … ' + (total ? Math.round(pct) + '%' : ''), pct);
    });
    updateLoadProgress('Parsing …', null);
    const data = await parseGPX(text, count => {
      updateLoadProgress('Parsing … ' + count.toLocaleString() + ' points', null);
    });
    if (!data.points || data.points.length === 0) throw new Error('No track points found');
    updateLoadProgress('Drawing …', null);
    await new Promise(r => setTimeout(r, 0));
    loadTrack(data);
    hideLoadProgress();
    libraryStatus('✓ ' + data.points.length.toLocaleString() + ' points loaded');
  } catch (e) {
    handleLoadError(e);
  }
}

// ============================================================
// DRAG & DROP
// ============================================================
function showDropOverlay() { document.getElementById('drop-overlay').classList.add('active'); }
function hideDropOverlay() { document.getElementById('drop-overlay').classList.remove('active'); }

document.body.addEventListener('dragenter', e => { e.preventDefault(); showDropOverlay(); });
document.body.addEventListener('dragleave', e => { if (e.target === document.body) hideDropOverlay(); });
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  hideDropOverlay();
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.gpx')) {
    loadGpxFile(file);
  }
});

// ============================================================
// TRACK LIBRARY (Cloudflare R2, replaces v4's Firebase/Hazu integration)
// ============================================================
function libraryStatus(msg, isError) {
  const el = document.getElementById('library-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#ff6b6b' : 'var(--text-dim)';
}

async function loadLibraryTrack(key, label) {
  libraryStatus('Loading ' + (label || key) + ' …');
  showLoadProgress('Loading ' + (label || key) + ' …');
  try {
    const text = await fetchTrack(key);
    updateLoadProgress('Parsing …', null);
    const data = await parseGPX(text, count => {
      updateLoadProgress('Parsing … ' + count.toLocaleString() + ' points', null);
    });
    if (!data.points || data.points.length === 0) throw new Error('No track points in the file');
    if (label && (!data.name || data.name === 'Unnamed Track')) data.name = label;
    updateLoadProgress('Drawing …', null);
    await new Promise(r => setTimeout(r, 0));
    loadTrack(data);
    hideLoadProgress();
    libraryStatus('✓ ' + data.points.length.toLocaleString() + ' points loaded');
  } catch (e) {
    handleLoadError(e);
  }
}

document.getElementById('btn-load-tracks').addEventListener('click', async function() {
  libraryStatus('Loading track list …');
  const sel = document.getElementById('track-list');
  sel.innerHTML = '';
  sel.selectedIndex = -1;
  this.disabled = true;
  try {
    const tracks = await listTracks();
    if (tracks.length === 0) {
      sel.style.display = 'none';
      libraryStatus('No tracks in the library yet — upload one below.');
      return;
    }
    sel.innerHTML = '<option value="">— Choose a track —</option>' +
      tracks.map(t => `<option value="${t.key.replace(/"/g,'&quot;')}">${t.name}</option>`).join('');
    sel.selectedIndex = 0;
    sel.style.display = 'block';
    libraryStatus(tracks.length + (tracks.length === 1 ? ' track' : ' tracks') + ' found');
  } catch (e) {
    sel.style.display = 'none';
    libraryStatus('Could not load track list: ' + e.message, true);
  } finally {
    this.disabled = false;
  }
});

document.getElementById('track-list').addEventListener('change', function() {
  if (this.value) {
    loadLibraryTrack(this.value, this.options[this.selectedIndex].textContent);
  }
});

document.getElementById('track-upload-file').addEventListener('change', async function(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  libraryStatus('Uploading ' + file.name + ' …');
  try {
    await uploadTrack(file);
    libraryStatus('✓ Uploaded ' + file.name + ' — click "Load tracks" to refresh the list');
  } catch (err) {
    libraryStatus('Upload failed: ' + err.message, true);
  }
});

// Deep-linking: ?track=<key> loads a library track automatically.
(function handleUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('track');
  if (key) loadLibraryTrack(key);
})();

// ============================================================
// BOTTOM SHEET / SIDE PANEL STATE
// ============================================================
function setSheetState(state) {
  sheetState = state;
  const panel = document.getElementById('panel');
  panel.classList.remove('sheet-collapsed', 'sheet-peek', 'sheet-full');
  panel.classList.add('sheet-' + state);
  const navInfo = document.getElementById('nav-info');
  if (navInfo) navInfo.classList.toggle('active', state !== 'collapsed');
}

function togglePanel() {
  setSheetState(sheetState === 'collapsed' ? 'full' : 'collapsed');
}

function openSheetToVMG() {
  if (sheetState === 'collapsed') {
    setSheetState(window.innerWidth >= 900 ? 'full' : 'peek');
  }
  const scroll = document.getElementById('panel-scroll');
  if (scroll) scroll.scrollTop = 0;
}

(function setupSheetDrag() {
  const handle = document.getElementById('sheet-handle');
  const panel = document.getElementById('panel');
  let dragging = false, startY = 0, startHeightPx = 0;

  function heightForState(s) {
    const vh = window.innerHeight;
    if (s === 'full') return vh * 0.85;
    if (s === 'peek') return vh * 0.40;
    return 0;
  }

  handle.addEventListener('pointerdown', function(e) {
    if (window.innerWidth >= 900) return;
    dragging = true;
    startY = e.clientY;
    startHeightPx = heightForState(sheetState);
    panel.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });

  handle.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const h = Math.max(0, Math.min(window.innerHeight * 0.92, startHeightPx + dy));
    panel.style.height = h + 'px';
    panel.style.transform = 'translateY(0)';
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    const dy = startY - e.clientY;
    const h = Math.max(0, Math.min(window.innerHeight * 0.92, startHeightPx + dy));
    panel.style.transition = '';
    panel.style.height = '';
    panel.style.transform = '';
    const vh = window.innerHeight;
    let next;
    if (h < vh * 0.18) next = 'collapsed';
    else if (h < vh * 0.62) next = 'peek';
    else next = 'full';
    setSheetState(next);
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  let pointerDownAt = 0;
  handle.addEventListener('pointerdown', () => { pointerDownAt = Date.now(); });
  handle.addEventListener('click', function() {
    if (Date.now() - pointerDownAt > 350) return;
    if (window.innerWidth >= 900) { togglePanel(); return; }
    const order = ['collapsed', 'peek', 'full'];
    const next = order[(order.indexOf(sheetState) + 1) % order.length];
    setSheetState(next);
  });
})();

// ============================================================
// OVERFLOW MENU (mobile "⋯" grouped menu)
// ============================================================
function openOverflowMenu() {
  document.getElementById('overflow-menu').classList.add('open');
  document.getElementById('overflow-menu').setAttribute('aria-hidden', 'false');
  document.getElementById('overflow-scrim').classList.add('active');
}
function closeOverflowMenu() {
  document.getElementById('overflow-menu').classList.remove('open');
  document.getElementById('overflow-menu').setAttribute('aria-hidden', 'true');
  document.getElementById('overflow-scrim').classList.remove('active');
}

document.getElementById('btn-menu-toggle').addEventListener('click', openOverflowMenu);
document.getElementById('btn-menu-close').addEventListener('click', closeOverflowMenu);
document.getElementById('overflow-scrim').addEventListener('click', closeOverflowMenu);

document.getElementById('btn-library-menu').addEventListener('click', function() {
  closeOverflowMenu();
  setSheetState('full');
  setTimeout(() => {
    const el = document.getElementById('library-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 320);
});
document.getElementById('btn-export-marks-menu').addEventListener('click', function() { exportMarks(); closeOverflowMenu(); });
document.getElementById('btn-export-gpx-menu').addEventListener('click', function() { exportMarksGpx(); closeOverflowMenu(); });
document.getElementById('btn-fit-menu').addEventListener('click', function() { fitView(); closeOverflowMenu(); });
document.getElementById('btn-flyin-menu').addEventListener('click', function() { triggerFlyInReplay(3.5); closeOverflowMenu(); });
document.getElementById('btn-clear-buoys-menu').addEventListener('click', function() { clearBuoys(); closeOverflowMenu(); });
document.getElementById('btn-clear-target-menu').addEventListener('click', function() { clearTarget(); closeOverflowMenu(); });
document.getElementById('btn-clear-menu').addEventListener('click', function() { clearTrack(); closeOverflowMenu(); });

document.querySelectorAll('input[name="layer-radio-menu"]').forEach(r => {
  r.addEventListener('change', function() { if (this.checked) switchBaseLayer(this.value); });
});

document.getElementById('follow-distance').addEventListener('change', function() {
  document.getElementById('follow-distance-menu').value = this.value;
});
document.getElementById('follow-distance-menu').addEventListener('change', function() {
  document.getElementById('follow-distance').value = this.value;
});

// ============================================================
// MARKS EVENTS
// ============================================================
document.getElementById('btn-export-marks').addEventListener('click', exportMarks);
document.getElementById('btn-export-gpx').addEventListener('click', exportMarksGpx);
document.getElementById('marks-import-file').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (file) importMarksFile(file);
  e.target.value = '';
  closeOverflowMenu();
});

// ============================================================
// VMG BADGE CLICK -> open sheet to VMG section
// ============================================================
document.getElementById('vmg-badge').addEventListener('click', openSheetToVMG);

// ============================================================
// EVENTS
// ============================================================
document.getElementById('gpx-file').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  loadGpxFile(file);
  e.target.value = '';
  closeOverflowMenu();
});

document.getElementById('btn-2d').addEventListener('click', () => setView('2d'));
document.getElementById('btn-3d').addEventListener('click', () => {
  setView('3d');
  setTimeout(() => setupCesiumClickHandler(), 100);
});
document.getElementById('btn-fit').addEventListener('click', fitView);
document.getElementById('btn-flyin').addEventListener('click', function() { triggerFlyInReplay(3.5); });
document.getElementById('btn-clear').addEventListener('click', clearTrack);
document.getElementById('btn-clear-buoys').addEventListener('click', clearBuoys);
document.getElementById('btn-play').addEventListener('click', togglePlayback);

document.getElementById('btn-follow').addEventListener('click', function() { setFollowMode(!followMode); });
document.getElementById('btn-target').addEventListener('click', function() { setTargetMode(!targetMode); });
document.getElementById('btn-buoy').addEventListener('click', function() { setBuoyMode(!buoyMode); });
document.getElementById('btn-clear-target').addEventListener('click', clearTarget);

document.getElementById('btn-panel-toggle').addEventListener('click', togglePanel);
document.getElementById('panel-toggle-inner').addEventListener('click', togglePanel);

document.getElementById('nav-view').addEventListener('click', function() {
  setView(currentView === '2d' ? '3d' : '2d');
  if (currentView === '3d') setTimeout(() => setupCesiumClickHandler(), 100);
});
document.getElementById('nav-follow').addEventListener('click', function() { setFollowMode(!followMode); });
document.getElementById('nav-target').addEventListener('click', function() { setTargetMode(!targetMode); });
document.getElementById('nav-buoy').addEventListener('click', function() { setBuoyMode(!buoyMode); });
document.getElementById('nav-info').addEventListener('click', function() {
  setSheetState(sheetState === 'collapsed' ? 'peek' : 'collapsed');
});

document.getElementById('slider').addEventListener('input', function(e) {
  goToPoint(parseFloat(e.target.value));
});

window.addEventListener('keydown', function(e) {
  if (e.code === 'Escape' || e.key === 'Escape') { closeOverflowMenu(); }
  if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
  if (e.code === 'ArrowRight') { goToPoint(currentIndex+1); }
  if (e.code === 'ArrowLeft') { goToPoint(currentIndex-1); }
  if (e.code === 'KeyF') { setFollowMode(!followMode); }
});

window.addEventListener('resize', () => {
  if (trackData) drawSpeedChart();
  if (currentView === '2d') leafletMap.invalidateSize();
  if (window.innerWidth >= 900 && sheetState === 'collapsed') {
    setSheetState('full');
  }
});

// ============================================================
// INITIAL SHEET STATE — desktop shows the panel by default, mobile starts
// with the bottom sheet collapsed (app-like, map is the hero).
// ============================================================
setSheetState(window.innerWidth >= 900 ? 'full' : 'collapsed');
