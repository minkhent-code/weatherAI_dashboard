import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchEnsoReplay, type EnsoReplay } from '../services/zarrApi';

interface EnsoReplayMapProps {
  episodeId: string;
  currentStepIndex: number;
  onReplayLoaded: (replay: EnsoReplay) => void;
}

const NINO34_FEATURE: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[-170, -5], [-120, -5], [-120, 5], [-170, 5], [-170, -5]]],
    },
  }],
};

function oceanStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: 'Historical ocean replay',
    sources: {
      satellite: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Tiles © Esri',
        maxzoom: 18,
      },
    },
    layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
  };
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function EnsoReplayMap({
  episodeId,
  currentStepIndex,
  onReplayLoaded,
}: EnsoReplayMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [replay, setReplay] = useState<EnsoReplay | null>(null);
  const [error, setError] = useState('');
  const [mapError, setMapError] = useState('');
  const [mapReady, setMapReady] = useState(false);
  const point = replay?.points[Math.min(currentStepIndex, (replay?.points.length ?? 1) - 1)];
  const recentPoints = useMemo(
    () => replay?.points.slice(Math.max(0, currentStepIndex - 17), currentStepIndex + 1) ?? [],
    [currentStepIndex, replay]
  );

  useEffect(() => {
    const controller = new AbortController();
    setReplay(null);
    setError('');
    fetchEnsoReplay(episodeId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setReplay(data);
        onReplayLoaded(data);
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [episodeId, onReplayLoaded]);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: hostRef.current,
      style: oceanStyle(),
      center: [-145, 0],
      zoom: 2.6,
      minZoom: 1,
      maxZoom: 8,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.once('style.load', () => {
      map.addSource('nino34', { type: 'geojson', data: NINO34_FEATURE });
      map.addLayer({
        id: 'nino34-fill',
        type: 'fill',
        source: 'nino34',
        paint: {
          'fill-color': '#f97316',
          'fill-opacity': 0.38,
          'fill-outline-color': '#fde68a',
        },
      });
      map.addLayer({
        id: 'nino34-outline',
        type: 'line',
        source: 'nino34',
        paint: { 'line-color': '#fff7ed', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
      setMapReady(true);
    });
    map.on('error', (event) => setMapError((previous) => previous || event.error.message));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || point?.oni_c == null) return;
    const warm = point.oni_c >= 0;
    map.setPaintProperty('nino34-fill', 'fill-color', warm ? '#fb6542' : '#38bdf8');
    map.setPaintProperty('nino34-fill', 'fill-opacity', Math.min(0.75, 0.3 + Math.abs(point.oni_c) * 0.2));
  }, [mapReady, point]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-950 text-white">
      <div ref={hostRef} className="absolute inset-0 h-full w-full" />
      <section className="pointer-events-auto absolute left-3 top-20 z-10 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-white/15 bg-slate-950/90 shadow-2xl backdrop-blur-xl sm:left-4">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
            Myanmar Historical Replay · NOAA ONI context
          </div>
          <h2 className="mt-1 text-sm font-bold text-white">{replay?.label ?? 'Loading climate event…'}</h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-300">
            Pacific-wide ONI climate context for Myanmar replay, not local Myanmar SST, rainfall, or impact measurements.
          </p>
        </div>

        {point && (
          <>
            <div className="grid grid-cols-2 gap-2 px-4 py-3 text-xs">
              <div className="rounded-xl bg-white/5 p-2.5">
                <div className="text-[10px] text-slate-400">Observed SST · Niño 3.4</div>
                <div className="mt-1 font-semibold text-white">{point.sst_c.toFixed(2)} °C</div>
              </div>
              <div className="rounded-xl bg-white/5 p-2.5">
                <div className="text-[10px] text-slate-400">ONI anomaly</div>
                <div className={`mt-1 font-semibold ${point.oni_c >= 0 ? 'text-orange-200' : 'text-sky-200'}`}>
                  {point.oni_c > 0 ? '+' : ''}{point.oni_c.toFixed(2)} °C
                </div>
              </div>
            </div>
            <div className="px-4 pb-3">
              <div className="mb-2 flex justify-between text-[10px] text-slate-400">
                <span>Recent ONI · 3-month seasons</span>
                <span>{formatDate(point.valid_utc)}</span>
              </div>
              <div className="flex h-12 items-end gap-0.5 border-b border-white/15">
                {recentPoints.map((item, index) => (
                  <div
                    key={`${item.valid_utc}-${index}`}
                    title={`${item.season} ${item.year}: ${item.oni_c.toFixed(2)} °C`}
                    className={`min-w-0 flex-1 rounded-t-sm ${item.oni_c >= 0 ? 'bg-orange-400' : 'bg-sky-400'}`}
                    style={{ height: `${Math.max(8, Math.min(100, Math.abs(item.oni_c) * 38))}%` }}
                  />
                ))}
              </div>
              <div className="mt-2 text-[10px] leading-4 text-slate-400">
                ENSO episodes are identified using five consecutive overlapping seasons at ONI ≥ +0.5 °C or ≤ −0.5 °C.
              </div>
            </div>
            <div className="border-t border-white/10 px-4 py-2.5 text-[10px] text-slate-400">
              Shaded ocean area: Niño 3.4 (5°N–5°S, 170°W–120°W). This basin-scale index is not a Myanmar-local observation or impact record.
              {replay.source_url && (
                <a href={replay.source_url} target="_blank" rel="noopener noreferrer" className="ml-1 text-cyan-200 underline">
                  Source
                </a>
              )}
            </div>
          </>
        )}
        {error && <p role="alert" className="border-t border-rose-400/20 px-4 py-3 text-xs text-rose-200">{error}</p>}
        {mapError && <p role="alert" className="border-t border-rose-400/20 px-4 py-3 text-xs text-rose-200">Basemap could not load: {mapError}</p>}
      </section>
      <div className="pointer-events-none absolute bottom-28 right-3 z-10 rounded-xl border border-white/15 bg-slate-950/85 px-3 py-2 text-[10px] text-slate-200 shadow-xl backdrop-blur sm:right-4">
        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-orange-400" />
        El Niño
        <span className="mx-3 inline-block h-2.5 w-2.5 rounded-full bg-sky-400" />
        La Niña
      </div>
    </div>
  );
}
