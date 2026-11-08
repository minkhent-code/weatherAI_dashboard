from . import (
    fourcastnet3,
    pangu_weather,
    precipitation_afno_v2,
    weather_next_2_cyclones,
    wind_gust_afno,
)

MODEL_LOADERS = (
    fourcastnet3,
    precipitation_afno_v2,
    pangu_weather,
    wind_gust_afno,
    weather_next_2_cyclones,
)

MODEL_LOADERS_BY_ID = {loader.MODEL_ID: loader for loader in MODEL_LOADERS}
