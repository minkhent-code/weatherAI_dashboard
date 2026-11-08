# Local NVIDIA FourCastNet Myanmar AI Weather Showcase

Private office showcase: React + Express UI for local forecast models over Myanmar and the Bay of Bengal.

Keep the repo private. Two data paths are supported:

1. **Local Zarr model folders** (recommended for the satellite-radar MapLibre page) — one or more local forecast stores on disk
2. **Bundled sample / Colab `.zip`** — used by the 3D globe and as a city-trends fallback

**No NVIDIA API key** is required. This is a demonstration build, not a public product release.

Deep dive: [`how_this_works.md`](how_this_works.md)

## What this is

| Piece | Source |
| --- | --- |
| Default landing view | **3D globe** with bundled forecast data; switch views to open the satellite-radar map |
| Satellite-radar map | **MapLibre** + Esri World Imagery tiles + heat overlay from selected local Zarr model via Python field API |
| Zarr variables on that map | Each model exposes its own parameters, labels, units, and Burmese translations |
| WeatherNext2Cyclones | Opens the regular satellite-radar view with animated forecast cyclone tracks |
| Historical Replay | Myanmar-bounds IBTrACS cyclone tracks plus NOAA ONI El Niño/La Niña context, stored as per-event Zarr under `models/HistoricalEvents/` |
| 3D globe | Bundled `src/data/forecastData.json` or a dropped Colab FCN zip |
| City trends | Selected local model's Zarr time series; falls back to bundled/Colab **2 m temperature** + **10 m wind** |
| Storm / cyclone data | WeatherNext2Cyclones forecast tracker and Myanmar-focused Historical Replay stores; notebook `storm_alert.json` is separate |

Internal research / software showcase. Local forecast skill has **not** been formally validated here.

## Requirements

| Need | Notes |
| --- | --- |
| Node.js **20+** | app server + Vite |
| npm | uses `package-lock.json` |
| Python **3.11+** | Install `backend/requirements.txt` for the local field API |
| Forecast stores | put supported stores under `models/<model-id>/` (gitignored — do not commit) |
| Modern browser | WebGL / MapLibre |
| Network | **satellite-radar** page needs internet for Esri basemap tiles; heat data stays local |
| GPU Colab/Kaggle (optional) | only to **export a new Colab zip** for the globe and fallback city data |

## Quick start

```bash
cd Local_NVIDIA_FourCastNet_Myanmar_AI_Weather_Showcase

# Put supported forecast stores in:
#    ./models/FourCastNet3/forecast.zarr/
#    ./models/PrecipitationAFNOv2/forecast.zarr/
#    ./models/Pangu-Weather/forecast.zarr/
#    ./models/WindGustAFNO/forecast.zarr/
#    ./models/WeatherNext2Cyclones/forecast.zarr/

python -m venv .venv
# Windows
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
# macOS / Linux
# .venv/bin/python -m pip install -r backend/requirements.txt

npm install
npm run dev
```

Run `.\.venv\Scripts\python.exe backend\model_loaders\historical_events.py all` separately to fetch NOAA data and build event-specific Zarr stores under `models/HistoricalEvents/`. The command prints connection, byte/progress, and processing status, keeps a resumable source archive in `models/HistoricalEvents/downloads/`, and reuses it on later runs. It includes storms whose tracks enter 9–29°N, 92–102°E and all qualifying NOAA ONI episodes as Pacific-scale climate context. The IBTrACS source archive is about 330 MB. The local API reads this catalog and serves the selected Zarr event to the replay UI; click the refresh icon next to the event selector after the script finishes.

Open **http://localhost:5180**

`npm run dev` starts Express + Vite on **5180** and spawns (or reuses) the zarr field API on **8766**. If an older API occupies that port, it starts the compatible sidecar on another available port. Proxy path: `/api/zarr/*`.

If the map says the zarr API is unavailable:

```bash
npm run zarr-api
# → http://127.0.0.1:8766
```

This **Local_** repo uses port **5180** so it does not collide with the normal (non-local) showcase on **http://localhost:3000**.

| Script | What |
| --- | --- |
| `npm run dev` | Express + Vite on **5180** + auto-start zarr API on **8766** |
| `npm run zarr-api` | Python field server only (`backend/zarr_field_server.py`) |
| `npm run build` | production build → `dist/` |
| `npm start` | same entry as `dev` (`tsx server.ts`) |
| `npm run lint` | `tsc --noEmit` |

## Layout

```text
Local_NVIDIA_FourCastNet_Myanmar_AI_Weather_Showcase/
  models/
    FourCastNet3/           global ensemble fields
    PrecipitationAFNOv2/    six-hour precipitation
    Pangu-Weather/          pressure-level weather fields
    WindGustAFNO/            10 m wind gust
    WeatherNext2Cyclones/   cyclone existence and intensity fields
  server.ts                 Express + Vite; proxies /api/zarr → :8766
  backend/
    zarr_field_server.py    FastAPI model discovery + metadata/field crops
    model_loaders/          per-model parameters, units, and translations
    fourcastnet_pipeline.py optional automation sketch
  notebook/                 Colab / Kaggle GPU export → forecast .zip
  public/
    forecast_data/          bundled layers, sea-borders.json, configs
    textures/               globe textures (offline)
  src/
    App.tsx                 views, historical selection, zip drop
    components/
      ForecastMap2D.tsx     MapLibre satellite-radar page
      SatelliteGlobe3D.tsx  3D globe
      CityForecastPanel.tsx city trends
      TimelineControls.tsx playback and timeline dock
    services/
      zarrApi.ts            client for /api/zarr/meta + /api/zarr/field
      weatherVariables.ts   Colab zip fields (temp + wind)
    data/                   defaultForecast + forecastData.json
  how_this_works.md
  README.md
```

## Data flow

```text
models/*/  ──►  per-model Python loaders :8766  ──►  /api/zarr/*  ──►  map + cyclone tracker
                                                                      (selected model)

Bundled JSON / Colab zip  ──►  React (globe + city trends: temp + wind)
```

| Mode | What the UI uses |
| --- | --- |
| Satellite-radar (default) | Selected local Zarr model via field API — cropped heat overlay on MapLibre |
| WeatherNext2Cyclones map | Uses the same satellite-radar view and shared timeline, with animated existence-field forecast tracks, wind and pressure markers |
| Historical replay | Header selector groups archived events; the bottom playback dock scrubs and plays the selected observations |
| ENSO ocean map | Highlights the Niño 3.4 area and shows observed area-mean SST, ONI anomaly, and the recent index sequence |
| Globe | Bundled `forecastData.json` or uploaded Colab zip |
| City trends | Selected local Zarr model; bundled / uploaded zip as fallback |
| Model selector | Discovers available forecast stores in `models/`; the separate Historical Replay selector opens archive events |
| After Colab zip drop | Updates globe/city grids; MapLibre page continues to use the selected local Zarr model |

## UI features

| Action | How |
| --- | --- |
| Default view | **3D satellite globe** |
| MapLibre layers | All zarr variables + derived `wind10m`; Burmese chips |
| Large model catalogs | Parameter chips remain available in a scrollable panel (no dropdown) |
| Heat overlay | Fixed SE Asia / BoB crop — stays visible while zooming and playing |
| Zoom | Min ~**4.15**, max **10**; pan limited to the storm-basin box |
| City pins | MapLibre dots + labels; click to select (no auto city-tour on this page) |
| Historical replay | Header event selector · bottom playback dock with play/pause and scrubber · `←`/`→` · `F` fullscreen |
| Time labels | Burmese windows, e.g. `၃-၁၁-၂၀၂၆ (၀၀:၀၀ မှ ၀၆:၀၀)` |
| City tour | Globe / city-trends only — radar page keeps the selected city fixed |
| Load Colab zip | Header upload or drag-drop (globe / city data) |
| Storm HUD | **not wired** |

## Local model stores

1. Put Zarr stores under `models/<model-id>/` or `models/<model-id>/forecast.zarr/`. Supported Zarr IDs are `FourCastNet3`, `PrecipitationAFNOv2`, `Pangu-Weather`, `WindGustAFNO`, and `WeatherNext2Cyclones`.
2. Each Zarr model has its own loader under `backend/model_loaders/`. The API reads Zarr v2 or v3 forecast grids in supported lead/time/ensemble layouts.
3. Run `python backend/model_loaders/historical_events.py all` separately to download NOAA/NCEI IBTrACS v04r01 and NOAA CPC ONI into `models/HistoricalEvents/`. Cyclone events are full observed tracks for storms entering 9–29°N, 92–102°E; event stores are written to `cyclones/<storm-name>--<IBTrACS-SID>.zarr/`. Qualifying ONI episodes are stored separately under `enso/<episode-name>.zarr/`; `catalog.json` indexes both groups. Use `cyclones` or `enso` to update one group. The raw IBTrACS CSV is about 330 MB.
4. The Historical Replay selector lists those Myanmar-bounds cyclones and all qualifying El Niño/La Niña episodes. Episodes use NOAA's five consecutive overlapping seasons at ONI ≥ +0.5 °C or ≤ −0.5 °C. ONI is a Pacific-wide climate index/context, not Myanmar-local SST, rainfall, or impact observations.
5. Keep local model data uncommitted; `models/` is listed in `.gitignore`.
6. The field API serves **viewport/region crops** as JSON; the browser never loads the whole store. WeatherNext2Cyclones links cyclone-existence peaks using predicted motion and speed limits. These are heuristic tracks, not official storm IDs or operational warnings.

Health check: `http://localhost:5180/api/zarr/health`

The optional GFS forecast-generation pipeline has additional, much larger dependencies. Install them only if you use `backend/fourcastnet_pipeline.py`:

```bash
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-pipeline.txt
```

## Make a new Colab forecast zip (globe / city)

Notebook: [`notebook/NVIDIA_Earth2_GPU_Colab_Myanmar.ipynb`](notebook/NVIDIA_Earth2_GPU_Colab_Myanmar.ipynb)

This zip path feeds the **globe** and provides fallback metrics for **city trends** (temp + wind). It does **not** replace the selected local model for MapLibre.

1. Upload to [Google Colab](https://colab.research.google.com/) → **GPU** runtime.  
2. Run install → restart → imports → Gradio forecast.  
3. Download `NVIDIA_FCN_Myanmar_*_Forecast.zip`.  
4. Drop it on the local UI header at http://localhost:5180.

| Notebook output | Globe / city UI |
| --- | --- |
| `t2m` → `temperature_c` (°C) | temperature maps, city °C |
| `u10m` + `v10m` → `wind_kmh` | wind maps, city km/h |
| Lat **29°N → 9°N**, Lon **92°E → 102°E**, 0.25° | `sampleGrid` in `src/utils/geo.ts` |
| 12 cities | `src/data/forecastData.json` + `src/utils/burmese.ts` |

MapLibre city pins (15 state/region capitals) — coords in `src/data/myanmarCities.ts`; °C sampled from the selected model's `t2m`:

| # | State / Region | City | Lat | Lon |
| --- | --- | --- | --- | --- |
| 1 | Yangon Region | Yangon | 16.8053 | 96.1561 |
| 2 | Mandalay Region | Mandalay | 21.9747 | 96.0836 |
| 3 | Sagaing Region | Sagaing | 21.8822 | 95.9786 |
| 4 | Magway Region | Magway | 20.1500 | 94.9500 |
| 5 | Bago Region | Bago | 17.3433 | 96.4981 |
| 6 | Ayeyarwady Region | Pathein | 16.7667 | 94.7333 |
| 7 | Tanintharyi Region | Dawei | 14.0800 | 98.1900 |
| 8 | Kachin State | Myitkyina | 25.3867 | 97.3936 |
| 9 | Shan State | Taunggyi | 20.7806 | 97.0372 |
| 10 | Chin State | Hakha | 22.6510 | 93.6166 |
| 11 | Kayah State | Loikaw | 19.6830 | 97.2170 |
| 12 | Kayin State | Hpa-An | 16.8906 | 97.6333 |
| 13 | Mon State | Mawlamyine | 16.4847 | 97.6258 |
| 14 | Rakhine State | Sittwe | 20.1444 | 92.8969 |
| 15 | Naypyidaw Territory | Naypyidaw | 19.7475 | 96.1150 |

## Storm alert (honest summary)

The Colab notebook can still write `storm_alert.json` (BoB peak wind ≥ **65 km/h**). The zip parser may keep it; **this UI does not render a cyclone card**. Express does **not** expose `/api/storm-alert`.

## Bounds

| Name | Value |
| --- | --- |
| MapLibre default frame | ~Lon **78–112°E**, Lat **2–28.5°N** (SE Asia + BoB + Andaman) |
| MapLibre max zoom-out | minZoom **~4.15**, hard maxBounds around that basin |
| Heat crop (API) | ~Lon **74–116°E**, Lat **0.5–30.5°N** (fixed so play/zoom keep the overlay) |
| Bundled Colab crop | Lat **9–29°N**, Lon **92–102°E** |
| Zarr leads | model-specific forecast steps from its local store |
| Model fields (MapLibre) | output parameters declared by that model's loader |
| Model fields (globe / city zip) | **2 m temperature**, **10 m wind** only |

## References

### Model and article

| What we run | Link |
| --- | --- |
| **FourCastNet** paper (Pathak et al., 2022) | https://arxiv.org/abs/2202.11214 |
| Earth2Studio `FCN` class | https://github.com/NVIDIA/earth2studio/blob/main/earth2studio/models/px/fcn.py |
| Earth2Studio docs | https://nvidia.github.io/earth2studio/main/ |
| NVIDIA Earth-2 | https://www.nvidia.com/en-us/high-performance-computing/earth-2/ |
| MapLibre GL JS | https://maplibre.org/ |

Installed pin in the Colab notebook: `earth2studio[fcn]==0.20.0`.

### Initial conditions

| What | Link |
| --- | --- |
| NOAA GFS on AWS (`noaa-gfs-bdp-pds`) | https://registry.opendata.aws/noaa-gfs-bdp-pds/ |

### Storm scan vs StormScope

Notebook BoB wind threshold → optional `storm_alert.json` (UI unused). [StormScope](https://nvidia.github.io/earth2studio/main/examples/04_nowcasting/03_stormscope_goes_example/) is a different nowcasting product and is **out of scope**.

| Threshold source | What it says |
| --- | --- |
| [IMD terminology](https://rsmcnewdelhi.imd.gov.in/images/pdf/terminology.pdf) | Cyclonic storm: **34–47 knots (62–88 km/h)** |
| [WMO/ESCAP Panel TCP-21 (2021)](https://mausam.imd.gov.in/ptc/TCP/TCP2021.pdf) | Same 34-knot floor; Myanmar national table matches |
| [DMH Myanmar](https://www.moezala.gov.mm/) | National service — this repo does not replace DMH warnings |

### Attribution

Private office showcase code. FourCastNet, Earth2Studio, GFS, Esri tiles, and IMD/WMO documents stay under their own upstream licenses and terms.
