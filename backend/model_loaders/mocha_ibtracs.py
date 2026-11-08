"""Download and normalize Cyclone Mocha's IBTrACS best track."""

from __future__ import annotations

import csv
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen

MODEL_ID = "CycloneMocha"
LABEL = "Cyclone Mocha (IBTrACS)"
SHORT = "Mocha"
SOURCE_URL = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.since1980.list.v04r01.csv"
)
ROOT = Path(__file__).resolve().parents[2]
TRACK_PATH = ROOT / "models" / MODEL_ID / "track.json"


def _number(row: dict[str, str], *columns: str) -> float | None:
    for column in columns:
        value = row.get(column, "").strip()
        if not value:
            continue
        try:
            number = float(value)
        except ValueError:
            continue
        if math.isfinite(number) and number > -9000:
            return number
    return None


def normalize_rows(rows: Iterable[dict[str, str]]) -> dict[str, Any]:
    observations: dict[datetime, dict[str, Any]] = {}
    storm_id = ""

    for row in rows:
        if row.get("SEASON", "").strip() != "2023":
            continue
        if row.get("NAME", "").strip().casefold() != "mocha":
            continue
        sid = row.get("SID", "").strip()
        if storm_id and sid and sid != storm_id:
            continue
        if sid:
            storm_id = sid

        try:
            timestamp = datetime.strptime(
                row["ISO_TIME"].strip(), "%Y-%m-%d %H:%M:%S"
            ).replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue

        lat = _number(row, "LAT")
        lon = _number(row, "LON")
        if (
            lat is None
            or lon is None
            or not -90 <= lat <= 90
            or not -180 <= lon <= 360
        ):
            continue

        wind = _number(row, "WMO_WIND", "USA_WIND")
        pressure = _number(row, "WMO_PRES", "USA_PRES")
        rmw = _number(row, "USA_RMW")
        if wind is not None and wind < 0:
            wind = None
        if pressure is not None and pressure <= 0:
            pressure = None
        if rmw is not None and rmw < 0:
            rmw = None
        observations[timestamp] = {
            "valid_utc": timestamp.isoformat().replace("+00:00", "Z"),
            "lat": round(lat, 3),
            "lon": round(lon % 360, 3),
            "existence_signal": 1.0,
            "wind_knots": round(wind, 1) if wind is not None else None,
            "pressure_hpa": round(pressure, 1) if pressure is not None else None,
            "rmw_nmi": round(rmw, 1) if rmw is not None else None,
            "intensity_label": _intensity_label(wind),
        }

    if not observations:
        raise ValueError("Cyclone Mocha (2023) was not found in the IBTrACS CSV.")

    first_time = min(observations)
    points = []
    for timestamp, observation in sorted(observations.items()):
        lead_hour = int((timestamp - first_time).total_seconds() // 3600)
        points.append({"lead_hour": lead_hour, **observation})

    return {
        "model": MODEL_ID,
        "model_label": LABEL,
        "initialization_utc": first_time.isoformat().replace("+00:00", "Z"),
        "lead_hours": [point["lead_hour"] for point in points],
        "tracks": [{
            "id": "mocha-2023",
            "label": "Cyclone Mocha",
            "points": points,
        }],
        "tracking_method": "Observed best track from NOAA/NCEI IBTrACS v04r01.",
        "source": "NOAA/NCEI IBTrACS v04r01",
        "source_url": SOURCE_URL,
        "storm_id": storm_id,
    }


def download_track(output_path: Path = TRACK_PATH) -> dict[str, Any]:
    request = Request(SOURCE_URL, headers={"User-Agent": "weatherAI-dashboard/1.0"})
    with urlopen(request, timeout=120) as response:
        rows = csv.DictReader(
            (line.decode("utf-8-sig") for line in response),
            skipinitialspace=True,
        )
        track = normalize_rows(rows)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        json.dump(track, temporary, ensure_ascii=False, indent=2)
        temporary.write("\n")
    temporary_path.replace(output_path)
    return track


def _intensity_label(wind_knots: float | None) -> str:
    if wind_knots is None:
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


if __name__ == "__main__":
    result = download_track()
    print(f"Saved {len(result['tracks'][0]['points'])} observations to {TRACK_PATH}")
