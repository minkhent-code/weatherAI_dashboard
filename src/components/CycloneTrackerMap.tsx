import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './CycloneTrackerMap.css';
import {
  fetchCycloneTracks,
  fetchHistoricalCyclone,
  fetchZarrMeta,
  type CycloneTrack,
  type CycloneTrackPoint,
  type CycloneTracks,
  type ZarrMeta,
} from '../services/zarrApi';

interface CycloneTrackerMapProps {
  modelId: string;
  currentStepIndex: number;
  onSelectStepIndex: (index: number) => void;
  onForecastLoaded: (forecast: CycloneTracks) => void;
  isPlaying: boolean;
  playbackSpeed: number;
}

const EMPTY_FEATURES: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

function cycloneStyle(): maplibregl.StyleSpecification {
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

function lineSegments(points: CycloneTrackPoint[]): number[][][] {
  const segments: number[][][] = [];
  let segment: number[][] = [];
  for (const point of points) {
    const coordinate = [point.lon > 180 ? point.lon - 360 : point.lon, point.lat];
    if (
      segment.length > 0
      && Math.abs(coordinate[0] - segment[segment.length - 1][0]) > 180
    ) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
    segment.push(coordinate);
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}

function trackFeatures(
  tracks: CycloneTrack[],
  selectedTrackId: string,
  activeLeadHour: number | undefined,
  previousLeadHour: number | undefined,
  animationProgress: number,
  isHistoricalReplay: boolean
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  const addFeature = (
    track: CycloneTrack,
    path: CycloneTrackPoint[],
    phase: 'past' | 'future'
  ) => {
    const segments = lineSegments(path);
    if (segments.length) {
      features.push({
        type: 'Feature',
        properties: {
          trackId: track.id,
          phase,
          selected: track.id === selectedTrackId,
          historical: isHistoricalReplay,
        },
        geometry: { type: 'MultiLineString', coordinates: segments },
      });
    }
  };

  for (const track of tracks) {
    const points = [...track.points].sort((a, b) => a.lead_hour - b.lead_hour);
    const previousPoint = displayPoint(track, previousLeadHour);
    const activePoint = displayPoint(track, activeLeadHour);
    const movingPoint = interpolatePoint(activePoint, previousPoint, animationProgress);
    if (activeLeadHour != null && movingPoint) {
      const past = points.filter((point) => point.lead_hour < activeLeadHour);
      const future = points.filter((point) => point.lead_hour > activeLeadHour);
      addFeature(track, [...past, movingPoint], 'past');
      addFeature(track, [movingPoint, ...future], 'future');
    } else {
      addFeature(track, points, 'future');
    }
  }
  return { type: 'FeatureCollection', features };
}

function displayPoint(track: CycloneTrack | undefined, leadHour: number | undefined) {
  if (!track?.points.length || leadHour == null) return undefined;
  const points = [...track.points].sort((a, b) => a.lead_hour - b.lead_hour);
  const exactPoint = points.find((point) => point.lead_hour === leadHour);
  if (exactPoint) return exactPoint;
  const previous = [...points].reverse().find((point) => point.lead_hour < leadHour);
  const next = points.find((point) => point.lead_hour > leadHour);
  if (!previous) return undefined;
  if (!next) return previous;
  const progress = (leadHour - previous.lead_hour) / (next.lead_hour - previous.lead_hour);
  return interpolatePoint(next, previous, progress);
}

function interpolatePoint(
  current: CycloneTrackPoint | undefined,
  previous: CycloneTrackPoint | undefined,
  progress: number
): CycloneTrackPoint | undefined {
  if (!current || !previous || progress >= 1) return current;
  const easedProgress = progress * progress * (3 - 2 * progress);
  const longitudeDelta =
    ((current.lon - previous.lon + 180) % 360 + 360) % 360 - 180;
  const previousRadius = previous.rmw_nmi ?? 0;
  const currentRadius = current.rmw_nmi ?? 0;
  return {
    ...current,
    lat: previous.lat + (current.lat - previous.lat) * easedProgress,
    lon: (previous.lon + longitudeDelta * easedProgress + 360) % 360,
    rmw_nmi: previous.rmw_nmi == null && current.rmw_nmi == null
      ? null
      : previousRadius + (currentRadius - previousRadius) * easedProgress,
  };
}

function rangeCircle(point: CycloneTrackPoint | undefined): GeoJSON.FeatureCollection {
  if (!point || point.rmw_nmi == null || point.rmw_nmi <= 0) return EMPTY_FEATURES;
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Point',
        coordinates: [point.lon > 180 ? point.lon - 360 : point.lon, point.lat],
      },
    }],
  };
}

function rangeRadiusExpression(point: CycloneTrackPoint, scale = 1): unknown[] {
  const radiusMeters = (point.rmw_nmi ?? 0) * 1852;
  const latitudeScale = Math.max(0.01, Math.cos(point.lat * Math.PI / 180));
  const expression: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let zoom = 1; zoom <= 8; zoom += 1) {
    const metersPerPixel =
      (2 * Math.PI * 6_371_008.8 * latitudeScale) / (512 * 2 ** zoom);
    expression.push(zoom, (radiusMeters / metersPerPixel) * scale);
  }
  return expression;
}

function cycloneMarkerElement(size: number, active = false): HTMLDivElement {
  const element = document.createElement('div');
  element.className = active
    ? 'cyclone-pulse-marker'
    : 'cyclone-forecast-marker';
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    'pointer-events:none',
  ].join(';');

  if (active) {
    const core = document.createElement('span');
    core.className = 'cyclone-pulse-core';
    const pulseWave = document.createElement('span');
    pulseWave.className = 'cyclone-pulse-wave';
    const secondPulseWave = document.createElement('span');
    secondPulseWave.className = 'cyclone-pulse-wave cyclone-pulse-wave--delayed';
    element.append(core, pulseWave, secondPulseWave);
  }
  return element;
}

export function CycloneTrackerMap({
  modelId,
  currentStepIndex,
  onSelectStepIndex,
  onForecastLoaded,
  isPlaying,
  playbackSpeed,
}: CycloneTrackerMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const activeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const forecastMarkersRef = useRef<maplibregl.Marker[]>([]);
  const [forecast, setForecast] = useState<CycloneTracks | null>(null);
  const [meta, setMeta] = useState<ZarrMeta | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [error, setError] = useState('');
  const [mapError, setMapError] = useState('');
  const [mapReady, setMapReady] = useState(false);
  const [animationProgress, setAnimationProgress] = useState(1);
  const isHistoricalReplay = modelId === 'CycloneMocha' || modelId.startsWith('HistoricalCyclone:');
  const isMochaReplay = modelId === 'CycloneMocha_2023'
    || forecast?.model === 'CycloneMocha_2023';

  const currentLeadHour = forecast?.lead_hours[currentStepIndex];
  const previousLeadHour = currentStepIndex > 0
    ? forecast?.lead_hours[currentStepIndex - 1]
    : undefined;
  const activeTrack = forecast?.tracks.find((track) =>
    track.id === selectedTrackId && displayPoint(track, currentLeadHour)
  ) ?? forecast?.tracks.find((track) =>
    displayPoint(track, currentLeadHour)
  );
  const selectedTrack = activeTrack
    ?? forecast?.tracks.find((track) => track.id === selectedTrackId)
    ?? forecast?.tracks[0];
  const currentPoint = displayPoint(selectedTrack, currentLeadHour);
  const activeTrackPoint = displayPoint(activeTrack, currentLeadHour);
  const previousTrackPoint = displayPoint(activeTrack, previousLeadHour);
  const movingTrackPoint = interpolatePoint(
    activeTrackPoint,
    previousTrackPoint,
    animationProgress
  );
  const featureCollection = useMemo(
    () => trackFeatures(
      forecast?.tracks ?? [],
      selectedTrackId,
      currentLeadHour,
      previousLeadHour,
      animationProgress,
      isHistoricalReplay
    ),
    [forecast, selectedTrackId, currentLeadHour, previousLeadHour, animationProgress, isHistoricalReplay]
  );

  useEffect(() => {
    const previousLeadHour = currentStepIndex > 0
      ? forecast?.lead_hours[currentStepIndex - 1]
      : undefined;
    const currentLeadHour = forecast?.lead_hours[currentStepIndex];
    if (!isPlaying || previousLeadHour == null || currentLeadHour == null) {
      setAnimationProgress(1);
      return;
    }

    const durationMs = Math.round(2600 / playbackSpeed);
    const startTime = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs);
      setAnimationProgress(progress);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    setAnimationProgress(0);
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [currentStepIndex, forecast, isPlaying, playbackSpeed]);

  useEffect(() => {
    const controller = new AbortController();
    setForecast(null);
    setMeta(null);
    setSelectedTrackId('');
    setError('');
    const metaRequest = modelId === 'WeatherNext2Cyclones'
      ? fetchZarrMeta(modelId, controller.signal)
      : Promise.resolve(null);
    const trackRequest = modelId.startsWith('HistoricalCyclone:')
      ? fetchHistoricalCyclone(modelId.slice('HistoricalCyclone:'.length), controller.signal)
      : fetchCycloneTracks(modelId, controller.signal);
    Promise.all([trackRequest, metaRequest])
      .then(([tracks, modelMeta]) => {
        if (controller.signal.aborted) return;
        setForecast(tracks);
        setMeta(modelMeta);
        onForecastLoaded(tracks);
        setSelectedTrackId((previous) =>
          tracks.tracks.some((track) => track.id === previous)
            ? previous
            : tracks.tracks[0]?.id ?? ''
        );
        setError('');
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [modelId, onForecastLoaded]);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: hostRef.current,
      style: cycloneStyle(),
      center: [100, 20],
      zoom: 1.6,
      minZoom: 1,
      maxZoom: 8,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(hostRef.current);
    const resizeFrame = requestAnimationFrame(() => map.resize());

    map.once('style.load', () => {
      map.addSource('cyclone-forecast', {
        type: 'geojson',
        data: EMPTY_FEATURES,
      });
      map.addSource('cyclone-range', {
        type: 'geojson',
        data: EMPTY_FEATURES,
      });
      map.addLayer({
        id: 'cyclone-range-glow',
        type: 'circle',
        source: 'cyclone-range',
        paint: {
          'circle-radius': 0,
          'circle-color': '#ffd21c',
          'circle-opacity': 0.2,
          'circle-blur': 0.45,
        },
      });
      map.addLayer({
        id: 'cyclone-range-outer',
        type: 'circle',
        source: 'cyclone-range',
        paint: {
          'circle-radius': 0,
          'circle-color': '#ffca16',
          'circle-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'cyclone-range-middle',
        type: 'circle',
        source: 'cyclone-range',
        paint: {
          'circle-radius': 0,
          'circle-color': '#ff8b12',
          'circle-opacity': 0.28,
        },
      });
      map.addLayer({
        id: 'cyclone-range-core',
        type: 'circle',
        source: 'cyclone-range',
        paint: {
          'circle-radius': 0,
          'circle-color': '#ed3b1a',
          'circle-opacity': 0.34,
          'circle-stroke-color': '#c92d19',
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.42,
        },
      });
      map.addLayer({
        id: 'cyclone-track-casing',
        type: 'line',
        source: 'cyclone-forecast',
        paint: {
          'line-color': [
            'case',
            ['get', 'selected'],
            '#172033',
            '#111827',
          ],
          'line-width': ['case', ['get', 'selected'], 7, 5],
          'line-opacity': ['case', ['get', 'selected'], 0.88, 0.58],
          'line-blur': 0.25,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });
      map.addLayer({
        id: 'cyclone-track-lines',
        type: 'line',
        source: 'cyclone-forecast',
        paint: {
          'line-color': [
            'match',
            ['get', 'phase'],
            'past', '#55d6c2',
            ['case', ['==', ['get', 'historical'], true], '#a8bbce', '#ffd166'],
          ],
          'line-width': ['case', ['get', 'selected'], 3.5, 2.5],
          'line-opacity': ['case', ['get', 'selected'], 1, 0.68],
          'line-dasharray': [1.5, 1.2],
        },
        filter: ['==', ['get', 'phase'], 'future'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });
      map.addLayer({
        id: 'cyclone-track-history',
        type: 'line',
        source: 'cyclone-forecast',
        paint: {
          'line-color': '#55d6c2',
          'line-width': ['case', ['get', 'selected'], 3.5, 2.5],
          'line-opacity': ['case', ['get', 'selected'], 1, 0.68],
        },
        filter: ['==', ['get', 'phase'], 'past'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });
      map.addLayer({
        id: 'cyclone-track-dots',
        type: 'line',
        source: 'cyclone-forecast',
        paint: {
          'line-color': '#ff4136',
          'line-width': 3,
          'line-opacity': 0.95,
          'line-dasharray': [0, 4, 3],
        },
        filter: [
          'all',
          ['==', ['get', 'phase'], 'past'],
          ['==', ['get', 'selected'], true],
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });
      setMapReady(true);
    });
    map.on('error', (event) => {
      setMapError((previous) => previous || event.error.message);
    });

    return () => {
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [onSelectStepIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource('cyclone-forecast') as maplibregl.GeoJSONSource | undefined;
    source?.setData(featureCollection);
  }, [featureCollection, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const dashSequence = [
      [0, 4, 3],
      [1, 4, 2],
      [2, 4, 1],
      [3, 4, 0],
      [3, 1, 0, 3],
      [2, 2, 0, 3],
      [1, 3, 0, 3],
    ];
    let frame = 0;
    let lastStepAt = 0;
    let step = 0;
    const animateDashes = (now: number) => {
      if (now - lastStepAt >= 90) {
        map.setPaintProperty('cyclone-track-dots', 'line-dasharray', dashSequence[step]);
        step = (step + 1) % dashSequence.length;
        lastStepAt = now;
      }
      frame = requestAnimationFrame(animateDashes);
    };
    frame = requestAnimationFrame(animateDashes);
    return () => cancelAnimationFrame(frame);
  }, [mapReady]);

  useEffect(() => {
    for (const marker of forecastMarkersRef.current) marker.remove();
    forecastMarkersRef.current = [];
    const map = mapRef.current;
    if (!mapReady || !map || !forecast) return;

    forecastMarkersRef.current = forecast.tracks.flatMap((track) =>
      track.points.map((point) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = [
          'cyclone-forecast-marker-button',
          isHistoricalReplay ? 'is-observed' : (
            point.lead_hour < (currentLeadHour ?? -1) ? 'is-history' : 'is-forecast'
          ),
          point.lead_hour === currentLeadHour ? 'is-current' : '',
          track.id === selectedTrackId ? 'is-selected' : '',
        ].join(' ');
        const markerContent = cycloneMarkerElement(isHistoricalReplay ? 10 : 16);
        if (track.id === selectedTrackId) {
          markerContent.classList.add('is-selected');
        }
        element.append(markerContent);
        element.title = `${track.label} · +${point.lead_hour} h · ${point.intensity_label}`;
        element.setAttribute('aria-label', element.title);
        element.onclick = (event) => {
          event.stopPropagation();
          const stepIndex = forecast?.lead_hours.indexOf(point.lead_hour) ?? -1;
          if (stepIndex >= 0) {
            setSelectedTrackId(track.id);
            onSelectStepIndex(stepIndex);
          }
        };
        return new maplibregl.Marker({ element, anchor: 'center' })
          .setLngLat([
            point.lon > 180 ? point.lon - 360 : point.lon,
            point.lat,
          ])
          .addTo(map);
      })
    );

    return () => {
      for (const marker of forecastMarkersRef.current) marker.remove();
      forecastMarkersRef.current = [];
    };
  }, [currentLeadHour, forecast, isHistoricalReplay, mapReady, onSelectStepIndex, selectedTrackId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const rangeSource = map.getSource('cyclone-range') as maplibregl.GeoJSONSource | undefined;
    rangeSource?.setData(rangeCircle(movingTrackPoint));
    if (movingTrackPoint?.rmw_nmi != null && movingTrackPoint.rmw_nmi > 0) {
      for (const [layerId, scale] of [
        ['cyclone-range-glow', 2.15],
        ['cyclone-range-outer', 1.75],
        ['cyclone-range-middle', 1.25],
        ['cyclone-range-core', 0.78],
      ] as const) {
        map.setPaintProperty(
          layerId,
          'circle-radius',
          rangeRadiusExpression(movingTrackPoint, scale)
        );
      }
    }
    if (!activeTrack || !movingTrackPoint) {
      activeMarkerRef.current?.remove();
      activeMarkerRef.current = null;
      return;
    }

    const markerCoordinates: [number, number] = [
      movingTrackPoint.lon > 180 ? movingTrackPoint.lon - 360 : movingTrackPoint.lon,
      movingTrackPoint.lat,
    ];
    let marker = activeMarkerRef.current;
    if (!marker) {
      const element = document.createElement('button');
      element.type = 'button';
      element.style.cssText = [
        'padding:0',
        'border:0',
        'background:transparent',
        'cursor:pointer',
      ].join(';');
      const markerContent = cycloneMarkerElement(72, true);
      markerContent.style.pointerEvents = 'auto';
      element.append(markerContent);
      marker = new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat(markerCoordinates)
        .addTo(map);
      activeMarkerRef.current = marker;
    }

    const element = marker.getElement();
    element.title = `${activeTrack.label} · ${movingTrackPoint.wind_knots ?? '—'} kn · ${movingTrackPoint.pressure_hpa ?? '—'} hPa`;
    element.onclick = (event) => {
      event.stopPropagation();
      setSelectedTrackId(activeTrack.id);
      onSelectStepIndex(currentStepIndex);
    };
    marker.setLngLat(markerCoordinates);
  }, [activeTrack, currentStepIndex, isHistoricalReplay, mapReady, movingTrackPoint, onSelectStepIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !activeTrackPoint) return;
    map.easeTo({
      center: [
        activeTrackPoint.lon > 180 ? activeTrackPoint.lon - 360 : activeTrackPoint.lon,
        activeTrackPoint.lat,
      ],
      zoom: Math.min(5, Math.max(map.getZoom(), 4.2)),
      duration: Math.round((isPlaying ? 2600 : 850) / (isPlaying ? playbackSpeed : 1)),
      easing: (time) => time * time * (3 - 2 * time),
    });
  }, [activeTrackPoint, isPlaying, mapReady, playbackSpeed]);

  const outputVariables = meta?.available_variables ?? [];

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-950 text-white">
      <div ref={hostRef} className="absolute inset-0 h-full w-full" />

      <section className="pointer-events-auto absolute left-3 top-20 z-10 max-h-[calc(100vh-11rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-white/15 bg-slate-950/90 shadow-2xl backdrop-blur-xl sm:left-4">
        <div className="border-b border-white/10 px-4 py-3">
          <div className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${isMochaReplay ? 'text-cyan-300' : 'text-orange-300'}`}>
            {isMochaReplay
              ? 'BAY OF BENGAL · HISTORICAL REPLAY'
              : forecast?.model_label ?? (isHistoricalReplay ? 'Historical cyclone · IBTrACS' : 'WeatherNext2Cyclones')}
          </div>
          <h2 className="mt-1 text-sm font-bold text-white">
            {isMochaReplay
              ? 'မိုခါ ဆိုင်ကလုန်း · ၂၀၂၃'
              : isHistoricalReplay ? 'သမိုင်းဝင် ဆိုင်ကလုန်းလမ်းကြောင်း ပြန်ကြည့်ရန်' : 'ဆိုင်ကလုန်းခန့်မှန်းလမ်းကြောင်း'}
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-300">
            {isMochaReplay
              ? 'ဘင်္ဂလားပင်လယ်အော်မှ မြန်မာနိုင်ငံအတွင်းသို့ ဝင်ရောက်ခဲ့သော မုန်တိုင်း၏ မှတ်တမ်းတင်လမ်းကြောင်း။'
              : isHistoricalReplay
              ? 'NOAA IBTrACS မှ မှတ်တမ်းတင်ထားသော ဆိုင်ကလုန်း၏ လမ်းကြောင်း၊ လေတိုက်နှုန်းနှင့် လေဖိအား။'
              : 'တည်နေရာ အမှတ်များကို ဆိုင်ကလုန်းတည်ရှိမှု အညွှန်းမှ ရှာဖွေထားပြီး ခန့်မှန်းချိန်အလိုက် ချိတ်ဆက်ပြထားသည်။'}
          </p>
          {isHistoricalReplay && currentPoint && (
            <div className="mt-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-cyan-100">
                  မှတ်တမ်းအချိန် · UTC
                </span>
                <span className="rounded-full bg-cyan-200/10 px-2 py-0.5 text-[9px] font-semibold text-cyan-100">
                  {currentPoint.lead_hour === 0 ? 'START' : `+${currentPoint.lead_hour} H`}
                </span>
              </div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-white">
                {Number.isNaN(Date.parse(currentPoint.valid_utc))
                  ? currentPoint.valid_utc
                  : new Intl.DateTimeFormat('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'UTC',
                    hour12: false,
                  }).format(new Date(currentPoint.valid_utc))}
              </div>
              <div className="mt-1 text-[10px] text-slate-400">
                {Math.abs(currentPoint.lat).toFixed(2)}°{currentPoint.lat < 0 ? 'S' : 'N'} · {
                  Math.abs(currentPoint.lon > 180 ? currentPoint.lon - 360 : currentPoint.lon).toFixed(2)
                }°{currentPoint.lon > 180 ? 'W' : 'E'}
                {forecast?.lead_hours.length ? ` · ${forecast.lead_hours.length} fixes` : ''}
              </div>
            </div>
          )}
          {forecast?.tracking_method && !isMochaReplay && (
            <p className="mt-1 text-[10px] leading-4 text-slate-500">
              {forecast.tracking_method}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 px-4 py-3 text-xs">
          <div className="rounded-xl bg-white/5 p-2.5">
            <div className="text-[10px] text-slate-400">
              {isHistoricalReplay ? 'မှတ်တမ်းတင်ထားသော လမ်းကြောင်း' : 'ခန့်မှန်းလမ်းကြောင်း'}
            </div>
            <div className={`mt-1 font-semibold ${isMochaReplay ? 'text-cyan-200' : 'text-orange-200'}`}>
              {forecast ? `${forecast.tracks.length} ခု` : 'ဖတ်နေသည်…'}
            </div>
          </div>
          <div className="rounded-xl bg-white/5 p-2.5">
            <div className="text-[10px] text-slate-400">ရွေးထားသော မုန်တိုင်း</div>
            <div className="mt-1 truncate font-semibold text-white">
              {selectedTrack?.label ?? 'မတွေ့ရှိသေးပါ'}
            </div>
          </div>
          <div className="rounded-xl bg-white/5 p-2.5">
            <div className="text-[10px] text-slate-400">လေတိုက်နှုန်း</div>
            <div className="mt-1 font-semibold text-white">
              {currentPoint?.wind_knots == null ? '—' : `${currentPoint.wind_knots} kn · ${Math.round(currentPoint.wind_knots * 1.852)} km/h (${currentPoint.intensity_label})`}
            </div>
          </div>
          <div className="rounded-xl bg-white/5 p-2.5">
            <div className="text-[10px] text-slate-400">ဗဟိုလေဖိအား</div>
            <div className="mt-1 font-semibold text-white">
              {currentPoint?.pressure_hpa == null ? '—' : `${currentPoint.pressure_hpa} hPa`}
            </div>
          </div>
        </div>

        {isHistoricalReplay ? (
          <div className="border-t border-white/10 px-4 py-3 text-[11px] text-slate-400">
            <div className="mb-1 font-medium text-slate-300">
              {isMochaReplay ? 'မုန်တိုင်းလမ်းကြောင်း ရင်းမြစ်' : 'Source'}:
            </div>
            {forecast?.source_url ? (
              <a
                href={forecast.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-200 underline underline-offset-2"
              >
                {forecast.source || 'NOAA/NCEI IBTrACS v04r01'}
              </a>
            ) : (
              <span>{forecast?.source || 'NOAA/NCEI IBTrACS v04r01'}</span>
            )}
            {isMochaReplay && (
              <p className="mt-2 leading-4 text-slate-500">
                ပြသထားသည်မှာ ဗဟိုတည်နေရာ၊ အမြင့်ဆုံးလေတိုက်နှုန်းနှင့် ဗဟိုလေဖိအားသာဖြစ်သည်။ Zarr ထဲရှိ မြေပုံကွက်လေတိုက်နှုန်းနှင့် တိမ်တိုက်အချက်အလက်များသည် သရုပ်ပြဖန်တီးထားသော ဒေတာဖြစ်သည်။
              </p>
            )}
          </div>
        ) : (
          <details className="border-t border-white/10">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-emerald-200">
              ထုတ်ပေးသော ခန့်မှန်းအချက်အလက်များ ({outputVariables.length})
            </summary>
            <ul className="max-h-44 space-y-1 overflow-y-auto px-4 pb-3 text-[11px] text-slate-300">
              {outputVariables.map((id) => {
                const variable = meta?.variables[id];
                return (
                  <li key={id} className="flex items-start justify-between gap-3">
                    <span>{variable?.label_mm || variable?.label || id}</span>
                    <span className="shrink-0 text-slate-500">{variable?.unit}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {error && (
          <p role="alert" className="border-t border-rose-400/20 px-4 py-3 text-xs text-rose-200">
            {error}
          </p>
        )}
        {mapError && (
          <p role="alert" className="border-t border-rose-400/20 px-4 py-3 text-xs text-rose-200">
            Basemap could not load: {mapError}
          </p>
        )}
        {forecast && !forecast.tracks.length && !error && (
          <p className="border-t border-amber-400/20 px-4 py-3 text-xs text-amber-100">
            {isMochaReplay
              ? 'မိုခါဆိုင်ကလုန်းအတွက် မှတ်တမ်းတင်ထားသော လမ်းကြောင်းကို မတွေ့ပါ။'
              : isHistoricalReplay
              ? 'IBTrACS မှ ဆိုင်ကလုန်းလမ်းကြောင်းကို မတွေ့ပါ။'
              : 'ဤခန့်မှန်းချက်တွင် ချိတ်ဆက်နိုင်သော ဆိုင်ကလုန်းလမ်းကြောင်း မတွေ့ပါ။'}
          </p>
        )}
      </section>

      <div className="pointer-events-none absolute bottom-28 right-3 z-10 rounded-xl border border-white/15 bg-slate-950/85 px-3 py-2 text-[10px] text-slate-200 shadow-xl backdrop-blur sm:right-4">
        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-teal-300" />
        {isHistoricalReplay ? 'Observed track' : 'Tracked path'}
        <span className="mx-2 inline-block h-0.5 w-4 border-t border-dashed border-amber-300 align-middle" />
        {isHistoricalReplay ? 'Recorded observations · tap a point to replay' : 'Forecast · tap a point to follow'}
      </div>
    </div>
  );
}
