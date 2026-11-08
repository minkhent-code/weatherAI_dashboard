"""Build Myanmar-focused historical replay stores from NOAA IBTrACS and ONI."""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import shutil
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import zarr

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "models" / "HistoricalEvents"
CYCLONE_DIR = DATA_DIR / "cyclones"
ENSO_DIR = DATA_DIR / "enso"
DOWNLOAD_DIR = DATA_DIR / "downloads"
IBTRACS_ARCHIVE = DOWNLOAD_DIR / "ibtracs.ALL.list.v04r01.csv"
CATALOG_PATH = DATA_DIR / "catalog.json"
IBTRACS_URL = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.ALL.list.v04r01.csv"
)
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
MYANMAR_BOUNDS = {"north": 29.0, "south": 9.0, "west": 92.0, "east": 102.0}
SEASON_MONTH = {
    "DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6,
    "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12,
}
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")
DOWNLOAD_CHUNK_SIZE = 1024 * 1024


def _cached_download_is_valid(
    path: Path,
    url: str,
    required_columns: set[str] | None = None,
) -> bool:
    metadata_path = path.with_suffix(path.suffix + ".json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        size = path.stat().st_size
        if metadata.get("url") != url or metadata.get("size_bytes") != size or size == 0:
            return False
        if required_columns is None:
            return True
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            header = next(csv.reader(stream), [])
        return required_columns.issubset({name.strip() for name in header})
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def _download_file(
    url: str,
    destination: Path,
    label: str,
    timeout: int,
    required_columns: set[str] | None = None,
) -> Path:
    if _cached_download_is_valid(destination, url, required_columns):
        print(
            f"{label} already downloaded "
            f"({destination.stat().st_size / (1024 * 1024):.1f} MiB): {destination}",
            flush=True,
        )
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial_path = destination.with_suffix(destination.suffix + ".part")
    attempts = 4
    for attempt in range(1, attempts + 1):
        offset = partial_path.stat().st_size if partial_path.exists() else 0
        headers = {"User-Agent": "weatherAI-dashboard/1.0"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = Request(url, headers=headers)
        try:
            print(
                f"{label}: connecting to source"
                + (f" to resume at {offset / (1024 * 1024):.1f} MiB" if offset else "")
                + "...",
                flush=True,
            )
            with urlopen(request, timeout=timeout) as response:
                status = response.getcode()
                content_range = response.headers.get("Content-Range", "")
                if offset and status == 206:
                    match = re.match(r"bytes\s+(\d+)-\d+/(\d+|\*)", content_range)
                    if not match or int(match.group(1)) != offset:
                        raise OSError(
                            f"Server returned an invalid resume range: {content_range or 'missing'}"
                        )
                    total_size = int(match.group(2)) if match.group(2) != "*" else None
                    mode = "ab"
                else:
                    offset = 0
                    mode = "wb"
                    content_length = response.headers.get("Content-Length")
                    total_size = int(content_length) if content_length and content_length.isdigit() else None
                if status not in (200, 206):
                    raise OSError(f"Unexpected HTTP status {status} from {url}")

                started = time.monotonic()
                last_report_time = started
                last_report = 0
                downloaded = offset
                with partial_path.open(mode) as output:
                    while True:
                        chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                        if not chunk:
                            break
                        output.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if (
                            downloaded - last_report >= 8 * DOWNLOAD_CHUNK_SIZE
                            or now - last_report_time >= 2
                        ):
                            if total_size:
                                progress = min(100.0, downloaded * 100.0 / total_size)
                                message = (
                                    f"{label}: {downloaded / (1024 * 1024):.1f}/"
                                    f"{total_size / (1024 * 1024):.1f} MiB ({progress:.1f}%)"
                                )
                            else:
                                message = f"{label}: {downloaded / (1024 * 1024):.1f} MiB received"
                            print(message, flush=True)
                            last_report = downloaded
                            last_report_time = now
                    output.flush()

                actual_size = partial_path.stat().st_size
                if total_size is not None and actual_size != total_size:
                    raise OSError(
                        f"Incomplete transfer ({actual_size} of {total_size} bytes received)."
                    )
                partial_path.replace(destination)
                _atomic_json(destination.with_suffix(destination.suffix + ".json"), {
                    "url": url,
                    "size_bytes": actual_size,
                    "downloaded_utc": datetime.now(timezone.utc).isoformat(),
                })
                print(
                    f"{label}: download complete "
                    f"({actual_size / (1024 * 1024):.1f} MiB).",
                    flush=True,
                )
                return destination
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            if isinstance(error, HTTPError) and error.code == 416 and partial_path.exists():
                partial_path.unlink()
                if attempt < attempts:
                    print(
                        f"{label}: saved partial file cannot be resumed; restarting download.",
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
            if attempt == attempts:
                raise RuntimeError(
                    f"{label} download failed after {attempts} attempts. "
                    f"Partial data is preserved at {partial_path} and will resume on the next run. "
                    f"Last error: {error}"
                ) from error
            print(
                f"{label}: attempt {attempt}/{attempts} failed ({error}); "
                "retrying in 3 seconds...",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(3)

    raise RuntimeError(f"{label} download stopped unexpectedly.")


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(value, temporary, ensure_ascii=False, separators=(",", ":"))
            temporary.write("\n")
        temporary_path.replace(path)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def _number(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        try:
            value = float((row.get(key) or "").strip())
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value > -9000:
            return value
    return None


def _intensity_code(wind_knots: float | None) -> int:
    if wind_knots is None:
        return 7
    if wind_knots < 34:
        return 0
    if wind_knots < 64:
        return 1
    if wind_knots < 83:
        return 2
    if wind_knots < 96:
        return 3
    if wind_knots < 113:
        return 4
    if wind_knots < 137:
        return 5
    return 6


def _event_slug(name: str, suffix: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "event"
    return f"{slug[:72]}--{suffix}"


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _write_zarr_event(path: Path, attrs: dict[str, Any], arrays: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent))
    backup: Path | None = None
    try:
        group = zarr.open_group(str(staging), mode="w", zarr_format=3)
        group.attrs.update(attrs)
        for name, values in arrays.items():
            values = np.asarray(values)
            if values.ndim != 1 or values.size == 0:
                raise ValueError(f"Zarr event array {name!r} must be a non-empty 1D array.")
            group.create_array(
                name,
                data=values,
                chunks=(min(values.size, 256),),
                overwrite=True,
            )
        if path.exists():
            backup = path.with_name(f".{path.name}.{uuid.uuid4().hex}.bak")
            path.replace(backup)
        try:
            staging.replace(path)
        except Exception:
            if backup and backup.exists():
                if path.exists():
                    _remove_path(path)
                backup.replace(path)
                backup = None
            raise
        if backup:
            _remove_path(backup)
            backup = None
    finally:
        if staging.exists():
            _remove_path(staging)


def _point_in_myanmar_bounds(lat: float, lon: float) -> bool:
    return (
        MYANMAR_BOUNDS["south"] <= lat <= MYANMAR_BOUNDS["north"]
        and MYANMAR_BOUNDS["west"] <= lon <= MYANMAR_BOUNDS["east"]
    )


def _write_cyclone(storm: dict[str, Any], output_dir: Path) -> dict[str, Any] | None:
    points = sorted(storm["points"], key=lambda point: point["timestamp"])
    if not points or not any(_point_in_myanmar_bounds(point["lat"], point["lon"]) for point in points):
        return None

    start = points[0]["timestamp"]
    times = np.asarray([int(point["timestamp"].timestamp()) for point in points], dtype=np.int64)
    lead_hours = np.asarray(
        [int((point["timestamp"] - start).total_seconds() // 3600) for point in points],
        dtype=np.int32,
    )
    sid = storm["sid"]
    label = storm["name"]
    store_name = _event_slug(f"{label}-{storm['season']}", sid)
    store_path = output_dir / f"{store_name}.zarr"
    _write_zarr_event(
        store_path,
        {
            "schema": "historical-cyclone-v1",
            "id": sid,
            "name": label,
            "season": storm["season"],
            "label": f"{label} ({storm['season']})",
            "source": "NOAA/NCEI IBTrACS v04r01",
            "source_url": IBTRACS_URL,
            "tracking_method": (
                "Observed best track. The storm track intersects the Myanmar "
                "bounding box 9–29°N, 92–102°E."
            ),
            "initialization_utc": start.isoformat().replace("+00:00", "Z"),
        },
        {
            "valid_time_unix": times,
            "lead_hour": lead_hours,
            "latitude": np.asarray([point["lat"] for point in points], dtype=np.float32),
            "longitude": np.asarray([point["lon"] for point in points], dtype=np.float32),
            "wind_knots": np.asarray(
                [point["wind_knots"] if point["wind_knots"] is not None else np.nan for point in points],
                dtype=np.float32,
            ),
            "pressure_hpa": np.asarray(
                [point["pressure_hpa"] if point["pressure_hpa"] is not None else np.nan for point in points],
                dtype=np.float32,
            ),
            "rmw_nmi": np.asarray(
                [point["rmw_nmi"] if point["rmw_nmi"] is not None else np.nan for point in points],
                dtype=np.float32,
            ),
            "intensity_code": np.asarray(
                [_intensity_code(point["wind_knots"]) for point in points],
                dtype=np.uint8,
            ),
        },
    )
    return {
        "id": sid,
        "name": label,
        "season": storm["season"],
        "label": f"{label} ({storm['season']})",
        "start_utc": datetime.fromtimestamp(int(times[0]), timezone.utc).isoformat().replace("+00:00", "Z"),
        "end_utc": datetime.fromtimestamp(int(times[-1]), timezone.utc).isoformat().replace("+00:00", "Z"),
        "point_count": len(points),
        "store": f"cyclones/{store_name}.zarr",
    }


def process_ibtracs(stream: TextIO, output_dir: Path = CYCLONE_DIR) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    reader = csv.DictReader(stream, skipinitialspace=True)

    def finish_storm() -> None:
        if current:
            event = _write_cyclone(current, output_dir)
            if event:
                events.append(event)

    rows_scanned = 0
    for row_index, row in enumerate(reader, start=1):
        rows_scanned = row_index
        if row_index % 250_000 == 0:
            print(
                f"IBTrACS parsing: {row_index:,} rows scanned, "
                f"{len(events):,} Myanmar cyclone stores written...",
                flush=True,
            )
        sid = (row.get("SID") or "").strip()
        if current and sid != current["sid"]:
            finish_storm()
            current = None
        if not sid or not SAFE_ID.fullmatch(sid):
            continue
        try:
            season = int((row.get("SEASON") or "").strip())
            timestamp = datetime.strptime(
                (row.get("ISO_TIME") or "").strip(),
                "%Y-%m-%d %H:%M:%S",
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        lat, lon = _number(row, "LAT"), _number(row, "LON")
        if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 360:
            continue
        if current is None:
            name = (row.get("NAME") or "").strip().title()
            current = {
                "sid": sid,
                "name": name or f"Storm {sid}",
                "season": season,
                "points": [],
            }
        wind = _number(row, "WMO_WIND", "USA_WIND")
        pressure = _number(row, "WMO_PRES", "USA_PRES")
        rmw = _number(row, "USA_RMW")
        current["points"].append({
            "timestamp": timestamp,
            "lat": lat,
            "lon": ((lon + 180.0) % 360.0) - 180.0,
            "wind_knots": wind if wind is not None and wind >= 0 else None,
            "pressure_hpa": pressure if pressure is not None and pressure > 0 else None,
            "rmw_nmi": rmw if rmw is not None and rmw >= 0 else None,
        })
    finish_storm()

    if not events:
        raise ValueError(
            "IBTrACS contained no valid storms crossing the configured Myanmar bounds "
            "(9–29°N, 92–102°E)."
        )
    events.sort(key=lambda event: (event["start_utc"], event["id"]))
    print(
        f"IBTrACS parsing complete: {rows_scanned:,} "
        f"rows scanned, {len(events):,} Myanmar cyclone events.",
        flush=True,
    )
    return events


def normalize_oni(text: str) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 4 or parts[0] not in SEASON_MONTH:
            continue
        try:
            year = int(parts[1])
            sst, oni = float(parts[2]), float(parts[3])
        except ValueError:
            continue
        if not math.isfinite(sst) or not math.isfinite(oni) or abs(oni) >= 90:
            continue
        valid = datetime(year, SEASON_MONTH[parts[0]], 15, tzinfo=timezone.utc)
        records.append({
            "season": parts[0],
            "year": year,
            "timestamp": int(valid.timestamp()),
            "sst_c": round(sst, 2),
            "oni_c": round(oni, 2),
        })
    records.sort(key=lambda record: record["timestamp"])

    episodes: list[dict[str, Any]] = []
    run: list[dict[str, Any]] = []
    run_phase = ""
    previous_period: int | None = None
    for record in [*records, {}]:
        value = record.get("oni_c")
        phase = "El Niño" if value is not None and value >= 0.5 else (
            "La Niña" if value is not None and value <= -0.5 else ""
        )
        period = (
            int(record["year"]) * 12 + SEASON_MONTH[str(record["season"])]
            if value is not None else None
        )
        if period is not None and previous_period is not None and period != previous_period + 1:
            phase = ""
        if phase != run_phase:
            if len(run) >= 5:
                first, last = run[0], run[-1]
                episode_id = (
                    f"{'nino' if run_phase == 'El Niño' else 'nina'}-"
                    f"{first['year']}-{first['season'].lower()}"
                )
                episodes.append({
                    "id": episode_id,
                    "phase": run_phase,
                    "label": f"{run_phase} · {first['year']}–{last['year']}",
                    "start_utc": datetime.fromtimestamp(first["timestamp"], timezone.utc).isoformat().replace("+00:00", "Z"),
                    "end_utc": datetime.fromtimestamp(last["timestamp"], timezone.utc).isoformat().replace("+00:00", "Z"),
                    "points": run,
                })
            run = []
            run_phase = phase
        if phase:
            run.append(record)
        previous_period = period
    return {
        "source": "NOAA Climate Prediction Center Oceanic Niño Index (ONI)",
        "source_url": ONI_URL,
        "definition": (
            "El Niño and La Niña climate-context episodes are at least five consecutive "
            "overlapping seasons with ONI >= +0.5°C or <= -0.5°C. These are basin-scale "
            "Pacific indices, not Myanmar-local SST or rainfall observations."
        ),
        "episodes": episodes,
    }


def _write_enso(episode: dict[str, Any], output_dir: Path, source: str, source_url: str) -> dict[str, Any]:
    points = episode["points"]
    store_name = _event_slug(episode["label"], episode["id"])
    store_path = output_dir / f"{store_name}.zarr"
    _write_zarr_event(
        store_path,
        {
            "schema": "historical-enso-v1",
            "id": episode["id"],
            "phase": episode["phase"],
            "label": episode["label"],
            "source": source,
            "source_url": source_url,
            "tracking_method": (
                "NOAA ONI climate context: five consecutive overlapping seasons at "
                "ONI >= +0.5°C (El Niño) or <= -0.5°C (La Niña). This is not a "
                "Myanmar-local observation."
            ),
        },
        {
            "valid_time_unix": np.asarray([point["timestamp"] for point in points], dtype=np.int64),
            "season_code": np.asarray(
                [list(SEASON_MONTH).index(point["season"]) for point in points],
                dtype=np.uint8,
            ),
            "year": np.asarray([point["year"] for point in points], dtype=np.int16),
            "sst_c": np.asarray([point["sst_c"] for point in points], dtype=np.float32),
            "oni_c": np.asarray([point["oni_c"] for point in points], dtype=np.float32),
        },
    )
    return {
        "id": episode["id"],
        "phase": episode["phase"],
        "label": episode["label"],
        "start_utc": episode["start_utc"],
        "end_utc": episode["end_utc"],
        "point_count": len(points),
        "store": f"enso/{store_name}.zarr",
    }


def _read_catalog() -> dict[str, Any]:
    try:
        value = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {
            "schema": "historical-events-v1",
            "cyclones": [],
            "enso": [],
            "la_nina": [],
            "sources": {},
        }
    if not isinstance(value, dict):
        raise ValueError(f"Invalid event catalog at {CATALOG_PATH}")
    if not isinstance(value.get("sources", {}), dict):
        raise ValueError(f"Invalid event sources in catalog at {CATALOG_PATH}")
    for group_name in ("cyclones", "enso", "la_nina"):
        if not isinstance(value.get(group_name, []), list):
            raise ValueError(f"Invalid {group_name} group in catalog at {CATALOG_PATH}")
    return value


def download_cyclones() -> int:
    archive_path = _download_file(
        IBTRACS_URL,
        IBTRACS_ARCHIVE,
        "NOAA IBTrACS archive",
        timeout=60,
        required_columns={"SID", "SEASON", "ISO_TIME", "LAT", "LON"},
    )
    print(f"Processing archive and writing Myanmar cyclone Zarr stores to {CYCLONE_DIR}...", flush=True)
    with archive_path.open("r", encoding="utf-8-sig", newline="") as stream:
        events = process_ibtracs(stream)
    catalog = _read_catalog()
    catalog.update({
        "schema": "historical-events-v1",
        "region": {"name": "Myanmar", "bounds": MYANMAR_BOUNDS},
        "cyclones": events,
        "sources": {
            **catalog.get("sources", {}),
            "cyclones": {"name": "NOAA/NCEI IBTrACS v04r01", "url": IBTRACS_URL},
        },
    })
    _atomic_json(CATALOG_PATH, catalog)
    return len(events)


def download_enso() -> int:
    oni_path = _download_file(
        ONI_URL,
        DOWNLOAD_DIR / "oni.ascii.txt",
        "NOAA ONI index",
        timeout=60,
    )
    text = oni_path.read_text(encoding="utf-8")
    normalized = normalize_oni(text)
    if not normalized["episodes"]:
        raise ValueError("NOAA ONI download completed but contained no qualifying episodes.")
    ENSO_DIR.mkdir(parents=True, exist_ok=True)
    warm: list[dict[str, Any]] = []
    cold: list[dict[str, Any]] = []
    for episode in normalized["episodes"]:
        event = _write_enso(
            episode,
            ENSO_DIR,
            normalized["source"],
            normalized["source_url"],
        )
        (warm if episode["phase"] == "El Niño" else cold).append(event)
    catalog = _read_catalog()
    catalog.update({
        "schema": "historical-events-v1",
        "enso": warm,
        "la_nina": cold,
        "sources": {
            **catalog.get("sources", {}),
            "enso": {
                "name": normalized["source"],
                "url": normalized["source_url"],
                "definition": normalized["definition"],
            },
        },
    })
    _atomic_json(CATALOG_PATH, catalog)
    return len(normalized["episodes"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "dataset",
        nargs="?",
        choices=("all", "cyclones", "enso"),
        default="all",
        help="datasets to download; IBTrACS source archive is about 330 MB",
    )
    args = parser.parse_args()
    try:
        if args.dataset in ("all", "cyclones"):
            count = download_cyclones()
            print(f"Saved {count} Myanmar-relevant cyclone stores under {CYCLONE_DIR}", flush=True)
        if args.dataset in ("all", "enso"):
            count = download_enso()
            print(f"Saved {count} ONI climate-context stores under {ENSO_DIR}", flush=True)
        print(f"Event catalog: {CATALOG_PATH}", flush=True)
    except Exception as error:
        print(f"Historical event loading failed: {error}", file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    main()
