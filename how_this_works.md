# How this works

Entry points:

- `server.ts` — Express + Vite on **5180**, proxies `/api/zarr/*` to the Python field API  
- `backend/zarr_field_server.py` — discovers local Zarr models and serves them on **8766**
- `src/App.tsx` — UI shell  
- `src/components/ForecastMap2D.tsx` — MapLibre **မြန်မာ့ဒေသတွင်း ဂြိုဟ်တုရေဒါ** page  
- `notebook/NVIDIA_Earth2_GPU_Colab_Myanmar.ipynb` — optional Colab zip factory (globe / city)

```bash
python -m venv .venv
# Windows
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
# macOS / Linux
# .venv/bin/python -m pip install -r backend/requirements.txt
npm install
npm run dev
# → http://localhost:5180
# zarr API auto-started (or reused) on :8766

# if needed alone:
npm run zarr-api
```

For the optional GFS forecast-generation pipeline, install `backend/requirements-pipeline.txt` into `.venv`; it adds Earth2Studio and Matplotlib.

Deep start guide: [`README.md`](README.md).

## Private office use

Keep this repository private. Put supported Zarr stores in `models/<model-id>/` (or `models/<model-id>/forecast.zarr/`). Zarr IDs are `FourCastNet3`, `PrecipitationAFNOv2`, `Pangu-Weather`, `WindGustAFNO`, and `WeatherNext2Cyclones`; stores stay local and are gitignored. Each model has a dedicated adapter under `backend/model_loaders/`. Run `python backend/model_loaders/historical_events.py all` separately to download NOAA IBTrACS and CPC ONI into event-specific Zarr stores under `models/HistoricalEvents/`; IBTrACS is about 330 MB. Cyclones are retained when their observed track enters 9–29°N, 92–102°E, and each retained storm's full track is stored. The header lists those events and all qualifying ONI episodes; the bottom dock provides playback, speed, looping, and scrubbing. ONI episodes are Pacific-wide climate context, not Myanmar-local SST, rainfall, or impact observations. The API reads each selected event store and adapts it to the replay UI. No NVIDIA API key for the website. Map views need internet for Esri basemap tiles; forecast grids stay on disk.

## Layout

```text
Local_NVIDIA_FourCastNet_Myanmar_AI_Weather_Showcase/
  models/<model-id>/             one of the five supported local forecast stores
  models/HistoricalEvents/
    catalog.json                 event index
    cyclones/<event>.zarr/       Myanmar-bounds storm tracks
    enso/<episode>.zarr/         Pacific ONI episode context
  server.ts                      Express + Vite; /api/zarr proxy
  backend/zarr_field_server.py   FastAPI forecast and historical replay endpoints
  backend/model_loaders/         model-specific forecast output definitions
  notebook/…ipynb                Colab zip factory
  public/forecast_data/          sea-borders.json, sample layers
  public/textures/               globe imagery
  src/
    App.tsx                      views and historical replay selection
    components/ForecastMap2D.tsx MapLibre heat + city pins
    components/SatelliteGlobe3D.tsx
    components/CityForecastPanel.tsx
    components/TimelineControls.tsx   playback and timeline dock
    services/zarrApi.ts          fetch meta/field
    data/forecastData.json       bundled globe/city sample
  README.md
  how_this_works.md
```

## End-to-end flow

```text
models/<model-id>/ (local model stores on disk)
        │
        ▼
Python field API :8766
  GET /api/models → discover local models
  GET /api/meta   → selected model's leads, variables, init time
  GET /api/field  → selected model's cropped grid JSON (+ units / cmap)
        │
        ▼
Express /api/zarr/*  (port 5180)
        │
        ▼
ForecastMap2D (MapLibre)
  · Esri satellite tiles
  · JPEG heat overlay (fixed SE Asia / BoB crop)
  · borders + city pins
  · all variables including derived wind10m

Parallel path (globe / city-trends):
  globe: bundled forecastData.json or Colab zip
  city trends: selected local model timeseries, then bundled/Colab fallback
```

## MapLibre satellite-radar page

| Behaviour | Detail |
| --- | --- |
| Default view | `globe_3d` |
| Basemap | Esri World Imagery (needs network) |
| Heat | Built client-side from the selected model at `/api/zarr/field`; fixed `HEAT_BBOX` so zoom/play do not blank it |
| Zoom | `minZoom ≈ 4.15`, `maxZoom = 10`, tight `maxBounds` around the storm basin |
| Variables | Available variables from the selected store + derived `wind10m` |
| Ensemble | Mean of members (API `ensemble=mean`) |
| Cities | 15 state/region capitals (`src/data/myanmarCities.ts`); HTML pins with °C from selected-model zarr `t2m` |
| Playback | Advances **lead hours only** on this page (no auto city tour) |
| Speeds | `0.5 / 1 / 2 / 5 / 10` |

The globe keeps the older bundled / Colab temp+wind data path. City trends request the selected local model and fall back to bundled / Colab temp+wind metrics if Zarr timeseries are unavailable.

## Predictions vs storm alert

| Output | From |
| --- | --- |
| MapLibre fields | Selected local Zarr model via Python API |
| City trends | Selected local Zarr model; bundled JSON or Colab FCN zip fallback |
| Globe temp + wind | Bundled JSON or Colab FCN zip |
| WeatherNext2Cyclones | Global forecast tracker derived from cyclone-existence fields |
| Historical cyclones | IBTrACS track, wind, and pressure for storms entering Myanmar bounds |
| ENSO / La Niña | NOAA ONI episode context and Niño 3.4 SST; not local Myanmar observations |
| `storm_alert.json` | Optional notebook rule; separate from the WeatherNext tracker |
| Humidity / rain as Colab zip products | Not in the Colab zip path (MapLibre can show `q850` / `tcwv` from zarr) |

Honest demo line: *“Satellite-radar and city-trends views use model-specific local fields; historical cyclone tracks and ENSO/La Niña indices are NOAA observations; the globe uses the bundled or Colab sample.”*

## Colab export (zip factory for globe / city)

Notebook: [`notebook/NVIDIA_Earth2_GPU_Colab_Myanmar.ipynb`](notebook/NVIDIA_Earth2_GPU_Colab_Myanmar.ipynb)

1. Colab + GPU → install FCN → restart → Gradio forecast.  
2. Download zip → drop on UI header.  
3. Updates globe / city grids; local model folders continue to feed the MapLibre views.

| Notebook output | Globe / city |
| --- | --- |
| `t2m` → °C | temperature |
| `u10m`/`v10m` → km/h | wind |
| Myanmar crop 9–29°N, 92–102°E | `geo.ts` sampling |

## Zip contract (Colab path)

| File | Role |
| --- | --- |
| `regional_forecast.npz` | `temperature_c`, `wind_kmh`, coords, leads |
| `metadata.json` | provenance |
| `storm_alert.json` | optional (UI unused) |
| `all_steps_with_future_flags.csv` | city/time table |

Parser: `src/utils/zipForecastParser.ts`.

## Showcase behaviour

| Feature | Behaviour |
| --- | --- |
| Boot | Bundled `DEFAULT_FORECAST_DATA` for globe/city; MapLibre loads zarr meta when API is up |
| Historical replay | Reads per-event Zarr stores for Myanmar-bounds cyclones or NOAA ONI climate-context episodes |
| Network | Esri tiles on radar page only; no NVIDIA NIM / Open-Meteo forecast calls |

Keyboard: `←`/`→` steps through the active timeline · `Space` toggles playback · `F` fullscreen.

## Bounds

| Name | Value |
| --- | --- |
| MapLibre frame | ~78–112°E, 2–28.5°N |
| Heat API crop | ~74–116°E, 0.5–30.5°N |
| Colab Myanmar crop | 9–29°N, 92–102°E |
| Typical zarr leads | 0…168 h / 6 h |

## References

| What | Link |
| --- | --- |
| FourCastNet paper | https://arxiv.org/abs/2202.11214 |
| Earth2Studio | https://nvidia.github.io/earth2studio/main/ |
| MapLibre | https://maplibre.org/ |
| NOAA GFS open data | https://registry.opendata.aws/noaa-gfs-bdp-pds/ |

StormScope is out of scope (different nowcasting stack). Optional notebook `storm_alert.json` is not displayed.

## What to edit

| Goal | Touch |
| --- | --- |
| MapLibre map / heat / pins / zoom | `src/components/ForecastMap2D.tsx` |
| Zarr client | `src/services/zarrApi.ts` |
| Field API / store path | `backend/zarr_field_server.py` |
| Proxy / sidecar spawn | `server.ts` |
| Historical replay selection | `src/App.tsx` |
| Playback and timeline dock | `src/components/TimelineControls.tsx` |
| Colab zip ingest | `src/utils/zipForecastParser.ts` |
| Bundled globe sample | `src/data/forecastData.json` |
| Docs | `README.md`, `how_this_works.md` |
