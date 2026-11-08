"""
Local showcase zarr field API — reads local model stores from the project.
Serves /api/models, /api/meta, /api/timeseries, and /api/field.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import zarr
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from model_loaders import MODEL_LOADERS, MODEL_LOADERS_BY_ID
from model_loaders.mocha_ibtracs import LABEL as MOCHA_LABEL
from model_loaders.mocha_ibtracs import MODEL_ID as MOCHA_MODEL_ID
from model_loaders.mocha_ibtracs import TRACK_PATH as MOCHA_TRACK_PATH
from model_loaders.historical_events import (
    CATALOG_PATH as HISTORICAL_EVENTS_CATALOG,
    DATA_DIR as HISTORICAL_EVENTS_DIR,
    SEASON_MONTH as HISTORICAL_SEASON_MONTH,
)

# Local_NVIDIA_FourCastNet_Myanmar_AI_Weather_Showcase/
ROOT = Path(__file__).resolve().parents[1]
MOCHA_2023_STORE = ROOT / "models" / "CycloneMocha_2023" / "forecast.zarr"

REGIONS = {
    "global": {
        "label": "Global",
        "north": 90.0,
        "south": -90.0,
        "west": 0.0,
        "east": 359.75,
    },
    "sea_circle": {
        "label": "Sea circle domain",
        "north": 52.75,
        "south": -36.75,
        "west": 59.5,
        "east": 150.5,
    },
    "full_store": {
        "label": "Full store (SE Asia)",
        "north": 35.0,
        "south": -12.0,
        "west": 75.0,
        "east": 140.0,
    },
    "southeast_asia": {
        "label": "Southeast Asia",
        "north": 35.0,
        "south": -12.0,
        "west": 75.0,
        "east": 140.0,
    },
    "mainland_southeast_asia": {
        "label": "Mainland Southeast Asia",
        "north": 28.0,
        "south": 5.0,
        "west": 92.0,
        "east": 110.0,
    },
    "maritime_southeast_asia": {
        "label": "Maritime Southeast Asia",
        "north": 10.0,
        "south": -12.0,
        "west": 95.0,
        "east": 140.0,
    },
    "bay_of_bengal": {
        "label": "Bay of Bengal",
        "north": 25.0,
        "south": 3.0,
        "west": 80.0,
        "east": 100.0,
    },
    "andaman_sea": {
        "label": "Andaman Sea",
        "north": 17.0,
        "south": 4.0,
        "west": 91.0,
        "east": 100.0,
    },
    "myanmar": {
        "label": "Myanmar",
        "north": 28.6,
        "south": 9.5,
        "west": 92.0,
        "east": 101.2,
    },
}

MODELS: dict[str, dict[str, Any]] = {}


def _is_pangu_store(path: Path) -> bool:
    root_metadata = path / "zarr.json"
    temperature_metadata = path / "t1000" / "zarr.json"
    if not root_metadata.is_file() or not temperature_metadata.is_file():
        return False
    try:
        root = json.loads(root_metadata.read_text(encoding="utf-8"))
        temperature = json.loads(temperature_metadata.read_text(encoding="utf-8"))
        attrs = root.get("attributes", {})
        shape = temperature.get("shape", [])
        leads = attrs.get("forecast_lead_hours", [])
        return (
            root.get("node_type") == "group"
            and str(attrs.get("model", "")).lower() == "pangu6"
            and len(shape) == 4
            and shape[0] == 1
            and shape[1] == len(leads)
            and shape[2:] == [721, 1440]
            and bool(attrs.get("initialization_utc"))
            and bool(leads)
        )
    except (OSError, ValueError, TypeError):
        return False


def _read_zarr_metadata(path: Path) -> dict[str, Any] | None:
    for filename in ("zarr.json", ".zarray"):
        metadata_path = path / filename
        if not metadata_path.is_file():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if isinstance(metadata, dict):
            return metadata
    return None


def _array_shape(path: Path) -> tuple[int, ...] | None:
    metadata = _read_zarr_metadata(path)
    shape = metadata.get("shape") if metadata else None
    if not isinstance(shape, list) or not all(isinstance(size, int) for size in shape):
        return None
    return tuple(shape)


def _forecast_layout(
    shape: tuple[int, ...] | None,
    lead_count: int,
    lat_count: int,
    lon_count: int,
) -> str | None:
    if not shape or shape[-2:] != (lat_count, lon_count):
        return None
    if len(shape) == 3 and shape[0] == lead_count:
        return "lead_lat_lon"
    if len(shape) == 4 and shape[:2] == (1, lead_count):
        return "time_lead_lat_lon"
    if len(shape) == 5 and shape[1:3] == (1, lead_count):
        return "ens_time_lead_lat_lon"
    return None


def _forecast_arrays(path: Path) -> dict[str, str]:
    coord_names = {
        "lat", "lon", "lead_time", "forecast_hour", "time", "interval_start",
        "init_time", "ensemble",
    }
    lat_shape = _array_shape(path / "lat")
    lon_shape = _array_shape(path / "lon")
    lead_path = path / ("forecast_hour" if (path / "forecast_hour").exists() else "lead_time")
    lead_shape = _array_shape(lead_path)
    if not lat_shape or not lon_shape or not lead_shape:
        return {}

    lead_count = lead_shape[0] if lead_shape else 0
    lat_count = lat_shape[0]
    lon_count = lon_shape[0]
    arrays: dict[str, str] = {}
    for child in path.iterdir():
        if child.name in coord_names or not child.is_dir():
            continue
        layout = _forecast_layout(
            _array_shape(child), lead_count, lat_count, lon_count
        )
        if layout:
            arrays[child.name] = layout
    return arrays


def _is_zarr_store(path: Path) -> bool:
    if _is_pangu_store(path):
        return True
    root = _read_zarr_metadata(path)
    if root is None and not (path / ".zgroup").is_file():
        return False
    return bool(_forecast_arrays(path))


def _discover_models() -> None:
    """Load each supported local model through its dedicated model loader."""
    models_dir = ROOT / "models"
    discovered_ids: set[str] = set()
    if not models_dir.is_dir():
        return

    for loader in MODEL_LOADERS:
        model_id = loader.MODEL_ID
        folder = models_dir / model_id
        candidates = [folder / "forecast.zarr", folder]
        candidates.extend(sorted(folder.glob("*.zarr"), key=lambda item: item.name.lower()))
        store = next((candidate for candidate in candidates if _is_zarr_store(candidate)), None)
        if store is None:
            continue

        arrays = _forecast_arrays(store)
        if not arrays:
            continue
        available_variables = {
            name: config
            for name, config in loader.VARIABLES.items()
            if (
                all(required in arrays for required in config.get("requires", ()))
                if config.get("requires")
                else config["source"] in arrays
            )
        }
        if not available_variables:
            continue

        is_pangu = _is_pangu_store(store)
        layout = "time_lead_lat_lon" if is_pangu else next(iter(arrays.values()))
        source_relative = store.relative_to(ROOT).as_posix()
        MODELS[model_id] = {
            "id": model_id,
            "label": loader.LABEL,
            "short": loader.SHORT,
            "path": store,
            "source_relative": source_relative,
            "layout": layout,
            "ensemble_size": (
                _array_shape(store / next(iter(arrays)))[0]
                if layout == "ens_time_lead_lat_lon"
                else 1
            ),
            "has_ensemble": layout == "ens_time_lead_lat_lon",
            "reconstruct_lat": (90.0, -90.0) if is_pangu else None,
            "default_region": "global",
            "regions": ["global"],
            "variables": available_variables,
            "absent": sorted(set(loader.VARIABLES) - set(available_variables)),
            "notes": [f"Loaded with the {loader.MODEL_ID} model adapter."],
        }
        discovered_ids.add(model_id)

    for model_id, model in list(MODELS.items()):
        if model_id not in discovered_ids:
            del MODELS[model_id]


app = FastAPI(title="Local showcase zarr field API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_cache: dict[str, Any] = {}


def _read_local_json(path: Path, dataset_name: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise HTTPException(
            404,
            f"{dataset_name} data is not installed. Run "
            "'python backend/model_loaders/historical_events.py all'.",
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(500, f"Could not read {dataset_name} data: {error}") from error
    if not isinstance(value, dict):
        raise HTTPException(500, f"{dataset_name} data has an invalid format.")
    return value


def _get_model(model_id: str) -> dict[str, Any]:
    if model_id not in MODELS:
        _discover_models()
    if model_id not in MODELS:
        raise HTTPException(404, f"Unknown model: {model_id}")
    model = MODELS[model_id]
    if not _is_zarr_store(Path(model["path"])):
        raise HTTPException(404, f"Model store missing on disk: {model['source_relative']}")
    return model


def _open_coords(model_id: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, datetime]:
    key = f"coords:{model_id}"
    if key in _cache:
        return _cache[key]

    model = _get_model(model_id)
    zpath: Path = model["path"]
    if _is_pangu_store(zpath):
        root = zarr.open_group(str(zpath), mode="r")
        attrs = dict(root.attrs)
        sample = _open_array(model_id, "t1000")
        lat = np.linspace(90.0, -90.0, int(sample.shape[-2]))
        lon = np.arange(int(sample.shape[-1]), dtype=float) * (360.0 / int(sample.shape[-1]))
        lead_hours = np.asarray(attrs["forecast_lead_hours"], dtype=int)
        init_utc = datetime.fromisoformat(
            str(attrs["initialization_utc"]).replace("Z", "+00:00")
        ).astimezone(timezone.utc)
        _cache[key] = (lat, lon, lead_hours, init_utc)
        return _cache[key]

    lon = np.asarray(zarr.open(str(zpath / "lon"), mode="r"), dtype=float)
    lead_name = "forecast_hour" if (zpath / "forecast_hour").exists() else "lead_time"
    lead_array = zarr.open(str(zpath / lead_name), mode="r")
    lead = np.asarray(lead_array)
    time = np.asarray(zarr.open(str(zpath / "time"), mode="r"))
    sample_source = next(iter(model["variables"].values()))["source"]
    sample = _open_array(model_id, sample_source)

    if model["reconstruct_lat"]:
        north, south = model["reconstruct_lat"]
        lat = np.linspace(north, south, int(sample.shape[-2]))
    else:
        lat = np.asarray(zarr.open(str(zpath / "lat"), mode="r"), dtype=float)

    if np.issubdtype(lead.dtype, np.timedelta64):
        lead_hours = lead.astype("timedelta64[h]").astype(int)
    else:
        units = str(lead_array.attrs.get("units", "")).lower()
        dtype_hint = str(lead_array.attrs.get("dtype", "")).lower()
        if lead_name == "forecast_hour" or units.startswith("hour"):
            lead_hours = np.rint(lead.astype(float)).astype(int)
        elif units.startswith("minute"):
            lead_hours = np.rint(lead.astype(float) / 60.0).astype(int)
        elif units.startswith("second"):
            lead_hours = np.rint(lead.astype(float) / 3600.0).astype(int)
        elif units.startswith("day"):
            lead_hours = np.rint(lead.astype(float) * 24.0).astype(int)
        elif dtype_hint.startswith("timedelta64[") and dtype_hint.endswith("]"):
            delta_unit = dtype_hint.split("[", 1)[1][:-1]
            seconds_per_unit = {
                "d": 86400.0,
                "h": 3600.0,
                "m": 60.0,
                "s": 1.0,
                "ms": 0.001,
                "us": 0.000001,
                "ns": 0.000000001,
            }.get(delta_unit)
            if seconds_per_unit is None:
                raise HTTPException(500, f"Unsupported forecast lead dtype: {dtype_hint}")
            lead_hours = np.rint(
                lead.astype(float) * seconds_per_unit / 3600.0
            ).astype(int)
        else:
            lead_hours = lead.astype("timedelta64[h]").astype(int)

    attrs_path = zpath / ".zattrs"
    root_metadata = _read_zarr_metadata(zpath)
    root_attrs: dict[str, Any] = {}
    if attrs_path.is_file():
        try:
            parsed_attrs = json.loads(attrs_path.read_text(encoding="utf-8"))
            if isinstance(parsed_attrs, dict):
                root_attrs = parsed_attrs
        except (OSError, ValueError, TypeError):
            root_attrs = {}
    elif root_metadata and isinstance(root_metadata.get("attributes"), dict):
        root_attrs = root_metadata["attributes"]

    init_value = root_attrs.get("initialization_utc") or root_attrs.get("forecast_reference_time")
    if init_value:
        init_utc = datetime.fromisoformat(str(init_value).replace("Z", "+00:00"))
        if init_utc.tzinfo is None:
            init_utc = init_utc.replace(tzinfo=timezone.utc)
        else:
            init_utc = init_utc.astimezone(timezone.utc)
    else:
        init_utc = _decode_init_utc(time, zpath / "time")
    _cache[key] = (lat, lon, lead_hours, init_utc)
    return _cache[key]


def _decode_init_utc(time_vals: np.ndarray, time_path: Path) -> datetime:
    """Decode store time: native datetime64, or CF 'units' like 'days since …'."""
    arr = np.asarray(time_vals)
    if np.issubdtype(arr.dtype, np.datetime64):
        init_ns = int(arr.astype("datetime64[ns]").astype(np.int64).ravel()[0])
        return datetime.fromtimestamp(init_ns / 1e9, tz=timezone.utc)

    units = ""
    try:
        units = str(zarr.open(str(time_path), mode="r").attrs.get("units", "") or "")
    except Exception:
        units = ""
    # e.g. "days since 2026-11-04 00:00:00"
    if " since " in units:
        unit_name, origin = units.split(" since ", 1)
        origin = origin.strip().replace("T", " ")
        try:
            base = datetime.fromisoformat(origin[:19]).replace(tzinfo=timezone.utc)
        except ValueError:
            base = datetime(1970, 1, 1, tzinfo=timezone.utc)
        offset = float(np.asarray(arr).ravel()[0])
        unit_name = unit_name.strip().lower()
        if unit_name.startswith("day"):
            return base + timedelta(days=offset)
        if unit_name.startswith("hour"):
            return base + timedelta(hours=offset)
        if unit_name.startswith("second"):
            return base + timedelta(seconds=offset)
        return base + timedelta(days=offset)

    # Fallback: treat numeric as unix ns/s if already datetime-like failed
    init_ns = int(arr.astype("datetime64[ns]").astype(np.int64).ravel()[0])
    return datetime.fromtimestamp(init_ns / 1e9, tz=timezone.utc)


def _open_array(model_id: str, name: str):
    key = f"arr:{model_id}:{name}"
    if key not in _cache:
        path = _get_model(model_id)["path"] / name
        if not path.exists():
            raise HTTPException(404, f"Array not in {model_id}: {name}")
        if not (path / "zarr.json").exists() and not (path / ".zarray").exists():
            raise HTTPException(404, f"Incomplete zarr array (no metadata): {name}")
        _cache[key] = zarr.open(str(path), mode="r")
    return _cache[key]


def _array_is_available(model_id: str, name: str) -> bool:
    model = _get_model(model_id)
    path = model["path"] / name
    if not path.exists() or not (
        (path / "zarr.json").exists() or (path / ".zarray").exists()
    ):
        return False
    try:
        arr = _open_array(model_id, name)
        expected_dims = {
            "lead_lat_lon": 3,
            "time_lead_lat_lon": 4,
            "ens_time_lead_lat_lon": 5,
        }.get(model["layout"])
        if expected_dims is None:
            return False
        return len(arr.shape) == expected_dims and all(size > 0 for size in arr.shape)
    except (OSError, ValueError, TypeError, KeyError):
        return False


def _array_has_data(model_id: str, name: str) -> bool:
    key = f"has_data:{model_id}:{name}"
    if key not in _cache:
        _cache[key] = _array_is_available(model_id, name)
    return bool(_cache[key])


def _slice_2d(model_id: str, source: str, lead_idx: int, ensemble: str) -> np.ndarray:
    model = _get_model(model_id)
    arr = _open_array(model_id, source)
    layout = model["layout"]

    if layout == "lead_lat_lon":
        return np.asarray(arr[lead_idx, :, :], dtype=np.float32)
    if layout == "time_lead_lat_lon":
        return np.asarray(arr[0, lead_idx, :, :], dtype=np.float32)

    if layout != "ens_time_lead_lat_lon":
        raise HTTPException(500, f"Unsupported array layout for {model_id}: {layout}")

    if ensemble == "mean":
        acc = np.asarray(arr[0, 0, lead_idx, :, :], dtype=np.float64)
        n = int(arr.shape[0])
        for ei in range(1, n):
            acc += np.asarray(arr[ei, 0, lead_idx, :, :], dtype=np.float64)
        return (acc / n).astype(np.float32)

    try:
        ei = int(ensemble)
    except ValueError as exc:
        raise HTTPException(400, "ensemble must be 'mean' or an integer") from exc
    if ei < 0 or ei >= arr.shape[0]:
        raise HTTPException(400, f"ensemble index out of range 0..{arr.shape[0] - 1}")
    return np.asarray(arr[ei, 0, lead_idx, :, :], dtype=np.float32)


def _load_field(
    model_id: str, cfg: dict[str, Any], lead_idx: int, ensemble: str
) -> np.ndarray:
    compute = cfg.get("compute")
    cache_key = f"field:{model_id}:{cfg.get('source')}:{compute}:{lead_idx}:{ensemble}"
    if cache_key in _cache:
        return _cache[cache_key]

    if compute == "wind_speed_10m":
        u = _slice_2d(model_id, "u10m", lead_idx, ensemble)
        v = _slice_2d(model_id, "v10m", lead_idx, ensemble)
        out = np.sqrt(u * u + v * v).astype(np.float32)
    else:
        out = _slice_2d(model_id, cfg["source"], lead_idx, ensemble)

    _cache[cache_key] = out
    return out


def _read_grid_tile(
    model_id: str,
    source: str,
    lead_idx: int,
    ensemble: str,
    row_start: int,
    row_end: int,
    col_start: int,
    col_end: int,
) -> np.ndarray:
    model = _get_model(model_id)
    arr = _open_array(model_id, source)
    layout = model["layout"]
    if layout == "lead_lat_lon":
        return np.asarray(
            arr[lead_idx, row_start:row_end, col_start:col_end],
            dtype=np.float32,
        )
    if layout == "time_lead_lat_lon":
        return np.asarray(
            arr[0, lead_idx, row_start:row_end, col_start:col_end],
            dtype=np.float32,
        )
    if layout != "ens_time_lead_lat_lon":
        raise HTTPException(500, f"Unsupported array layout for {model_id}: {layout}")

    def read_member(member: int) -> np.ndarray:
        return np.asarray(
            arr[member, 0, lead_idx, row_start:row_end, col_start:col_end],
            dtype=np.float32,
        )

    if ensemble != "mean":
        try:
            member = int(ensemble)
        except ValueError as exc:
            raise HTTPException(400, "ensemble must be 'mean' or an integer") from exc
        if member < 0 or member >= arr.shape[0]:
            raise HTTPException(
                400, f"ensemble index out of range 0..{arr.shape[0] - 1}"
            )
        return read_member(member)

    total = read_member(0).astype(np.float64)
    for member in range(1, int(arr.shape[0])):
        total += read_member(member)
    return (total / int(arr.shape[0])).astype(np.float32)


def _read_variable_tile(
    model_id: str,
    cfg: dict[str, Any],
    lead_idx: int,
    ensemble: str,
    row_start: int,
    row_end: int,
    col_start: int,
    col_end: int,
) -> np.ndarray:
    if cfg.get("compute") == "wind_speed_10m":
        u = _read_grid_tile(
            model_id, "u10m", lead_idx, ensemble,
            row_start, row_end, col_start, col_end,
        )
        v = _read_grid_tile(
            model_id, "v10m", lead_idx, ensemble,
            row_start, row_end, col_start, col_end,
        )
        raw = np.sqrt(u * u + v * v)
    else:
        raw = _read_grid_tile(
            model_id, cfg["source"], lead_idx, ensemble,
            row_start, row_end, col_start, col_end,
        )
    return cfg["convert"](raw)


def _model_regions(model: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for rid in model["regions"]:
        r = REGIONS[rid]
        out[rid] = {
            "label": r["label"],
            "north": r["north"],
            "south": r["south"],
            "west": r["west"],
            "east": r["east"],
        }
    return out


@app.get("/api/health")
def health() -> dict[str, Any]:
    _discover_models()
    return {
        "ok": bool(MODELS) or MOCHA_TRACK_PATH.is_file(),
        "available_models": [
            *MODELS,
            *([MOCHA_MODEL_ID] if MOCHA_TRACK_PATH.is_file() else []),
        ],
    }


@app.get("/api/models")
def list_models() -> dict[str, Any]:
    _discover_models()
    items = []
    for mid, m in MODELS.items():
        if not _is_zarr_store(Path(m["path"])):
            continue
        items.append({
            "id": mid,
            "label": m["label"],
            "short": m["short"],
            "source_relative": m["source_relative"],
            "available": True,
            "has_ensemble": m["has_ensemble"],
            "default_region": m["default_region"],
        })
    if MOCHA_TRACK_PATH.is_file():
        items.append({
            "id": MOCHA_MODEL_ID,
            "label": MOCHA_LABEL,
            "short": "Mocha",
            "source_relative": MOCHA_TRACK_PATH.relative_to(ROOT).as_posix(),
            "available": True,
            "has_ensemble": False,
            "default_region": "global",
        })
    default_model = items[0]["id"] if items else ""
    return {"default": default_model, "models": items}


@app.get("/api/meta")
def meta(model: str = Query("FourCastNet3")) -> dict[str, Any]:
    m = _get_model(model)
    lat, lon, lead_hours, init_utc = _open_coords(model)
    present_dirs = sorted(d.name for d in Path(m["path"]).iterdir() if d.is_dir())

    var_status: dict[str, Any] = {}
    available: list[str] = []
    empty_placeholder: list[str] = []

    for name, cfg in m["variables"].items():
        if cfg.get("compute") == "wind_speed_10m":
            has_data = _array_has_data(model, "u10m") and _array_has_data(model, "v10m")
            exists = has_data
            has_meta = has_data
        else:
            source = cfg["source"]
            path = Path(m["path"]) / source
            exists = path.exists()
            has_meta = (
                (path / "zarr.json").exists() or (path / ".zarray").exists()
            ) if exists else False
            has_data = _array_has_data(model, source) if has_meta else False

        status = {
            "label": cfg["label"],
            "label_mm": cfg["label_mm"],
            "unit": cfg["unit"],
            "native": cfg["native"],
            "source_array": cfg["source"],
            "exists": exists,
            "has_metadata": has_meta,
            "has_data": has_data,
            "available": has_data,
            "cmap": cfg["cmap"],
            "note": cfg.get("note"),
        }
        var_status[name] = status
        if has_data:
            available.append(name)
        elif exists:
            empty_placeholder.append(name)

    return {
        "model": model,
        "model_label": m["label"],
        "model_short": m["short"],
        "source": str(m["path"]),
        "source_relative": m["source_relative"],
        "has_ensemble": m["has_ensemble"],
        "initialization_utc": init_utc.isoformat(),
        "lead_hours": [int(h) for h in lead_hours],
        "lat_range": [float(lat.min()), float(lat.max())],
        "lon_range": [float(lon.min()), float(lon.max())],
        "grid_shape": [int(lat.size), int(lon.size)],
        "ensemble_size": m["ensemble_size"],
        "default_region": m["default_region"],
        "regions": _model_regions(m),
        "variables": var_status,
        "available_variables": available,
        "empty_placeholder_arrays": empty_placeholder,
        "absent_from_store": m["absent"],
        "store_directories": present_dirs,
        "notes": m["notes"],
        "models": [
            {
                "id": mid,
                "label": mm["label"],
                "short": mm["short"],
                "available": _is_zarr_store(Path(mm["path"])),
            }
            for mid, mm in MODELS.items()
        ],
    }


@app.get("/api/cyclones/tracks")
def cyclone_tracks(model: str = Query("WeatherNext2Cyclones")) -> dict[str, Any]:
    if model == MOCHA_MODEL_ID:
        if not MOCHA_TRACK_PATH.is_file():
            raise HTTPException(
                404,
                "Cyclone Mocha data is missing. Run "
                "'python backend/model_loaders/mocha_ibtracs.py' to download it.",
            )
        try:
            return json.loads(MOCHA_TRACK_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise HTTPException(500, f"Could not read Cyclone Mocha data: {error}") from error
    if model != "WeatherNext2Cyclones":
        raise HTTPException(404, "Cyclone tracking is only available for WeatherNext2Cyclones")
    m = _get_model(model)
    required_arrays = {
        "cyclone_exists_gaussian_unit_mode",
        "cyclone_usa_wind_disc",
        "cyclone_usa_pres_disc",
        "cyclone_usa_rmw_disc",
    }
    missing_arrays = required_arrays - m["variables"].keys()
    if missing_arrays:
        raise HTTPException(
            404,
            f"Cyclone tracking arrays unavailable: {', '.join(sorted(missing_arrays))}",
        )

    cache_key = f"cyclone_tracks:{model}"
    if cache_key in _cache:
        return _cache[cache_key]

    lat, lon, lead_hours, init_utc = _open_coords(model)
    existence = _open_array(model, "cyclone_exists_gaussian_unit_mode")
    wind = _open_array(model, "cyclone_usa_wind_disc")
    pressure = _open_array(model, "cyclone_usa_pres_disc")
    rmw = _open_array(model, "cyclone_usa_rmw_disc")

    loader = MODEL_LOADERS_BY_ID[model]
    detections = []
    for index, lead_hour in enumerate(lead_hours):
        detections.append(loader.detect_frame(
            existence=np.asarray(existence[index, :, :], dtype=np.float32),
            wind=np.asarray(wind[index, :, :], dtype=np.float32),
            pressure=np.asarray(pressure[index, :, :], dtype=np.float32),
            rmw=np.asarray(rmw[index, :, :], dtype=np.float32),
            lat=lat,
            lon=lon,
            lead_hour=int(lead_hour),
            initialization_utc=init_utc,
        ))
    tracks = loader.link_detections(detections)
    result = {
        "model": model,
        "initialization_utc": init_utc.isoformat(),
        "lead_hours": [int(hour) for hour in lead_hours],
        "tracks": tracks,
        "tracking_method": "Tracks are derived from local maxima in the gridded cyclone-existence field.",
    }
    _cache[cache_key] = result
    return result


@app.get("/api/history/events")
def historical_events() -> dict[str, Any]:
    try:
        catalog = json.loads(HISTORICAL_EVENTS_CATALOG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        catalog = {}
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(500, f"Could not read historical event catalog: {error}") from error
    if not isinstance(catalog, dict):
        raise HTTPException(500, "Historical event catalog has an invalid format.")

    cyclone_events = catalog.get("cyclones", [])
    enso_episodes = catalog.get("enso", [])
    la_nina_episodes = catalog.get("la_nina", [])
    if not all(isinstance(events, list) for events in (cyclone_events, enso_episodes, la_nina_episodes)):
        raise HTTPException(500, "Historical event catalog has invalid event groups.")
    if any(
        not isinstance(event, dict) or not isinstance(event.get("id"), str)
        or not isinstance(event.get("store"), str)
        for events in (cyclone_events, enso_episodes, la_nina_episodes)
        for event in events
    ):
        raise HTTPException(500, "Historical event catalog contains an invalid event entry.")
    mocha_track = _read_mocha_2023_track()
    if mocha_track and not any(event.get("id") == "CycloneMocha_2023" for event in cyclone_events):
        mocha_points = mocha_track["tracks"][0]["points"]
        cyclone_events = [
            *cyclone_events,
            {
                "id": "CycloneMocha_2023",
                "name": "Cyclone Mocha",
                "season": 2023,
                "label": "Cyclone Mocha (2023)",
                "start_utc": mocha_points[0]["valid_utc"],
                "end_utc": mocha_points[-1]["valid_utc"],
                "point_count": len(mocha_points),
                "source": "models/CycloneMocha_2023/forecast.zarr",
            },
        ]
    sources = catalog.get("sources", {})
    if not isinstance(sources, dict):
        sources = {}
    return {
        "cyclones": cyclone_events,
        "enso": enso_episodes,
        "la_nina": la_nina_episodes,
        "ready": bool(cyclone_events or enso_episodes or la_nina_episodes),
        "message": "" if catalog else (
            "Cyclone Mocha is loaded from models/CycloneMocha_2023; run "
            "'python backend/model_loaders/historical_events.py all' to load additional events."
            if mocha_track else
            "No local historical event catalog. Run "
            "'python backend/model_loaders/historical_events.py all'."
        ),
        "sources": {
            "cyclones": sources.get("cyclones", {}).get("name", "")
            if isinstance(sources.get("cyclones"), dict) else "",
            "enso": sources.get("enso", {}).get("name", "")
            if isinstance(sources.get("enso"), dict) else "",
        },
    }


@app.get("/api/history/status")
def historical_status() -> dict[str, str]:
    return {"storage_format": "historical-events-zarr-v1"}


def _historical_event_store(
    event_type: str,
    event_id: str,
) -> tuple[dict[str, Any], zarr.Group]:
    if not event_id or any(
        character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for character in event_id
    ):
        raise HTTPException(400, "Invalid historical event ID.")
    try:
        catalog = json.loads(HISTORICAL_EVENTS_CATALOG.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise HTTPException(
            404,
            "Historical events are not installed. Run "
            "'python backend/model_loaders/historical_events.py all'.",
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(500, f"Could not read historical event catalog: {error}") from error

    group_name = {"cyclone": "cyclones", "enso": "enso"}.get(event_type)
    if not group_name or not isinstance(catalog, dict):
        raise HTTPException(500, "Historical event catalog has an invalid format.")
    events = catalog.get(group_name, [])
    if not isinstance(events, list):
        raise HTTPException(500, "Historical event catalog contains an invalid event group.")
    events = list(events)
    if event_type == "enso":
        la_nina_events = catalog.get("la_nina", [])
        if not isinstance(la_nina_events, list):
            raise HTTPException(500, "Historical event catalog contains an invalid event group.")
        events.extend(la_nina_events)
    if not isinstance(events, list) or not all(isinstance(item, dict) for item in events):
        raise HTTPException(500, "Historical event catalog contains an invalid event group.")
    event = next((item for item in events if item.get("id") == event_id), None)
    if event is None:
        raise HTTPException(404, f"Historical {event_type} event not found: {event_id}")

    store_relative = event.get("store")
    if not isinstance(store_relative, str):
        raise HTTPException(500, f"Historical event {event_id} has no Zarr store path.")
    data_root = HISTORICAL_EVENTS_DIR.resolve()
    store_path = (data_root / store_relative).resolve()
    if data_root not in store_path.parents or store_path.suffix != ".zarr":
        raise HTTPException(500, f"Historical event {event_id} has an unsafe Zarr store path.")
    if not store_path.is_dir():
        raise HTTPException(404, f"Historical event store is missing: {store_relative}")
    try:
        group = zarr.open_group(str(store_path), mode="r")
    except Exception as error:
        raise HTTPException(500, f"Could not open historical event store: {error}") from error
    return event, group


def _historical_array(group: zarr.Group, name: str) -> np.ndarray:
    if name not in group:
        raise HTTPException(500, f"Historical event store is missing array {name!r}.")
    values = np.asarray(group[name][:])
    if values.ndim != 1:
        raise HTTPException(500, f"Historical event array {name!r} must be one-dimensional.")
    return values


def _event_timestamp(value: int) -> str:
    return datetime.fromtimestamp(int(value), timezone.utc).isoformat().replace("+00:00", "Z")


def _optional_number(value: float) -> float | None:
    return round(float(value), 1) if np.isfinite(value) else None


def _read_mocha_2023_track() -> dict[str, Any] | None:
    if not MOCHA_2023_STORE.is_dir():
        return None
    try:
        group = zarr.open_group(str(MOCHA_2023_STORE), mode="r")
        required = ("time", "center_lat", "center_lon", "maximum_wind", "central_pressure")
        missing = [name for name in required if name not in group]
        if missing:
            raise HTTPException(
                500,
                f"Cyclone Mocha Zarr store is missing arrays: {', '.join(missing)}.",
            )
        time_array = group["time"]
        times = np.asarray(time_array[:])
        latitudes = np.asarray(group["center_lat"][:])
        longitudes = np.asarray(group["center_lon"][:])
        winds = np.asarray(group["maximum_wind"][:])
        pressures = np.asarray(group["central_pressure"][:])
        if times.ndim != 1 or not times.size or len({
            len(times), len(latitudes), len(longitudes), len(winds), len(pressures)
        }) != 1:
            raise HTTPException(500, "Cyclone Mocha Zarr track arrays are empty or mismatched.")
        time_units = str(time_array.attrs.get("units", ""))
        match = re.fullmatch(r"\s*hours since\s+(.+?)\s*", time_units, re.IGNORECASE)
        if not match:
            raise HTTPException(
                500,
                f"Cyclone Mocha time coordinate has unsupported units: {time_units or 'missing'}.",
            )
        origin_text = match.group(1).replace("Z", "+00:00")
        try:
            origin = datetime.fromisoformat(origin_text)
        except ValueError as error:
            raise HTTPException(500, f"Invalid Cyclone Mocha time origin: {origin_text}") from error
        if origin.tzinfo is None:
            origin = origin.replace(tzinfo=timezone.utc)
        else:
            origin = origin.astimezone(timezone.utc)

        storm_id = str(group.attrs.get("storm_id", "mocha-2023"))
        points = []
        for index, value in enumerate(times):
            valid = origin + timedelta(hours=float(value))
            wind = float(winds[index])
            pressure = float(pressures[index])
            points.append({
                "lead_hour": int(round(float(value))),
                "valid_utc": valid.isoformat().replace("+00:00", "Z"),
                "lat": round(float(latitudes[index]), 3),
                "lon": round(float(longitudes[index]) % 360, 3),
                "existence_signal": 1.0,
                "wind_knots": _optional_number(wind),
                "pressure_hpa": _optional_number(pressure),
                "rmw_nmi": None,
                "intensity_label": _intensity_label(wind),
            })
        attrs = group.attrs
        return {
            "model": "CycloneMocha_2023",
            "model_label": "Cyclone Mocha (2023)",
            "initialization_utc": points[0]["valid_utc"],
            "lead_hours": [point["lead_hour"] for point in points],
            "tracks": [{
                "id": storm_id,
                "label": "Cyclone Mocha",
                "points": points,
            }],
            "tracking_method": (
                "Observed cyclone center, maximum wind, and central pressure from the "
                "local CycloneMocha_2023 Zarr store. Wind fields in the store are synthetic."
            ),
            "source": str(attrs.get("historical_source", "Local CycloneMocha_2023 Zarr store")),
            "source_url": "",
        }
    except HTTPException:
        raise
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise HTTPException(500, f"Could not read Cyclone Mocha Zarr track: {error}") from error


def _intensity_label(wind_knots: float | None) -> str:
    if wind_knots is None or not np.isfinite(wind_knots):
        return "—"
    if wind_knots < 34:
        return "TD"
    if wind_knots < 64:
        return "TS"
    if wind_knots < 83:
        return "1"
    if wind_knots < 96:
        return "2"
    if wind_knots < 113:
        return "3"
    if wind_knots < 137:
        return "4"
    return "5"


@app.get("/api/history/cyclones/{storm_id}")
def historical_cyclone(storm_id: str) -> dict[str, Any]:
    if storm_id == "CycloneMocha_2023":
        track = _read_mocha_2023_track()
        if track is None:
            raise HTTPException(404, "models/CycloneMocha_2023/forecast.zarr was not found.")
        return track
    event, group = _historical_event_store("cyclone", storm_id)
    times = _historical_array(group, "valid_time_unix")
    lead_hours = _historical_array(group, "lead_hour")
    latitudes = _historical_array(group, "latitude")
    longitudes = _historical_array(group, "longitude")
    winds = _historical_array(group, "wind_knots")
    pressures = _historical_array(group, "pressure_hpa")
    rmws = _historical_array(group, "rmw_nmi")
    intensities = _historical_array(group, "intensity_code")
    lengths = {
        len(times), len(lead_hours), len(latitudes), len(longitudes),
        len(winds), len(pressures), len(rmws), len(intensities),
    }
    if len(lengths) != 1 or not len(times):
        raise HTTPException(500, f"Historical cyclone store {storm_id} has mismatched arrays.")
    points = []
    for index in range(len(times)):
        intensity_index = int(intensities[index])
        points.append({
            "lead_hour": int(lead_hours[index]),
            "valid_utc": _event_timestamp(int(times[index])),
            "lat": round(float(latitudes[index]), 3),
            "lon": round(float(longitudes[index]), 3),
            "existence_signal": 1.0,
            "wind_knots": _optional_number(winds[index]),
            "pressure_hpa": _optional_number(pressures[index]),
            "rmw_nmi": _optional_number(rmws[index]),
            "intensity_label": (
                ("TD", "TS", "1", "2", "3", "4", "5", "—")[intensity_index]
                if 0 <= intensity_index <= 7 else "—"
            ),
        })
    attrs = group.attrs
    return {
        "model": "HistoricalEvents",
        "model_label": event.get("label", attrs.get("label", "Historical cyclone")),
        "initialization_utc": attrs.get("initialization_utc", points[0]["valid_utc"]),
        "lead_hours": [point["lead_hour"] for point in points],
        "tracks": [{
            "id": storm_id,
            "label": event.get("name", attrs.get("name", event.get("label", storm_id))),
            "points": points,
        }],
        "tracking_method": attrs.get("tracking_method", ""),
        "source": attrs.get("source", ""),
        "source_url": attrs.get("source_url", ""),
    }


@app.get("/api/history/enso/{episode_id}")
def historical_enso(episode_id: str) -> dict[str, Any]:
    event, group = _historical_event_store("enso", episode_id)
    times = _historical_array(group, "valid_time_unix")
    season_codes = _historical_array(group, "season_code")
    years = _historical_array(group, "year")
    sst = _historical_array(group, "sst_c")
    oni = _historical_array(group, "oni_c")
    if len({len(times), len(season_codes), len(years), len(sst), len(oni)}) != 1 or not len(times):
        raise HTTPException(500, f"Historical ENSO store {episode_id} has mismatched arrays.")
    season_names = list(HISTORICAL_SEASON_MONTH)
    if any(int(code) >= len(season_names) for code in season_codes):
        raise HTTPException(500, f"Historical ENSO store {episode_id} has invalid season codes.")
    points = []
    for index in range(len(times)):
        season = season_names[int(season_codes[index])]
        points.append({
            "season": season,
            "year": int(years[index]),
            "valid_utc": _event_timestamp(int(times[index])),
            "sst_c": round(float(sst[index]), 2),
            "oni_c": round(float(oni[index]), 2),
        })
    attrs = group.attrs
    return {
        "model": "HistoricalEvents",
        "model_label": event.get("phase", attrs.get("phase", "ENSO context")),
        "id": episode_id,
        "phase": event.get("phase", attrs.get("phase", "")),
        "label": event.get("label", attrs.get("label", episode_id)),
        "start_utc": event.get("start_utc", points[0]["valid_utc"]),
        "end_utc": event.get("end_utc", points[-1]["valid_utc"]),
        "points": points,
        "tracking_method": attrs.get("tracking_method", ""),
        "source": attrs.get("source", ""),
        "source_url": attrs.get("source_url", ""),
    }


def _unwrap_lon_grid(values: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Reorder a lon axis from 0..360 into ascending -180..180 for MapLibre."""
    lon = np.asarray(lon, dtype=float)
    if float(np.nanmax(lon)) <= 180.0 + 1e-9:
        return values, lon.copy()
    wrapped = np.where(lon > 180.0, lon - 360.0, lon)
    order = np.argsort(wrapped)
    return values[:, order], wrapped[order]


def _parse_bbox(
    bbox: str | None, region_bounds: dict[str, float]
) -> dict[str, float]:
    if not bbox:
        return {
            "west": float(region_bounds["west"]),
            "south": float(region_bounds["south"]),
            "east": float(region_bounds["east"]),
            "north": float(region_bounds["north"]),
        }
    try:
        parts = [float(x.strip()) for x in bbox.split(",")]
    except ValueError as exc:
        raise HTTPException(400, "bbox must be west,south,east,north") from exc
    if len(parts) != 4:
        raise HTTPException(400, "bbox must be west,south,east,north")
    west, south, east, north = parts
    if south >= north:
        raise HTTPException(400, "bbox south must be < north")
    return {"west": west, "south": south, "east": east, "north": north}


def _lon_span(west: float, east: float) -> float:
    if east >= west:
        return east - west
    return (180.0 - west) + (east + 180.0)


def _geo_extent_from_axes(lats: np.ndarray, lons: np.ndarray) -> dict[str, float]:
    """Outer edges of the grid cells represented by these lat/lon *centers*.

    Latitudes are clamped to [-90, 90] — MapLibre image sources reject anything
    outside that range (half-cell padding on a global grid otherwise yields ±90.375).
    """
    dlat = float(abs(lats[0] - lats[1])) if lats.size > 1 else 0.25
    dlon = float(abs(lons[1] - lons[0])) if lons.size > 1 else 0.25
    lat_n = float(max(lats[0], lats[-1]))
    lat_s = float(min(lats[0], lats[-1]))
    lon_w = float(min(lons[0], lons[-1]))
    lon_e = float(max(lons[0], lons[-1]))
    return {
        "north": min(90.0, lat_n + dlat / 2.0),
        "south": max(-90.0, lat_s - dlat / 2.0),
        "west": max(-180.0, lon_w - dlon / 2.0),
        "east": min(180.0, lon_e + dlon / 2.0),
    }


def _downsample_grid(
    crop: np.ndarray, lats: np.ndarray, lons: np.ndarray, max_side: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[int]]:
    stride_y = max(1, int(np.ceil(crop.shape[0] / max_side)))
    stride_x = max(1, int(np.ceil(crop.shape[1] / max_side)))
    return (
        crop[::stride_y, ::stride_x],
        lats[::stride_y],
        lons[::stride_x],
        [stride_y, stride_x],
    )


def _pack_part(
    part_id: str, crop: np.ndarray, lats: np.ndarray, lons: np.ndarray, max_side: int
) -> dict[str, Any] | None:
    if crop.size == 0 or lats.size < 2 or lons.size < 2:
        return None
    # Downsample first, then georeference from the *kept* cell centers.
    # Using full-res outer edges with a strided image stretches content north.
    crop, lats, lons, stride = _downsample_grid(crop, lats, lons, max_side)
    if lats.size < 2 or lons.size < 2:
        return None
    # MapLibre image row 0 is the north edge — flip if the crop is south→north.
    if float(lats[0]) < float(lats[-1]):
        crop = crop[::-1]
        lats = lats[::-1]
    if float(lons[0]) > float(lons[-1]):
        crop = crop[:, ::-1]
        lons = lons[::-1]
    extent = _geo_extent_from_axes(lats, lons)
    return {
        "id": part_id,
        "geo_extent": extent,
        "lats": [round(float(x), 4) for x in lats],
        "lons": [round(float(x), 4) for x in lons],
        "values": np.round(crop, 2).tolist(),
        "shape": [int(crop.shape[0]), int(crop.shape[1])],
        "stride": stride,
    }


def _slice_lat_lon(
    values: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    north: float,
    south: float,
    west: float,
    east: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lat_mask = (lat <= north + 1e-9) & (lat >= south - 1e-9)
    if east >= west:
        lon_mask = (lon >= west - 1e-9) & (lon <= east + 1e-9)
    else:
        # antimeridian-crossing request: keep both side ranges
        lon_mask = (lon >= west - 1e-9) | (lon <= east + 1e-9)
    if not lat_mask.any() or not lon_mask.any():
        return (
            np.empty((0, 0), dtype=np.float32),
            lat[lat_mask],
            lon[lon_mask],
        )
    return values[np.ix_(lat_mask, lon_mask)], lat[lat_mask], lon[lon_mask]


def _nearest_index(axis: np.ndarray, value: float) -> int:
    return int(np.argmin(np.abs(axis.astype(float) - float(value))))


@app.get("/api/timeseries")
def timeseries(
    model: str = Query("FourCastNet3"),
    variable: str = Query("t2m"),
    ensemble: str = Query("mean"),
    points: str = Query(
        ...,
        description="Semicolon-separated name:lat:lon (e.g. Yangon:16.8:96.15;Mandalay:21.97:96.08)",
    ),
) -> dict[str, Any]:
    """Nearest-grid timeseries for city charts (all lead hours × many points)."""
    m = _get_model(model)
    variables: dict[str, dict[str, Any]] = m["variables"]
    if variable not in variables:
        raise HTTPException(404, f"Unknown variable for {model}: {variable}")
    cfg = variables[variable]
    if cfg.get("compute") == "wind_speed_10m":
        ok = _array_has_data(model, "u10m") and _array_has_data(model, "v10m")
    else:
        ok = _array_has_data(model, cfg["source"])
    if not ok:
        raise HTTPException(404, f"{variable} has no usable data in {model}")

    if not m["has_ensemble"]:
        ensemble = "0"

    parsed: list[tuple[str, float, float]] = []
    for chunk in points.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split(":")
        if len(parts) != 3:
            raise HTTPException(400, "points must be name:lat:lon;name:lat:lon;...")
        name, lat_s, lon_s = parts
        try:
            parsed.append((name.strip(), float(lat_s), float(lon_s)))
        except ValueError as exc:
            raise HTTPException(400, f"bad point '{chunk}'") from exc
    if not parsed:
        raise HTTPException(400, "no points provided")

    lat, lon, lead_hours, init_utc = _open_coords(model)
    lon_wrapped = np.where(lon > 180.0, lon - 360.0, lon)
    lon_order = np.argsort(lon_wrapped)
    lon_disp = lon_wrapped[lon_order]

    point_idx: list[tuple[str, int, int, float, float]] = []
    for name, plat, plon in parsed:
        ri = _nearest_index(lat, plat)
        display_ci = _nearest_index(lon_disp, plon)
        point_idx.append((name, ri, int(lon_order[display_ci]), plat, plon))

    source = "u10m" if cfg.get("compute") == "wind_speed_10m" else cfg["source"]
    arr = _open_array(model, source)
    row_chunk, col_chunk = (int(size) for size in arr.chunks[-2:])
    grouped_points: dict[tuple[int, int], list[tuple[str, int, int]]] = {}
    for name, ri, ci, _plat, _plon in point_idx:
        key = (ri // row_chunk, ci // col_chunk)
        grouped_points.setdefault(key, []).append((name, ri, ci))

    series: dict[str, list[float]] = {name: [] for name, *_ in point_idx}
    for lead_idx in range(len(lead_hours)):
        for (row_chunk_idx, col_chunk_idx), members in grouped_points.items():
            row_start = row_chunk_idx * row_chunk
            col_start = col_chunk_idx * col_chunk
            row_end = min(row_start + row_chunk, len(lat))
            col_end = min(col_start + col_chunk, len(lon))
            tile = _read_variable_tile(
                model,
                cfg,
                lead_idx,
                ensemble,
                row_start,
                row_end,
                col_start,
                col_end,
            )
            for name, ri, ci in members:
                series[name].append(
                    round(float(tile[ri - row_start, ci - col_start]), 2)
                )

    return {
        "model": model,
        "variable": variable,
        "label": cfg["label"],
        "unit": cfg["unit"],
        "ensemble": ensemble if m["has_ensemble"] else "deterministic",
        "initialization_utc": init_utc.isoformat(),
        "lead_hours": [int(x) for x in lead_hours.tolist()],
        "points": [
            {
                "name": name,
                "lat": plat,
                "lon": plon,
                "grid_lat": round(float(lat[_nearest_index(lat, plat)]), 4),
                "grid_lon": round(float(lon_disp[_nearest_index(lon_disp, plon)]), 4),
            }
            for name, _ri, _ci, plat, plon in point_idx
        ],
        "series": series,
    }


@app.get("/api/field")
def field(
    model: str = Query("FourCastNet3"),
    variable: str = Query("t2m"),
    region: str = Query("southeast_asia"),
    lead_hour: int = Query(0),
    ensemble: str = Query("mean"),
    bbox: str | None = Query(
        None, description="Optional west,south,east,north in degrees (-180..180)"
    ),
) -> dict[str, Any]:
    m = _get_model(model)
    if region not in m["regions"] or region not in REGIONS:
        raise HTTPException(400, f"Unknown region for {model}: {region}")
    variables: dict[str, dict[str, Any]] = m["variables"]
    if variable not in variables:
        raise HTTPException(404, f"Unknown variable for {model}: {variable}")

    cfg = variables[variable]
    if cfg.get("compute") == "wind_speed_10m":
        ok = _array_has_data(model, "u10m") and _array_has_data(model, "v10m")
    else:
        ok = _array_has_data(model, cfg["source"])
    if not ok:
        raise HTTPException(
            404,
            f"{variable} has no usable data in {model} "
            f"(source '{cfg['source']}' missing or all zeros)",
        )

    if not m["has_ensemble"]:
        ensemble = "0"

    lat, lon, lead_hours, init_utc = _open_coords(model)
    region_bounds = REGIONS[region]
    bounds = _parse_bbox(bbox, region_bounds)

    # Normalize global region stored as 0..359.75 into display -180..180
    if region == "global" and not bbox:
        bounds = {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}

    lead_idxs = np.where(lead_hours == lead_hour)[0]
    if lead_idxs.size == 0:
        raise HTTPException(400, f"lead_hour {lead_hour} not in {model}")
    li = int(lead_idxs[0])

    raw = _load_field(model, cfg, li, ensemble)
    values = cfg["convert"](raw)
    values, lon_disp = _unwrap_lon_grid(values, lon)

    span = _lon_span(bounds["west"], bounds["east"])
    # Dual hemisphere when covering (almost) the whole world
    use_dual = span >= 180.0 - 1e-6 or (
        region == "global" and bbox is None
    )
    # Higher resolution so zoom-in still shows the full field, georeferenced
    max_side = 360 if use_dual else 720
    sample_side = 256 if use_dual else 384

    parts: list[dict[str, Any]] = []
    if use_dual:
        west_crop, west_lats, west_lons = _slice_lat_lon(
            values,
            lat,
            lon_disp,
            bounds["north"],
            bounds["south"],
            -180.0,
            -1e-9,
        )
        east_crop, east_lats, east_lons = _slice_lat_lon(
            values,
            lat,
            lon_disp,
            bounds["north"],
            bounds["south"],
            0.0,
            180.0,
        )
        for pid, c, la, lo in (
            ("a", west_crop, west_lats, west_lons),
            ("b", east_crop, east_lats, east_lons),
        ):
            packed = _pack_part(pid, c, la, lo, max_side)
            if packed:
                parts.append(packed)
        # Sampling grid: stitch both hemispheres in lon order
        sample_crop, sample_lats, sample_lons = _slice_lat_lon(
            values,
            lat,
            lon_disp,
            bounds["north"],
            bounds["south"],
            -180.0,
            180.0,
        )
    else:
        crop, lats, lons = _slice_lat_lon(
            values,
            lat,
            lon_disp,
            bounds["north"],
            bounds["south"],
            bounds["west"],
            bounds["east"],
        )
        if crop.size == 0:
            raise HTTPException(400, "Region/bbox does not intersect store grid")
        packed = _pack_part("a", crop, lats, lons, max_side)
        if not packed:
            raise HTTPException(400, "Region/bbox too small after crop")
        parts = [packed]
        sample_crop, sample_lats, sample_lons = crop, lats, lons

    if not parts:
        raise HTTPException(400, "No drawable field parts for request")

    # Coarse sample grid for probes/cities only (overlays use parts)
    sample_crop, sample_lats, sample_lons, sample_stride = _downsample_grid(
        sample_crop, sample_lats, sample_lons, max_side=sample_side
    )
    sample_extent = _geo_extent_from_axes(
        np.asarray(sample_lats, dtype=float), np.asarray(sample_lons, dtype=float)
    )

    valid = sample_crop[np.isfinite(sample_crop)]
    vmin = float(np.min(valid)) if valid.size else 0.0
    vmax = float(np.max(valid)) if valid.size else 1.0
    # Shared color scale across parts
    for p in parts:
        flat = np.asarray(p["values"], dtype=float).ravel()
        flat = flat[np.isfinite(flat)]
        if flat.size:
            vmin = min(vmin, float(flat.min()))
            vmax = max(vmax, float(flat.max()))

    valid_time = init_utc + timedelta(hours=int(lead_hour))
    display_bounds = {
        "north": bounds["north"],
        "south": bounds["south"],
        "west": bounds["west"] if not use_dual else -180.0,
        "east": bounds["east"] if not use_dual else 180.0,
    }

    return {
        "model": model,
        "model_label": m["label"],
        "source": m["source_relative"],
        "variable": variable,
        "label": cfg["label"],
        "unit": cfg["unit"],
        "cmap": cfg["cmap"],
        "note": cfg.get("note"),
        "region": region,
        "region_label": region_bounds["label"],
        "bounds": display_bounds,
        "geo_extent": sample_extent if len(parts) == 1 else {
            "north": parts[0]["geo_extent"]["north"],
            "south": parts[0]["geo_extent"]["south"],
            "west": -180.0,
            "east": 180.0,
        },
        "parts": parts,
        "lead_hour": lead_hour,
        "ensemble": ensemble if m["has_ensemble"] else "deterministic",
        "initialization_utc": init_utc.isoformat(),
        "valid_utc": valid_time.isoformat(),
        "lats": [round(float(x), 4) for x in sample_lats],
        "lons": [round(float(x), 4) for x in sample_lons],
        "values": np.round(sample_crop, 2).tolist(),
        "vmin": round(vmin, 2),
        "vmax": round(vmax, 2),
        "shape": [int(sample_crop.shape[0]), int(sample_crop.shape[1])],
        "stride": sample_stride,
        "dual": use_dual,
        "bbox": display_bounds,
    }


if __name__ == "__main__":
    import uvicorn

    import os

    port = int(os.environ.get("ZARR_API_PORT", "8766"))
    _discover_models()
    print(f"[zarr-api] Serving {len(MODELS)} discovered model(s) on :{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)
