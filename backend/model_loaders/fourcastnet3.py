import numpy as np

from .parameters import parameter

MODEL_ID = "FourCastNet3"
LABEL = "Fourcastnet3"
SHORT = "FourCastNet3"

VARIABLES = {
    "t2m": {
        **parameter("Temperature 2 m", "မြေပြင်အထက် ၂ မီတာ အပူချိန်", "°C", "K", "RdYlBu_r", lambda a: a - 273.15),
        "source": "t2m",
    },
    "t500": {
        **parameter("Temperature 500 hPa", "၅၀၀ hPa အဆင့်ရှိ လေထုအပူချိန်", "°C", "K", "RdYlBu_r", lambda a: a - 273.15),
        "source": "t500",
    },
    "msl": {
        **parameter("Mean sea-level pressure", "ပင်လယ်ရေမျက်နှာပြင်ရှိ လေထုဖိအား", "hPa", "Pa", "RdYlBu_r", lambda a: a / 100.0),
        "source": "msl",
    },
    "q850": {
        **parameter("Specific humidity 850 hPa", "၈၅၀ hPa အဆင့်ရှိ သီးခြားစိုထိုင်းဆ", "g/kg", "kg/kg", "YlGnBu", lambda a: a * 1000.0),
        "source": "q850",
    },
    "tcwv": {
        **parameter("Total column water vapour", "လေထုတစ်လွှာလုံးရှိ ရေငွေ့စုစုပေါင်း", "kg/m²", "kg/m²", "YlGnBu"),
        "source": "tcwv",
    },
    "u10m": {
        **parameter("U-wind 10 m", "၁၀ မီတာအမြင့် အရှေ့-အနောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "u10m",
    },
    "v10m": {
        **parameter("V-wind 10 m", "၁၀ မီတာအမြင့် တောင်-မြောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "v10m",
    },
    "wind10m": {
        **parameter("Wind speed 10 m", "၁၀ မီတာအမြင့် လေတိုက်နှုန်း", "m/s", "m/s", "viridis", note="Derived from u10m and v10m"),
        "source": "wind10m",
        "compute": "wind_speed_10m",
        "requires": ("u10m", "v10m"),
    },
    "u100m": {
        **parameter("U-wind 100 m", "၁၀၀ မီတာအမြင့် အရှေ့-အနောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "u100m",
    },
    "v100m": {
        **parameter("V-wind 100 m", "၁၀၀ မီတာအမြင့် တောင်-မြောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "v100m",
    },
    "z500": {
        **parameter("Geopotential height 500 hPa", "၅၀၀ hPa အဆင့်ရှိ လေထုအမြင့်", "m", "m²/s²", "viridis", lambda a: a / 9.80665),
        "source": "z500",
    },
}
