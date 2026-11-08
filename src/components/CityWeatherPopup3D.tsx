import React, { useEffect, useState } from 'react';
import { CityInfo } from '../types/forecast';
import { BURMESE_STRINGS, toBurmeseNumber, BURMESE_CITIES_MAP } from '../utils/burmese';
import { getStepTimeWindow } from '../utils/forecastTime';
import { X, Thermometer, Wind } from 'lucide-react';
import { fetchZarrMeta, fetchZarrTimeseries } from '../services/zarrApi';

interface CityWeatherPopup3DProps {
  city: CityInfo;
  modelId: string;
  currentStepIndex: number;
  onClose: () => void;
  /** Kept for call-site compatibility; city is already selected when the popup opens */
  onSelectCity?: (city: CityInfo) => void;
  isSelectedCity?: boolean;
}

interface CityWeatherSeries {
  leadHours: number[];
  validTimesUtc: string[];
  temperatureC: number[];
  windKmh: number[];
  pressureHpa: number[];
  totalColumnWaterVapour: number[];
}

export const CityWeatherPopup3D: React.FC<CityWeatherPopup3DProps> = ({
  city,
  modelId,
  currentStepIndex,
  onClose,
}) => {
  const [weatherSeries, setWeatherSeries] = useState<CityWeatherSeries | null>(null);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setWeatherSeries(null);
    setLoadError('');
    setIsLoading(true);

    const loadCityForecast = async () => {
      try {
        const meta = await fetchZarrMeta(modelId, controller.signal);
        const requiredVariables = ['t2m', 'wind10m'];
        const missingVariables = requiredVariables.filter(
          (variable) => !meta.available_variables.includes(variable)
        );
        if (missingVariables.length) {
          throw new Error(`Forecast data is missing: ${missingVariables.join(', ')}`);
        }

        const optionalVariables = ['msl', 'tcwv'].filter(
          (variable) => meta.available_variables.includes(variable)
        );
        const variables = [...requiredVariables, ...optionalVariables];
        const responses = await Promise.all(variables.map((variable) =>
          fetchZarrTimeseries({
            modelId,
            variable,
            points: [{ name: city.name, lat: city.lat, lon: city.lon }],
            signal: controller.signal,
          })
        ));
        if (controller.signal.aborted) return;

        const seriesByVariable = Object.fromEntries(
          variables.map((variable, index) => [
            variable,
            responses[index].series[city.name] ?? [],
          ])
        );
        const init = new Date(meta.initialization_utc);
        if (Number.isNaN(init.getTime())) {
          throw new Error('Forecast initialization time is invalid.');
        }

        setWeatherSeries({
          leadHours: meta.lead_hours,
          validTimesUtc: meta.lead_hours.map((hour) =>
            new Date(init.getTime() + hour * 3600_000).toISOString()
          ),
          temperatureC: seriesByVariable.t2m ?? [],
          windKmh: (seriesByVariable.wind10m ?? []).map((value) => value * 3.6),
          pressureHpa: seriesByVariable.msl ?? [],
          totalColumnWaterVapour: seriesByVariable.tcwv ?? [],
        });
      } catch (cause: unknown) {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };

    void loadCityForecast();
    return () => controller.abort();
  }, [city.lat, city.lon, city.name, modelId]);

  const validTimesUtc = weatherSeries?.validTimesUtc ?? [];
  const currentStep = Math.min(
    currentStepIndex,
    Math.max(0, (weatherSeries?.leadHours.length ?? 1) - 1)
  );
  const currentValue = (values: number[] | undefined) => {
    const value = values?.[currentStep];
    return value != null && Number.isFinite(value) ? value : null;
  };
  const temp = currentValue(weatherSeries?.temperatureC);
  const wind = currentValue(weatherSeries?.windKmh);
  const pressure = currentValue(weatherSeries?.pressureHpa);
  const waterVapour = currentValue(weatherSeries?.totalColumnWaterVapour);
  const mmName = city.mmName || BURMESE_CITIES_MAP[city.name]?.mmName || city.name;
  const region = BURMESE_CITIES_MAP[city.name]?.region || city.state;
  const currentWindow = getStepTimeWindow(validTimesUtc, currentStep);
  const leadHours = weatherSeries?.leadHours ?? [];

  return (
    <div className="absolute top-24 left-6 z-40 w-80 sm:w-96 rounded-2xl border border-white/20 bg-slate-950/90 p-5 shadow-2xl backdrop-blur-2xl text-white font-burmese animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-white/10 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <h3 className="font-display text-lg font-bold text-white">
              {mmName} <span className="text-xs font-normal text-slate-400">({city.name})</span>
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-emerald-400">
            {region} · အမြင့်ပေ {toBurmeseNumber(city.elevation)}
          </p>
          <p className="text-[11px] text-slate-400 font-mono">
            {toBurmeseNumber(city.lat.toFixed(2))}°N, {toBurmeseNumber(city.lon.toFixed(2))}°E
          </p>
        </div>

        <button
          onClick={onClose}
          className="rounded-full p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          title={BURMESE_STRINGS.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Primary Weather Metrics */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        {/* Temperature */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-1.5 text-xs text-amber-300">
            <Thermometer className="h-3.5 w-3.5" />
            <span>{BURMESE_STRINGS.temperature}</span>
          </div>
          <div className="mt-1 font-display text-2xl font-bold text-white">
            {temp == null ? '—' : `${toBurmeseNumber(Math.round(temp))}°C`}
          </div>
          <div className="text-[11px] text-amber-200/80">
            ၂ မီတာ မြေပြင်အပူချိန်
          </div>
        </div>

        {/* Wind */}
        <div className="rounded-xl border border-teal-500/30 bg-teal-500/10 p-3">
          <div className="flex items-center gap-1.5 text-xs text-teal-300">
            <Wind className="h-3.5 w-3.5" />
            <span>{BURMESE_STRINGS.windSpeed}</span>
          </div>
          <div className="mt-1 font-display text-2xl font-bold text-white">
            {wind == null ? '—' : toBurmeseNumber(wind.toFixed(1))} <span className="text-xs font-normal">km/h</span>
          </div>
          <div className="text-[11px] text-teal-200/80">
            ၁၀ မီတာ လေတိုက်နှုန်း
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
        <div className="rounded-lg bg-white/5 p-2 border border-white/5">
          <div className="text-[10px] text-slate-400">{BURMESE_STRINGS.pressure}</div>
          <div className="font-mono font-semibold text-white mt-0.5">
            {pressure == null ? '—' : `${toBurmeseNumber(pressure.toFixed(1))} hPa`}
          </div>
        </div>
        <div className="rounded-lg bg-white/5 p-2 border border-white/5">
          <div className="text-[10px] text-slate-400">Total column water vapour</div>
          <div className="font-mono font-semibold text-white mt-0.5">
            {waterVapour == null ? '—' : `${toBurmeseNumber(waterVapour.toFixed(1))} kg/m²`}
          </div>
        </div>
      </div>

      {isLoading && (
        <p role="status" className="mt-3 text-center text-xs text-slate-400">
          Loading {modelId} forecast data…
        </p>
      )}
      {loadError && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 p-2 text-xs text-rose-200">
          Forecast data unavailable: {loadError}
        </p>
      )}

      {/* Rollout strip — 6 windows for a 30 h zip, scrolling row when the run is longer */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <div className="text-[11px] font-semibold text-slate-300 mb-2">
          {modelId} {toBurmeseNumber(leadHours[leadHours.length - 1] ?? 0)} နာရီ ခန့်မှန်းချက် အဆင့်များ:
        </div>
        <div className={leadHours.length > 8 ? 'flex gap-1 overflow-x-auto pb-1' : 'grid grid-cols-6 gap-1'}>
          {leadHours.map((leadHour, idx) => {
            const isStepActive = idx === currentStep;
            const win = getStepTimeWindow(validTimesUtc, idx);
            const stepTemperature = weatherSeries?.temperatureC[idx];
            return (
              <div
                key={`${leadHour}-${idx}`}
                className={`flex flex-col items-center justify-center rounded-lg px-1 py-1.5 text-center transition ${
                  leadHours.length > 8 ? 'min-w-[3.6rem] shrink-0' : ''
                } ${
                  isStepActive
                    ? 'bg-emerald-600 text-white font-bold ring-1 ring-emerald-400'
                    : 'bg-white/5 text-slate-300'
                }`}
              >
                <span className="text-[8px] font-mono opacity-80 leading-tight">
                  {win?.dateLabel ?? '—'}
                </span>
                <span className="text-[8px] font-mono opacity-90 leading-tight">
                  {win?.shortLabel ?? `${leadHour}h`}
                </span>
                <span className="text-xs font-semibold mt-0.5">
                  {stepTemperature == null || !Number.isFinite(stepTemperature)
                    ? '—'
                    : `${toBurmeseNumber(Math.round(stepTemperature))}°`}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Valid date + time for the active step */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <div className="text-[10px] text-slate-400">ခန့်မှန်းချက် အချိန်</div>
        <div className="mt-0.5 font-mono text-xs font-semibold text-emerald-300">
          {currentWindow
            ? `${currentWindow.dateLabel} · ${currentWindow.shortLabel}`
            : '—'}
        </div>
      </div>
    </div>
  );
};
