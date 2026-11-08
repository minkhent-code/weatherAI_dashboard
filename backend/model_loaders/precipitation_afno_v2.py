from .parameters import parameter

MODEL_ID = "PrecipitationAFNOv2"
LABEL = "Precipitation AFNO v2"
SHORT = "Precipitation"

VARIABLES = {
    "tp06": {
        **parameter(
            "6-hour accumulated precipitation",
            "၆ နာရီအတွင်း စုစုပေါင်း မိုးရေချိန်",
            "mm",
            "mm",
            "YlGnBu",
            note="Six-hour accumulated precipitation",
        ),
        "source": "tp06",
    },
}
