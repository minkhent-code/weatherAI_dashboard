from datetime import datetime, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Any

import numpy as np

from .parameters import parameter

MODEL_ID = "WeatherNext2Cyclones"
LABEL = "WeatherNext 2 Cyclones"
SHORT = "WeatherNext Cyclones"
MIN_EXISTENCE_SIGNAL = 0.35
MIN_TRACK_SEPARATION_KM = 250.0
MAX_TRACK_SPEED_KMH = 55.0
TRACK_LINK_MARGIN_KM = 100.0

VARIABLES = {
    "cyclone_exists_gaussian_unit_mode": {
        **parameter(
            "Cyclone existence field",
            "ဆိုင်ကလုန်းတည်ရှိနိုင်မှု အညွှန်း",
            "0–1",
            "0–1",
            "inferno",
            note="Gridded cyclone-existence field; values closer to 1 indicate stronger existence signal.",
        ),
        "source": "cyclone_exists_gaussian_unit_mode",
    },
    "cyclone_usa_pres_disc": {
        **parameter("Cyclone central pressure", "ဆိုင်ကလုန်းဗဟို လေဖိအား", "hPa", "hPa", "viridis"),
        "source": "cyclone_usa_pres_disc",
    },
    "cyclone_usa_wind_disc": {
        **parameter("USA maximum sustained wind", "အမြင့်ဆုံး တည်ငြိမ်လေတိုက်နှုန်း", "kn", "kn", "magma"),
        "source": "cyclone_usa_wind_disc",
    },
    "cyclone_all_wind_disc": {
        **parameter("All-agency maximum sustained wind", "အေဂျင်စီအားလုံးမှ ပေါင်းစပ်ထားသော အမြင့်ဆုံးလေတိုက်နှုန်း", "kn", "kn", "magma"),
        "source": "cyclone_all_wind_disc",
    },
    "cyclone_usa_rmw_disc": {
        **parameter("Radius of maximum wind", "အမြင့်ဆုံးလေတိုက်နှုန်း ရှိသော အကွာအဝေး", "nmi", "nmi", "plasma"),
        "source": "cyclone_usa_rmw_disc",
    },
}

_QUADRANTS = {
    "ne": "အရှေ့မြောက်",
    "nw": "အနောက်မြောက်",
    "se": "အရှေ့တောင်",
    "sw": "အနောက်တောင်",
}

for threshold in (34, 50, 64):
    for quadrant, direction in _QUADRANTS.items():
        variable = f"cyclone_usa_r{threshold}_{quadrant}_radius_disc"
        VARIABLES[variable] = {
            **parameter(
                f"{threshold}-kn wind radius {quadrant.upper()}",
                f"{threshold} kn လေတိုက်နှုန်း အချင်းဝက် ({direction} ဘက်)",
                "nmi",
                "nmi",
                "plasma",
            ),
            "source": variable,
        }


def _finite_value(values: np.ndarray, row: int, column: int) -> float | None:
    value = float(values[row, column])
    return value if np.isfinite(value) else None


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1_rad, lat2_rad = radians(lat1), radians(lat2)
    delta_lat = lat2_rad - lat1_rad
    delta_lon = radians((lon2 - lon1 + 180.0) % 360.0 - 180.0)
    haversine = (
        sin(delta_lat / 2.0) ** 2
        + cos(lat1_rad) * cos(lat2_rad) * sin(delta_lon / 2.0) ** 2
    )
    return 6371.0 * 2.0 * asin(sqrt(min(1.0, haversine)))


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


def detect_frame(
    *,
    existence: np.ndarray,
    wind: np.ndarray,
    pressure: np.ndarray,
    rmw: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    lead_hour: int,
    initialization_utc: datetime,
) -> list[dict[str, Any]]:
    """Find strong local centers in one cyclone-existence forecast frame."""
    field = np.asarray(existence, dtype=np.float32)
    safe = np.where(np.isfinite(field), field, -np.inf)
    local_maximum = safe.copy()

    for row_offset in (-1, 0, 1):
        for column_offset in (-1, 0, 1):
            if row_offset == 0 and column_offset == 0:
                continue
            neighbor = np.roll(safe, (row_offset, column_offset), axis=(0, 1))
            if row_offset < 0:
                neighbor[row_offset:, :] = -np.inf
            elif row_offset > 0:
                neighbor[:row_offset, :] = -np.inf
            local_maximum = np.maximum(local_maximum, neighbor)

    rows, columns = np.where(
        (safe >= MIN_EXISTENCE_SIGNAL) & (safe >= local_maximum)
    )
    if not rows.size:
        return []

    order = np.argsort(safe[rows, columns])[::-1]
    detections: list[dict[str, Any]] = []
    for candidate in order:
        row, column = int(rows[candidate]), int(columns[candidate])
        center_lat = float(lat[row])
        center_lon = float(lon[column] % 360.0)
        if any(
            _distance_km(center_lat, center_lon, point["lat"], point["lon"])
            < MIN_TRACK_SEPARATION_KM
            for point in detections
        ):
            continue

        wind_knots = _finite_value(wind, row, column)
        detections.append({
            "lead_hour": lead_hour,
            "valid_utc": (
                initialization_utc + timedelta(hours=lead_hour)
            ).isoformat(),
            "lat": round(center_lat, 3),
            "lon": round(center_lon, 3),
            "existence_signal": round(float(safe[row, column]), 3),
            "wind_knots": round(wind_knots, 1) if wind_knots is not None else None,
            "pressure_hpa": (
                round(value, 1)
                if (value := _finite_value(pressure, row, column)) is not None
                else None
            ),
            "rmw_nmi": (
                round(value, 1)
                if (value := _finite_value(rmw, row, column)) is not None
                else None
            ),
            "intensity_label": _intensity_label(wind_knots),
        })
        if len(detections) == 20:
            break
    return detections


def link_detections(
    frames: list[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Link detections using predicted motion and one-to-one frame assignments."""
    tracks: list[list[dict[str, Any]]] = []
    for detections in frames:
        candidates: list[tuple[float, int, int]] = []
        for track_index, track in enumerate(tracks):
            previous = track[-1]
            for detection_index, point in enumerate(detections):
                lead_gap = point["lead_hour"] - previous["lead_hour"]
                if lead_gap <= 0 or lead_gap > 12:
                    continue

                predicted_lat = previous["lat"]
                predicted_lon = previous["lon"]
                if len(track) > 1:
                    earlier = track[-2]
                    prior_gap = previous["lead_hour"] - earlier["lead_hour"]
                    if prior_gap > 0:
                        scale = lead_gap / prior_gap
                        lon_delta = (
                            (previous["lon"] - earlier["lon"] + 180.0) % 360.0
                        ) - 180.0
                        predicted_lat += (previous["lat"] - earlier["lat"]) * scale
                        predicted_lon = (previous["lon"] + lon_delta * scale) % 360.0

                distance = _distance_km(
                    point["lat"], point["lon"], predicted_lat, predicted_lon
                )
                max_distance = MAX_TRACK_SPEED_KMH * lead_gap + TRACK_LINK_MARGIN_KM
                if distance <= max_distance:
                    candidates.append((distance / max_distance, track_index, detection_index))

        used_tracks: set[int] = set()
        used_detections: set[int] = set()
        for _cost, track_index, detection_index in sorted(candidates):
            if track_index in used_tracks or detection_index in used_detections:
                continue
            tracks[track_index].append(detections[detection_index])
            used_tracks.add(track_index)
            used_detections.add(detection_index)

        for detection_index, point in enumerate(detections):
            if detection_index not in used_detections:
                tracks.append([point])

    completed_tracks = [track for track in tracks if len(track) >= 2]
    return [
        {
            "id": f"storm-{index + 1:02d}",
            "label": f"မုန်တိုင်း {index + 1}",
            "points": track,
        }
        for index, track in enumerate(completed_tracks)
    ]
