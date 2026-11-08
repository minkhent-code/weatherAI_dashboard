import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, type ImageSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CityInfo, ForecastDataset, MapLayer } from '../types/forecast';
import { toBurmeseNumber, BURMESE_CITIES_MAP } from '../utils/burmese';
import { MYANMAR_CITIES } from '../data/myanmarCities';
import {
  fetchZarrField,
  fetchZarrMeta,
  sampleZarrField,
  ZARR_VAR_LABELS_MM,
  type ZarrField,
  type ZarrMeta,
} from '../services/zarrApi';
import { MYANMAR_BORDER_POINTS } from '../utils/geo';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';

interface ForecastMap2DProps {
  dataset: ForecastDataset;
  modelId: string;
  currentStepIndex: number;
  selectedCity: CityInfo;
  onSelectCity: (city: CityInfo) => void;
  activeLayer: MapLayer;
  onLayerChange: (layer: MapLayer) => void;
  showWindParticles: boolean;
  onToggleWindParticles: () => void;
}

/**
 * The basemap is global; clamp image overlays to Web Mercator's usable world.
 */
const DISPLAY_BOUNDS = {
  west: -180.0,
  south: -85.0,
  east: 180.0,
  north: 85.0,
};
/** Default / reset camera inside the display window (Myanmar / SE Asia + BoB) */
const STORM_FOCUS_BOUNDS: [[number, number], [number, number]] = [
  [78.0, -5.0],
  [130.0, 35.0],
];
/** Fallback viewport heat crop; city pins use a smaller Myanmar-only crop. */
const FALLBACK_BBOX = { ...DISPLAY_BOUNDS };
const CITY_PIN_BBOX = { west: 90.0, south: 8.0, east: 102.0, north: 28.0 };
/** Placeholder image corners before the first field arrives */
const BLANK_EXTENT = { ...DISPLAY_BOUNDS };
/** Keep the map usable at a whole-continent scale while allowing global panning. */
const MIN_ZOOM = 3.5;
const MAX_ZOOM = 12;
const EMPTY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const CMAPS: Record<string, [number, [number, number, number]][]> = {
  RdYlBu_r: [
    [0, [49, 54, 149]],
    [0.25, [116, 173, 209]],
    [0.5, [254, 224, 144]],
    [0.75, [244, 109, 67]],
    [1, [165, 0, 38]],
  ],
  YlGnBu: [
    [0, [255, 255, 217]],
    [0.25, [199, 233, 180]],
    [0.5, [65, 182, 196]],
    [0.75, [34, 94, 168]],
    [1, [8, 29, 88]],
  ],
  magma: [
    [0, [0, 0, 4]],
    [0.25, [80, 18, 123]],
    [0.5, [182, 54, 121]],
    [0.75, [251, 136, 97]],
    [1, [252, 253, 191]],
  ],
  inferno: [
    [0, [0, 0, 4]],
    [0.25, [87, 15, 109]],
    [0.5, [188, 55, 84]],
    [0.75, [249, 142, 9]],
    [1, [252, 255, 164]],
  ],
  plasma: [
    [0, [13, 8, 135]],
    [0.25, [126, 3, 168]],
    [0.5, [204, 71, 120]],
    [0.75, [248, 149, 64]],
    [1, [240, 249, 33]],
  ],
  RdBu_r: [
    [0, [5, 48, 97]],
    [0.25, [103, 169, 207]],
    [0.5, [247, 247, 247]],
    [0.75, [239, 138, 98]],
    [1, [103, 0, 31]],
  ],
  viridis: [
    [0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1, [253, 231, 37]],
  ],
};

function lerpColor(stops: [number, [number, number, number]][], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [p1, c1] = stops[i];
    const [p2, c2] = stops[i + 1];
    if (x >= p1 && x <= p2) {
      const f = (x - p1) / (p2 - p1 || 1);
      return [
        Math.round(c1[0] + f * (c2[0] - c1[0])),
        Math.round(c1[1] + f * (c2[1] - c1[1])),
        Math.round(c1[2] + f * (c2[2] - c1[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** Web Mercator usable latitude (MapLibre image overlays blow up at ±90) */
const MERCATOR_MAX_LAT = 85.05112878;

function clampExtent(ext: { west: number; east: number; north: number; south: number }) {
  // Lon in [-180, 180]; lat clamped to mercator range so image sources stay valid
  const west = Math.max(-180, Math.min(180, Math.min(ext.west, ext.east)));
  const east = Math.max(-180, Math.min(180, Math.max(ext.west, ext.east)));
  const north = Math.max(
    -MERCATOR_MAX_LAT,
    Math.min(MERCATOR_MAX_LAT, Math.max(ext.north, ext.south))
  );
  const south = Math.max(
    -MERCATOR_MAX_LAT,
    Math.min(MERCATOR_MAX_LAT, Math.min(ext.north, ext.south))
  );
  return { west, east, north, south };
}

function extentCoords(ext: { west: number; east: number; north: number; south: number }) {
  const e = clampExtent(ext);
  return [
    [e.west, e.north],
    [e.east, e.north],
    [e.east, e.south],
    [e.west, e.south],
  ] as [[number, number], [number, number], [number, number], [number, number]];
}

function quantizeBbox(b: { west: number; south: number; east: number; north: number }) {
  const q = (n: number) => Math.round(n * 2) / 2;
  return {
    west: q(b.west),
    south: q(b.south),
    east: q(b.east),
    north: q(b.north),
  };
}

function clampToDisplay(b: {
  west: number;
  south: number;
  east: number;
  north: number;
}) {
  return {
    west: Math.max(DISPLAY_BOUNDS.west, Math.min(DISPLAY_BOUNDS.east, b.west)),
    east: Math.max(DISPLAY_BOUNDS.west, Math.min(DISPLAY_BOUNDS.east, b.east)),
    south: Math.max(DISPLAY_BOUNDS.south, Math.min(DISPLAY_BOUNDS.north, b.south)),
    north: Math.max(DISPLAY_BOUNDS.south, Math.min(DISPLAY_BOUNDS.north, b.north)),
  };
}

function currentMapBbox(
  map: MapLibreMap,
  padRatio = 0.12
): { west: number; south: number; east: number; north: number } {
  const b = map.getBounds();
  let west = b.getWest();
  let east = b.getEast();
  let south = b.getSouth();
  let north = b.getNorth();
  // Outside / antimeridian → full display window
  if (east < west || east - west > 200) {
    return { ...FALLBACK_BBOX };
  }
  const latPad = (north - south) * padRatio;
  const lonPad = Math.max(0.5, (east - west) * padRatio);
  south -= latPad;
  north += latPad;
  west -= lonPad;
  east += lonPad;
  const clamped = clampToDisplay({ west, south, east, north });
  if (clamped.east <= clamped.west || clamped.north <= clamped.south) {
    return { ...FALLBACK_BBOX };
  }
  return quantizeBbox(clamped);
}

/** Clip outliers so tropical fields keep a visible blue→yellow→red ramp */
function stretchScale(values: number[][], vmin: number, vmax: number): [number, number] {
  const flat: number[] = [];
  for (const row of values) {
    for (const v of row) {
      if (Number.isFinite(v)) flat.push(v);
    }
  }
  if (flat.length < 20) return [vmin, vmax];
  flat.sort((a, b) => a - b);
  const lo = flat[Math.floor(flat.length * 0.05)];
  const hi = flat[Math.floor(flat.length * 0.95)];
  if (!(hi > lo)) return [vmin, vmax];
  return [lo, hi];
}

function latToMercY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

function mercYToLat(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** Outer edges of grid cells from cell-center axes (row0 = north, col0 = west). */
function extentFromAxes(lats: number[], lons: number[]) {
  if (lats.length < 2 || lons.length < 2) return null;
  const dlat = Math.abs(lats[0] - lats[1]);
  const dlon = Math.abs(lons[1] - lons[0]);
  const northFirst = lats[0] >= lats[lats.length - 1];
  const westFirst = lons[0] <= lons[lons.length - 1];
  const latNorth = northFirst ? lats[0] : lats[lats.length - 1];
  const latSouth = northFirst ? lats[lats.length - 1] : lats[0];
  const lonWest = westFirst ? lons[0] : lons[lons.length - 1];
  const lonEast = westFirst ? lons[lons.length - 1] : lons[0];
  return clampExtent({
    north: latNorth + dlat / 2,
    south: latSouth - dlat / 2,
    west: lonWest - dlon / 2,
    east: lonEast + dlon / 2,
  });
}

/** Bilinear sample on a regular north→south / west→east lat-lon grid */
function sampleGridBilinear(
  values: number[][],
  lats: number[],
  lons: number[],
  lat: number,
  lon: number,
  dlat: number,
  dlon: number
): number | null {
  if (!values.length || !lats.length || !lons.length || dlat <= 0 || dlon <= 0) return null;
  const rf = (lats[0] - lat) / dlat;
  const cf = (lon - lons[0]) / dlon;
  const r0 = Math.max(0, Math.min(lats.length - 1, Math.floor(rf)));
  const c0 = Math.max(0, Math.min(lons.length - 1, Math.floor(cf)));
  const r1 = Math.max(0, Math.min(lats.length - 1, r0 + 1));
  const c1 = Math.max(0, Math.min(lons.length - 1, c0 + 1));
  const fr = Math.max(0, Math.min(1, rf - r0));
  const fc = Math.max(0, Math.min(1, cf - c0));
  const v00 = values[r0]?.[c0];
  const v01 = values[r0]?.[c1];
  const v10 = values[r1]?.[c0];
  const v11 = values[r1]?.[c1];
  if ([v00, v01, v10, v11].some((v) => v == null || Number.isNaN(v))) {
    const v = values[Math.round(Math.max(0, Math.min(lats.length - 1, rf)))]?.[
      Math.round(Math.max(0, Math.min(lons.length - 1, cf)))
    ];
    return v == null || Number.isNaN(v) ? null : v;
  }
  const top = (v00 as number) * (1 - fc) + (v01 as number) * fc;
  const bot = (v10 as number) * (1 - fc) + (v11 as number) * fc;
  return top * (1 - fr) + bot * fr;
}

/**
 * Paint heat in Web-Mercator row spacing so MapLibre's image quad
 * (linear in mercator) lines up with coastlines / borders.
 */
function buildHeatmapDataUrl(
  values: number[][],
  cmapName: string,
  vmin: number,
  vmax: number,
  lats?: number[],
  lons?: number[],
  extent?: { west: number; east: number; north: number; south: number }
): string {
  const srcRows = values.length;
  const srcCols = values[0]?.length || 0;
  if (!srcRows || !srcCols) return EMPTY_PNG;

  const cmap = CMAPS[cmapName] || CMAPS.RdYlBu_r;
  const span = Math.max(1e-6, vmax - vmin);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return EMPTY_PNG;

  const useMercator =
    !!extent &&
    Array.isArray(lats) &&
    Array.isArray(lons) &&
    lats.length === srcRows &&
    lons.length === srcCols &&
    lats.length > 1 &&
    lons.length > 1;

  if (useMercator && extent && lats && lons) {
    // Normalize axes: north→south rows, west→east cols
    let grid = values;
    let latAxis = lats;
    let lonAxis = lons;
    if (latAxis[0] < latAxis[latAxis.length - 1]) {
      grid = [...grid].reverse();
      latAxis = [...latAxis].reverse();
    }
    if (lonAxis[0] > lonAxis[lonAxis.length - 1]) {
      grid = grid.map((row) => [...row].reverse());
      lonAxis = [...lonAxis].reverse();
    }

    const outW = Math.min(1024, Math.max(srcCols, Math.round(srcCols * 1.25)));
    const outH = Math.min(1024, Math.max(srcRows, Math.round(srcRows * 1.25)));
    canvas.width = outW;
    canvas.height = outH;
    const img = ctx.createImageData(outW, outH);
    const data = img.data;

    // mercY increases with latitude → yNorth > ySouth. Row 0 (image top) = north.
    const yNorth = latToMercY(extent.north);
    const ySouth = latToMercY(extent.south);
    const lonSpan = extent.east - extent.west;
    const dlat = Math.abs(latAxis[0] - latAxis[1]);
    const dlon = Math.abs(lonAxis[1] - lonAxis[0]);

    let i = 0;
    for (let r = 0; r < outH; r++) {
      const vv = (r + 0.5) / outH;
      const mercY = yNorth + vv * (ySouth - yNorth);
      const lat = mercYToLat(mercY);
      for (let c = 0; c < outW; c++) {
        const u = (c + 0.5) / outW;
        const lon = extent.west + u * lonSpan;
        const val = sampleGridBilinear(grid, latAxis, lonAxis, lat, lon, dlat, dlon);
        if (val == null) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 0;
        } else {
          const t = (val - vmin) / span;
          const [cr, cg, cb] = lerpColor(cmap, t);
          data[i] = cr;
          data[i + 1] = cg;
          data[i + 2] = cb;
          data[i + 3] = 220;
        }
        i += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
    // PNG keeps alpha so ocean gaps stay clear if any
    return canvas.toDataURL('image/png');
  }

  // Fallback: equirectangular paint (slight N–S drift on mercator basemap)
  canvas.width = srcCols;
  canvas.height = srcRows;
  const img = ctx.createImageData(srcCols, srcRows);
  const data = img.data;
  let i = 0;
  for (let r = 0; r < srcRows; r++) {
    const row = values[r];
    for (let c = 0; c < srcCols; c++) {
      const t = (row[c] - vmin) / span;
      const [cr, cg, cb] = lerpColor(cmap, t);
      data[i] = cr;
      data[i + 1] = cg;
      data[i + 2] = cb;
      data[i + 3] = 220;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function barGradient(cmapName: string): string {
  const stops = CMAPS[cmapName] || CMAPS.RdYlBu_r;
  return `linear-gradient(90deg, ${stops
    .map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`)
    .join(', ')})`;
}

function satelliteStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: 'esri-satellite',
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Tiles © Esri',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-opacity': 1 },
      },
    ],
  };
}

function buildCityPinEl(
  city: CityInfo,
  selected: boolean,
  tempC: number | null,
  modelLabel: string,
  onClick: () => void
): HTMLDivElement {
  const mm = BURMESE_CITIES_MAP[city.name]?.mmName || city.mmName || city.name;
  const tempLabel =
    tempC != null ? `${toBurmeseNumber(Math.round(tempC))}°C` : '—';
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;';
  root.title = `${city.name} · ${tempC != null ? `${tempC.toFixed(1)} °C` : 'n/a'} (${modelLabel} t2m)`;
  root.innerHTML = `
    <div style="
      width:${selected ? 14 : 11}px;height:${selected ? 14 : 11}px;border-radius:999px;
      background:#fff;border:2px solid ${selected ? '#10b981' : '#0f172a'};
      box-shadow:0 0 0 4px rgba(52,211,153,0.28);margin-bottom:3px;
    "></div>
    <div style="
      font-family:'Noto Sans Myanmar',system-ui,sans-serif;font-size:11px;font-weight:700;
      color:#fff;background:rgba(15,23,42,0.92);border:1px solid rgba(255,255,255,0.18);
      border-radius:999px;padding:2px 8px;white-space:nowrap;line-height:1.35;
      box-shadow:0 4px 14px rgba(0,0,0,0.35);
    ">${mm} <span style="color:#6ee7b7;font-variant-numeric:tabular-nums">${tempLabel}</span></div>
  `;
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return root;
}

export const ForecastMap2D: React.FC<ForecastMap2DProps> = ({
  dataset,
  modelId,
  currentStepIndex,
  selectedCity,
  onSelectCity,
  onLayerChange,
}) => {
  const mapHostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const fieldReadyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tempAbortRef = useRef<AbortController | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const viewportTimerRef = useRef<number | null>(null);
  const lastBboxKeyRef = useRef<string>('');
  const loadFieldRef = useRef<() => void>(() => undefined);

  const [meta, setMeta] = useState<ZarrMeta | null>(null);
  const [variable, setVariable] = useState('t2m');
  const [field, setField] = useState<ZarrField | null>(null);
  /** Selected-model near-surface temperature used for city pin labels */
  const [tempField, setTempField] = useState<ZarrField | null>(null);
  const [opacity, setOpacity] = useState(0.72);
  const [showBorders, setShowBorders] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; text: string } | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const leadHour = dataset.leadHours[currentStepIndex] ?? meta?.lead_hours?.[currentStepIndex] ?? 0;

  const availableVars = useMemo(
    () => meta?.available_variables || [],
    [meta]
  );
  const pinTemperatureVariable = availableVars.includes('t2m')
    ? 't2m'
    : availableVars.find((id) => id.startsWith('t')) || '';

  // Load metadata for the selected local model.
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current?.abort();
    tempAbortRef.current?.abort();
    lastBboxKeyRef.current = '';
    clearOverlay();
    setMeta(null);
    setField(null);
    setTempField(null);
    setError(null);
    fetchZarrMeta(modelId, ac.signal)
      .then((m) => {
        setMeta(m);
        const first = m.available_variables.includes('t2m')
          ? 't2m'
          : m.available_variables[0] || 't2m';
        setVariable(first);
        setError(null);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setError(String(e.message || e));
      });
    return () => ac.abort();
  }, [modelId]);

  // Create map
  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapHostRef.current,
      style: satelliteStyle(),
      center: [100.0, 22.0],
      zoom: 4.2,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      dragPan: true,
      scrollZoom: true,
      boxZoom: true,
      doubleClickZoom: true,
      keyboard: true,
      touchZoomRotate: true,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('load', async () => {
      fieldReadyRef.current = true;
      // Dual image sources (a/b) — usually only "a" is used for regional crops
      const blank = extentCoords(BLANK_EXTENT);
      for (const id of ['field-a', 'field-b']) {
        map.addSource(id, { type: 'image', url: EMPTY_PNG, coordinates: blank });
        map.addLayer({
          id: `${id}-layer`,
          type: 'raster',
          source: id,
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
          },
          layout: { visibility: 'none' },
        });
      }

      map.addSource('myanmar-border', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: MYANMAR_BORDER_POINTS },
        },
      });
      map.addLayer({
        id: 'myanmar-border-glow',
        type: 'line',
        source: 'myanmar-border',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#34d399',
          'line-width': 5,
          'line-opacity': 0.2,
          'line-blur': 2,
        },
      });
      map.addLayer({
        id: 'myanmar-border-dots',
        type: 'line',
        source: 'myanmar-border',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#a7f3d0',
          'line-width': 2.4,
          'line-opacity': 0.85,
          'line-dasharray': [0.55, 2],
        },
      });

      map.fitBounds(STORM_FOCUS_BOUNDS, {
        padding: { top: 88, bottom: 120, left: 40, right: 72 },
        duration: 0,
        maxZoom: 5.2,
      });
      map.resize();
      setMapReady(true);
    });

    const onWinResize = () => map.resize();
    window.addEventListener('resize', onWinResize);
    let borderPulse = 0;
    const borderPulseTimer = window.setInterval(() => {
      borderPulse = (borderPulse + 1) % 4;
      const opacity = [0.62, 0.82, 1, 0.82][borderPulse];
      if (map.getLayer('myanmar-border-dots')) {
        map.setPaintProperty('myanmar-border-dots', 'line-opacity', opacity);
      }
      if (map.getLayer('myanmar-border-glow')) {
        map.setPaintProperty('myanmar-border-glow', 'line-opacity', opacity * 0.22);
      }
    }, 260);

    map.on('mousemove', (e) => {
      const lat = e.lngLat.lat;
      const lon = e.lngLat.lng;
      const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
      const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
      const f = (map as any).__lastField as ZarrField | undefined;
      const val = f ? sampleZarrField(f, lat, lon) : null;
      const valueLine =
        f && val != null
          ? `${f.label || f.variable}: ${val.toFixed(1)} ${f.unit}`
          : f
            ? `${f.label || f.variable}: —`
            : null;
      setProbe({
        x: e.point.x,
        y: e.point.y,
        text: valueLine ? `${valueLine}\n${latStr}, ${lonStr}` : `${latStr}, ${lonStr}`,
      });
    });
    map.on('mouseout', () => setProbe(null));

    const scheduleViewportRefresh = () => {
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        loadFieldRef.current();
      }, 450);
    };
    map.on('moveend', scheduleViewportRefresh);
    map.on('zoomend', scheduleViewportRefresh);

    return () => {
      window.removeEventListener('resize', onWinResize);
      window.clearInterval(borderPulseTimer);
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      map.off('moveend', scheduleViewportRefresh);
      map.off('zoomend', scheduleViewportRefresh);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      fieldReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const id of ['field-a-layer', 'field-b-layer']) {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, 'raster-opacity', opacity);
      }
    }
  }, [opacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = showBorders ? 'visible' : 'none';
    for (const id of ['myanmar-border-dots', 'myanmar-border-glow']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showBorders]);

  const applyOverlay = (next: ZarrField) => {
    const map = mapRef.current;
    if (!map || !fieldReadyRef.current) return;
    (map as any).__lastField = next;

    const parts =
      Array.isArray(next.parts) && next.parts.length
        ? next.parts
        : [
            {
              id: 'a',
              values: next.values,
              lats: next.lats,
              lons: next.lons,
              geo_extent: next.geo_extent || {
                west: Math.min(next.lons[0], next.lons[next.lons.length - 1]),
                east: Math.max(next.lons[0], next.lons[next.lons.length - 1]),
                north: Math.max(next.lats[0], next.lats[next.lats.length - 1]),
                south: Math.min(next.lats[0], next.lats[next.lats.length - 1]),
              },
            },
          ];

    // Shared display scale from all drawable parts (percentile-stretched)
    let displayVmin = next.vmin;
    let displayVmax = next.vmax;
    const primary = parts.find((p) => p.values?.length);
    if (primary?.values?.length) {
      [displayVmin, displayVmax] = stretchScale(primary.values, next.vmin, next.vmax);
    }
    setField({ ...next, vmin: displayVmin, vmax: displayVmax });

    const byId = Object.fromEntries(parts.map((p) => [p.id || 'a', p]));
    for (const id of ['a', 'b'] as const) {
      const srcId = `field-${id}`;
      const part = byId[id];
      const src = map.getSource(srcId) as ImageSource | undefined;
      if (!src) continue;
      if (!part?.values?.length) {
        src.updateImage({
          url: EMPTY_PNG,
          coordinates: extentCoords({ west: 0, east: 1, north: 1, south: 0 }),
        });
        if (map.getLayer(`${srcId}-layer`)) {
          map.setLayoutProperty(`${srcId}-layer`, 'visibility', 'none');
        }
        continue;
      }
      // Prefer extent from the part's own lat/lon centers (avoids stale/padded mismatch)
      const aligned =
        (part.lats && part.lons ? extentFromAxes(part.lats, part.lons) : null) ??
        clampExtent(part.geo_extent ?? BLANK_EXTENT);
      const url = buildHeatmapDataUrl(
        part.values,
        next.cmap,
        displayVmin,
        displayVmax,
        part.lats,
        part.lons,
        aligned
      );
      const coords = extentCoords(aligned);
      try {
        const updated = src.updateImage({ url, coordinates: coords });
        // MapLibre may abort a prior in-flight updateImage; ignore that race
        Promise.resolve(updated).catch((err: unknown) => {
          const name = (err as { name?: string })?.name;
          if (name !== 'AbortError') console.warn(`heat overlay ${srcId} failed`, err, aligned);
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name !== 'AbortError') {
          console.warn(`heat overlay ${srcId} failed`, err, aligned);
          throw err;
        }
      }
      if (map.getLayer(`${srcId}-layer`)) {
        map.setLayoutProperty(`${srcId}-layer`, 'visibility', 'visible');
        map.setPaintProperty(`${srcId}-layer`, 'raster-opacity', opacity);
      }
    }
  };

  const clearOverlay = () => {
    const map = mapRef.current;
    if (map) {
      delete (map as MapLibreMap & { __lastField?: ZarrField }).__lastField;
      for (const id of ['field-a-layer', 'field-b-layer']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    }
    setField(null);
  };

  const loadField = () => {
    const map = mapRef.current;
    if (!meta || !fieldReadyRef.current || !map) return;

    // Crop to the current viewport (+ pad) so heat stays under the camera while panning/zooming
    const bbox = currentMapBbox(map);
    const bboxKey = `${variable}|${leadHour}|${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    if (bboxKey === lastBboxKeyRef.current) return;

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const reqLead = leadHour;
    const reqVar = variable;

    fetchZarrField({
      modelId,
      variable: reqVar,
      leadHour: reqLead,
      ensemble: 'mean',
      bbox,
      signal: ac.signal,
    })
      .then((f) => {
        if (ac.signal.aborted) return;
        try {
          applyOverlay(f);
          lastBboxKeyRef.current = bboxKey;
          if (reqVar === pinTemperatureVariable) setTempField(f);
          setError(null);
          onLayerChange(
            reqVar.startsWith('u') || reqVar.startsWith('v') || reqVar.startsWith('wind')
              ? 'wind'
              : 'temperature'
          );
        } catch (err) {
          console.warn('applyOverlay failed', err);
          setError(String((err as Error)?.message || err));
        }
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setError(String(e.message || e));
      });
  };

  loadFieldRef.current = loadField;

  /** Fetch t2m separately so city pins retain temperatures on other layers. */
  const loadTempForPins = () => {
    if (!meta || !fieldReadyRef.current) return;
    if (!pinTemperatureVariable || variable === pinTemperatureVariable) return;
    if (tempAbortRef.current) tempAbortRef.current.abort();
    const ac = new AbortController();
    tempAbortRef.current = ac;
    fetchZarrField({
      modelId,
      variable: pinTemperatureVariable,
      leadHour,
      ensemble: 'mean',
      bbox: CITY_PIN_BBOX,
      signal: ac.signal,
    })
      .then((f) => setTempField(f))
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        console.warn('City pin temperature field failed', e);
      });
  };

  useEffect(() => {
    if (!meta || !mapReady || !fieldReadyRef.current) return;
    // Force reload when variable / lead changes (ignore bbox cache key)
    abortRef.current?.abort();
    lastBboxKeyRef.current = '';
    // Debounce while timeline is scrubbing/playing so every step isn't cancelled mid-flight
    const t = window.setTimeout(() => {
      loadField();
      loadTempForPins();
    }, 120);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, variable, leadHour, mapReady]);

  // HTML markers: Burmese name + °C sampled from the selected model's t2m field.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    for (const city of MYANMAR_CITIES) {
      const tempC = tempField ? sampleZarrField(tempField, city.lat, city.lon) : null;
      const el = buildCityPinEl(city, city.name === selectedCity.name, tempC, meta?.model_label ?? modelId, () =>
        onSelectCity(city)
      );
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([city.lon, city.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
  }, [selectedCity.name, tempField, mapReady, onSelectCity, modelId, meta?.model_label]);

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, map.getZoom() + delta));
    map.zoomTo(next, { duration: 250 });
  };

  const resetView = () => {
    mapRef.current?.fitBounds(STORM_FOCUS_BOUNDS, {
      padding: { top: 88, bottom: 120, left: 40, right: 72 },
      duration: 700,
      maxZoom: 5.2,
      minZoom: MIN_ZOOM,
    });
  };

  const enterFs = () => {
    mapHostRef.current?.parentElement?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#030712]">
      {/* Outer box owns the size. MapLibre sets position:relative on its
          container, which would collapse an absolute inset-0 host to 0 height. */}
      <div className="absolute inset-0">
        <div ref={mapHostRef} className="h-full w-full" />
      </div>

      {/* Variable chips — larger model catalogs scroll without switching controls. */}
      <div
        aria-label="Forecast parameters"
        className={`pointer-events-auto absolute left-3 right-3 top-[4.5rem] z-20 flex flex-wrap gap-1.5 sm:left-4 sm:right-auto sm:max-w-[min(100%,42rem)] ${
          availableVars.length > 12
            ? 'max-h-[35vh] overflow-y-auto rounded-xl border border-white/10 bg-black/55 p-2 backdrop-blur-xl'
            : ''
        }`}
      >
        {availableVars.map((id) => {
          const active = variable === id;
          const label = ZARR_VAR_LABELS_MM[id] || meta?.variables?.[id]?.label_mm || meta?.variables?.[id]?.label || id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setVariable(id)}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold backdrop-blur-xl transition sm:text-[11px] ${
                active
                  ? 'border-emerald-400/50 bg-emerald-500/25 text-emerald-100'
                  : 'border-white/15 bg-black/55 text-slate-200 hover:bg-white/10'
              }`}
              title={meta?.variables?.[id]?.label || id}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowBorders((v) => !v)}
          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold backdrop-blur-xl sm:text-[11px] ${
            showBorders
              ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100'
              : 'border-white/15 bg-black/55 text-slate-300'
          }`}
        >
          နယ်နိမိတ် {showBorders ? 'ဖွင့်' : 'ပိတ်'}
        </button>
      </div>

      {/* Zoom stack */}
      <div className="absolute right-3 top-28 z-20 flex flex-col gap-1.5 sm:right-4">
        <button
          type="button"
          onClick={() => zoomBy(0.8)}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/60 text-white backdrop-blur-xl hover:bg-white/10"
          title="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(-0.8)}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/60 text-white backdrop-blur-xl hover:bg-white/10"
          title="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/60 text-white backdrop-blur-xl hover:bg-white/10"
          title="SE Asia + Bay of Bengal"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={enterFs}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/60 text-white backdrop-blur-xl hover:bg-white/10"
          title="Fullscreen"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>

      {/* Opacity + colorbar */}
      <div className="absolute bottom-28 right-3 z-20 flex w-44 flex-col gap-2 sm:right-4 sm:w-52">
        <label className="rounded-xl border border-white/10 bg-black/65 px-2.5 py-1.5 text-[10px] text-slate-300 backdrop-blur-xl">
          Heat opacity
          <input
            type="range"
            min={0.15}
            max={0.95}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="mt-1 w-full"
          />
        </label>
        {field && (
          <div className="rounded-xl border border-white/10 bg-black/65 px-2.5 py-1.5 text-[10px] text-slate-200 backdrop-blur-xl">
            <div className="mb-1 flex justify-between font-mono">
              <span>
                {field.vmin.toFixed(1)} {field.unit}
              </span>
              <span>
                {field.vmax.toFixed(1)} {field.unit}
              </span>
            </div>
            <div className="h-2 w-full rounded-full" style={{ background: barGradient(field.cmap) }} />
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-black/65 px-2.5 py-1.5 text-[10px] text-rose-300 backdrop-blur-xl">
            {error}
          </div>
        )}
      </div>

      {probe && (
        <div
          className="pointer-events-none absolute z-30 whitespace-pre-line rounded-md border border-white/20 bg-black/80 px-2 py-1.5 text-[11px] font-mono leading-snug text-white"
          style={{ left: probe.x + 12, top: probe.y + 12 }}
        >
          {probe.text}
        </div>
      )}

      {/* City quick chips — all 15 state/region capitals */}
      <div className="pointer-events-auto absolute bottom-[7.5rem] left-1/2 z-20 hidden max-w-[92vw] -translate-x-1/2 gap-1 overflow-x-auto md:flex">
        {MYANMAR_CITIES.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => {
              onSelectCity(c);
              const lat = Math.max(DISPLAY_BOUNDS.south, Math.min(DISPLAY_BOUNDS.north, c.lat));
              const lon = Math.max(DISPLAY_BOUNDS.west, Math.min(DISPLAY_BOUNDS.east, c.lon));
              mapRef.current?.flyTo({ center: [lon, lat], zoom: 6.2, duration: 700 });
            }}
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold backdrop-blur-xl ${
              selectedCity.name === c.name
                ? 'border-emerald-400/50 bg-emerald-500/25 text-emerald-100'
                : 'border-white/15 bg-black/55 text-slate-200'
            }`}
          >
            {BURMESE_CITIES_MAP[c.name]?.mmName || c.mmName || c.name}
          </button>
        ))}
      </div>
    </div>
  );
};
