from .parameters import parameter

MODEL_ID = "WindGustAFNO"
LABEL = "Wind Gust AFNO"
SHORT = "Wind Gust"

VARIABLES = {
    "fg10m": {
        **parameter(
            "10 m wind gust",
            "၁၀ မီတာအမြင့် လေပြင်းတိုက်ခတ်မှု အမြန်နှုန်း",
            "m/s",
            "m/s",
            "magma",
            note="Six-hourly diagnostic gust estimate",
        ),
        "source": "fg10m",
    },
}
