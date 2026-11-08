import numpy as np

from .parameters import parameter

MODEL_ID = "Pangu-Weather"
LABEL = "Pangu Weather"
SHORT = "Pangu"

VARIABLES = {
    "msl": {
        **parameter("Mean sea-level pressure", "ပင်လယ်ရေမျက်နှာပြင်ရှိ လေထုဖိအား", "hPa", "Pa", "RdYlBu_r", lambda a: a / 100.0),
        "source": "msl",
    },
    "t2m": {
        **parameter("Temperature 2 m", "မြေပြင်အထက် ၂ မီတာ အပူချိန်", "°C", "K", "RdYlBu_r", lambda a: a - 273.15),
        "source": "t2m",
    },
    "u10m": {
        **parameter("U-wind 10 m", "၁၀ မီတာအမြင့် အရှေ့-အနောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "u10m",
    },
    "v10m": {
        **parameter("V-wind 10 m", "၁၀ မီတာအမြင့် တောင်-မြောက် လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
        "source": "v10m",
    },
}

for level in (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000):
    VARIABLES[f"t{level}"] = {
        **parameter(f"Temperature {level} hPa", f"{level} hPa အဆင့်ရှိ လေထုအပူချိန်", "°C", "K", "RdYlBu_r", lambda a: a - 273.15),
        "source": f"t{level}",
    }

for level in (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000):
    VARIABLES[f"q{level}"] = {
        **parameter(f"Specific humidity {level} hPa", f"{level} hPa အဆင့်ရှိ သီးခြားစိုထိုင်းဆ", "g/kg", "kg/kg", "YlGnBu", lambda a: a * 1000.0),
        "source": f"q{level}",
    }

for component, direction in (("u", "အရှေ့-အနောက်"), ("v", "တောင်-မြောက်")):
    for level in (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000):
        VARIABLES[f"{component}{level}"] = {
            **parameter(f"{component.upper()}-wind {level} hPa", f"{level} hPa အဆင့်ရှိ {direction} လေတိုက်နှုန်း", "m/s", "m/s", "RdBu_r"),
            "source": f"{component}{level}",
        }

for level in (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000):
    VARIABLES[f"z{level}"] = {
        **parameter(f"Geopotential height {level} hPa", f"{level} hPa အဆင့်ရှိ လေထုအမြင့်", "m", "m²/s²", "viridis", lambda a: a / 9.80665),
        "source": f"z{level}",
    }
