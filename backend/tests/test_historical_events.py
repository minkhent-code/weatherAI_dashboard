from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import zarr
from fastapi.testclient import TestClient

from model_loaders import historical_events
import zarr_field_server


class FakeHttpResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int, headers: dict[str, str]) -> None:
        super().__init__(body)
        self.status = status
        self.headers = headers

    def getcode(self) -> int:
        return self.status

    def __enter__(self) -> "FakeHttpResponse":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class HistoricalEventLoaderTests(unittest.TestCase):
    def test_archive_download_reports_progress_and_reuses_verified_cache(self) -> None:
        body = b"SID,SEASON,ISO_TIME,LAT,LON\nstorm,2020,2020-01-01 00:00:00,10,95\n"
        response = FakeHttpResponse(body, 200, {"Content-Length": str(len(body))})
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "archive.csv"
            output = io.StringIO()
            with patch.object(historical_events, "urlopen", return_value=response) as open_url:
                with redirect_stdout(output):
                    historical_events._download_file(
                        "https://example.test/archive.csv",
                        destination,
                        "Test archive",
                        timeout=5,
                        required_columns={"SID", "SEASON", "ISO_TIME", "LAT", "LON"},
                    )
                    historical_events._download_file(
                        "https://example.test/archive.csv",
                        destination,
                        "Test archive",
                        timeout=5,
                        required_columns={"SID", "SEASON", "ISO_TIME", "LAT", "LON"},
                    )
            self.assertEqual(open_url.call_count, 1)
            self.assertEqual(destination.read_bytes(), body)
            self.assertIn("connecting to source", output.getvalue())
            self.assertIn("download complete", output.getvalue())
            self.assertIn("already downloaded", output.getvalue())

    def test_archive_download_resumes_partial_response(self) -> None:
        body = b"SID,SEASON,ISO_TIME,LAT,LON"
        split = 10
        response = FakeHttpResponse(
            body[split:],
            206,
            {"Content-Range": f"bytes {split}-{len(body) - 1}/{len(body)}"},
        )
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "archive.csv"
            partial = destination.with_suffix(destination.suffix + ".part")
            partial.write_bytes(body[:split])
            with patch.object(historical_events, "urlopen", return_value=response) as open_url:
                with redirect_stdout(io.StringIO()):
                    historical_events._download_file(
                        "https://example.test/archive.csv",
                        destination,
                        "Test archive",
                        timeout=5,
                    )
            request = open_url.call_args.args[0]
            self.assertEqual(request.get_header("Range"), f"bytes={split}-")
            self.assertEqual(destination.read_bytes(), body)

    def test_keeps_full_track_for_storm_that_enters_myanmar_bounds(self) -> None:
        csv_text = "\n".join([
            "SID,NAME,SEASON,ISO_TIME,LAT,LON,WMO_WIND,WMO_PRES,USA_RMW",
            "2023001N01001,MOCHA,2023,2023-05-10 00:00:00,8,90,30,1000,20",
            "2023001N01001,MOCHA,2023,2023-05-10 06:00:00,15,95,70,980,18",
            "2023002N01002,OUTSIDE,2023,2023-05-11 00:00:00,5,80,40,990,15",
        ])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = historical_events.process_ibtracs(
                io.StringIO(csv_text), root / "cyclones"
            )
            self.assertEqual([event["id"] for event in events], ["2023001N01001"])
            self.assertEqual(events[0]["point_count"], 2)

            group = zarr.open_group(str(root / events[0]["store"]), mode="r")
            self.assertEqual(group["latitude"][:].tolist(), [8.0, 15.0])
            self.assertEqual(group["intensity_code"][:].tolist(), [0, 2])

            historical_events.process_ibtracs(io.StringIO(csv_text), root / "cyclones")
            group = zarr.open_group(str(root / events[0]["store"]), mode="r")
            self.assertEqual(group["latitude"][:].tolist(), [8.0, 15.0])

    def test_requires_five_consecutive_oni_seasons(self) -> None:
        text = "\n".join([
            "DJF 2020 25.0 0.6",
            "FMA 2020 25.2 0.8",
            "MAM 2020 25.3 0.9",
            "AMJ 2020 25.4 1.0",
            "MJJ 2020 25.2 0.7",
        ])
        self.assertEqual(historical_events.normalize_oni(text)["episodes"], [])

        nina_text = "\n".join([
            "JJA 2021 23.0 -0.6",
            "JAS 2021 22.9 -0.7",
            "ASO 2021 22.8 -0.8",
            "SON 2021 22.7 -0.9",
            "OND 2021 22.6 -1.0",
        ])
        nina = historical_events.normalize_oni(nina_text)["episodes"]
        self.assertEqual(len(nina), 1)
        self.assertEqual(nina[0]["phase"], "La Niña")

    def test_zarr_stores_are_served_in_the_existing_replay_shape(self) -> None:
        csv_text = "\n".join([
            "SID,NAME,SEASON,ISO_TIME,LAT,LON,WMO_WIND,WMO_PRES,USA_RMW",
            "2023001N01001,MOCHA,2023,2023-05-10 00:00:00,15,95,70,980,18",
        ])
        oni_text = "\n".join([
            "DJF 2020 25.0 0.6",
            "JFM 2020 25.1 0.7",
            "FMA 2020 25.2 0.8",
            "MAM 2020 25.3 0.9",
            "AMJ 2020 25.4 1.0",
        ])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cyclone = historical_events.process_ibtracs(
                io.StringIO(csv_text), root / "cyclones"
            )[0]
            normalized = historical_events.normalize_oni(oni_text)
            enso = historical_events._write_enso(
                normalized["episodes"][0],
                root / "enso",
                normalized["source"],
                normalized["source_url"],
            )
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({
                "cyclones": [cyclone],
                "enso": [enso],
                "la_nina": [],
                "sources": {},
            }), encoding="utf-8")

            with (
                patch.object(zarr_field_server, "HISTORICAL_EVENTS_DIR", root),
                patch.object(zarr_field_server, "HISTORICAL_EVENTS_CATALOG", catalog_path),
                TestClient(zarr_field_server.app) as client,
            ):
                status_response = client.get("/api/history/status")
                self.assertEqual(status_response.json()["storage_format"], "historical-events-zarr-v1")
                cyclone_response = client.get(f"/api/history/cyclones/{cyclone['id']}")
                self.assertEqual(cyclone_response.status_code, 200)
                point = cyclone_response.json()["tracks"][0]["points"][0]
                self.assertEqual(point["intensity_label"], "1")
                self.assertEqual(point["wind_knots"], 70.0)

                enso_response = client.get(f"/api/history/enso/{enso['id']}")
                self.assertEqual(enso_response.status_code, 200)
                self.assertEqual(len(enso_response.json()["points"]), 5)

    def test_missing_catalog_is_reported_as_a_loader_instruction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            missing_catalog = Path(temporary) / "catalog.json"
            missing_mocha_store = Path(temporary) / "missing-mocha.zarr"
            with (
                patch.object(zarr_field_server, "HISTORICAL_EVENTS_CATALOG", missing_catalog),
                patch.object(zarr_field_server, "MOCHA_2023_STORE", missing_mocha_store),
            ):
                result = zarr_field_server.historical_events()
            self.assertFalse(result["ready"])
            self.assertIn("historical_events.py all", result["message"])

    def test_existing_mocha_model_zarr_is_listed_and_served_as_historical_event(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store_path = root / "CycloneMocha_2023" / "forecast.zarr"
            group = zarr.open_group(str(store_path), mode="w", zarr_format=2)
            group.attrs.update({
                "storm_id": "2023129N08091",
                "historical_source": "NOAA IBTrACS v04r01 / JTWC",
                "warning": "Synthetic fields are illustrative only.",
            })
            time = group.create_array("time", data=np.array([0, 3]), overwrite=True)
            time.attrs["units"] = "hours since 2023-05-08T18:00:00"
            for name, values in {
                "center_lat": [7.7, 8.0],
                "center_lon": [91.4, 92.0],
                "maximum_wind": [25, 40],
                "central_pressure": [1004, 998],
            }.items():
                group.create_array(name, data=np.asarray(values), overwrite=True)

            catalog_path = root / "missing-catalog.json"
            with (
                patch.object(zarr_field_server, "MOCHA_2023_STORE", store_path),
                patch.object(zarr_field_server, "HISTORICAL_EVENTS_CATALOG", catalog_path),
                patch.object(zarr_field_server, "HISTORICAL_EVENTS_DIR", root),
                TestClient(zarr_field_server.app) as client,
            ):
                catalog = client.get("/api/history/events").json()
                self.assertEqual(catalog["cyclones"][0]["id"], "CycloneMocha_2023")
                self.assertEqual(catalog["cyclones"][0]["point_count"], 2)

                replay = client.get("/api/history/cyclones/CycloneMocha_2023")
                self.assertEqual(replay.status_code, 200, replay.text)
                body = replay.json()
                self.assertEqual(body["tracks"][0]["points"][1]["wind_knots"], 40.0)
                self.assertEqual(body["tracks"][0]["points"][1]["valid_utc"], "2023-05-08T21:00:00Z")
                self.assertIn("synthetic", body["tracking_method"])


if __name__ == "__main__":
    unittest.main()
