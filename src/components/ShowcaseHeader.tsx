import React from 'react';
import { ViewMode } from '../types/forecast';
import { BURMESE_STRINGS } from '../utils/burmese';
import { Maximize2, Minimize2, Globe, Map, BarChart3, Cpu, History, RefreshCw } from 'lucide-react';
import type { HistoricalEventCatalog, ZarrModel } from '../services/zarrApi';

interface ShowcaseHeaderProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  models: ZarrModel[];
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
  historicalEvents: HistoricalEventCatalog;
  selectedHistoricalEvent: string;
  onSelectHistoricalEvent: (selection: string) => void;
  onRefreshHistoricalEvents: () => void;
  historicalEventsError: string;
}

export const ShowcaseHeader: React.FC<ShowcaseHeaderProps> = ({
  viewMode,
  onViewModeChange,
  isFullscreen,
  onToggleFullscreen,
  models,
  selectedModelId,
  onSelectModel,
  historicalEvents,
  selectedHistoricalEvent,
  onSelectHistoricalEvent,
  onRefreshHistoricalEvents,
  historicalEventsError,
}) => {
  const navBtn = (mode: ViewMode, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => onViewModeChange(mode)}
      className={`whitespace-nowrap transition-colors flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
        viewMode === mode
          ? 'text-emerald-400 font-semibold bg-emerald-500/10'
          : 'text-slate-300 hover:text-white hover:bg-white/5'
      }`}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );

  return (
    <header className="absolute top-0 left-0 right-0 z-30 border-b border-white/10 bg-black/50 backdrop-blur-xl">
      <div className="flex h-14 sm:h-16 w-full items-center gap-2 sm:gap-3 px-3 sm:px-4 lg:px-5">
        {/* Brand — truncates so it cannot cover actions */}
        <div className="flex min-w-0 max-w-[34%] sm:max-w-[28%] items-center gap-2 shrink">
          <div className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            <Cpu className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <span
            className="font-display text-sm sm:text-base font-bold tracking-tight text-white truncate"
            title={BURMESE_STRINGS.appTitle}
          >
            <span className="sm:hidden">FourCastNet</span>
            <span className="hidden sm:inline lg:hidden">NVIDIA FourCastNet</span>
            <span className="hidden lg:inline">{BURMESE_STRINGS.appTitle}</span>
          </span>
        </div>

        {/* View modes — centered, can shrink / hide labels */}
        <nav className="hidden md:flex flex-1 min-w-0 items-center justify-center gap-1 text-xs sm:text-sm font-medium overflow-hidden">
          {navBtn('globe_3d', <Globe className="h-4 w-4 shrink-0" />, BURMESE_STRINGS.satelliteGlobe)}
          {navBtn('satellite_radar', <Map className="h-4 w-4 shrink-0" />, BURMESE_STRINGS.satelliteRadar2D)}
          {navBtn('city_trends', <BarChart3 className="h-4 w-4 shrink-0" />, BURMESE_STRINGS.cityTrends)}
        </nav>

        {/* Mobile view switcher */}
        <div className="flex md:hidden flex-1 min-w-0 items-center justify-center gap-1">
          {navBtn('globe_3d', <Globe className="h-4 w-4" />, '')}
          {navBtn('satellite_radar', <Map className="h-4 w-4" />, '')}
          {navBtn('city_trends', <BarChart3 className="h-4 w-4" />, '')}
        </div>

        {/* Actions — always visible on the right, never overlapped */}
        <div className="relative z-10 flex shrink-0 items-center gap-1.5 sm:gap-2 ml-auto">
          <label
            className="flex min-w-0 items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-950/30 px-2 py-1.5 text-[11px] text-slate-200 sm:gap-1.5 sm:px-2.5"
            title={historicalEventsError || historicalEvents.message || 'Choose a historical cyclone or climate episode to replay'}
          >
            <History className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
            <span className="hidden xl:inline">Historical replay</span>
            <select
              aria-label="Historical replay event"
              value={selectedHistoricalEvent}
              onChange={(event) => onSelectHistoricalEvent(event.target.value)}
              className="max-w-[5.5rem] bg-transparent text-[11px] font-semibold text-white outline-none sm:max-w-36 sm:text-xs xl:max-w-48"
            >
              <option value="" className="bg-slate-900">Select event…</option>
              {historicalEvents.cyclones.length ? (
                <optgroup label="Cyclone · wind + pressure">
                  {historicalEvents.cyclones.map((event) => (
                    <option key={event.id} value={`cyclone:${event.id}`} className="bg-slate-900">
                      {event.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {historicalEvents.enso.length ? (
                <optgroup label="ENSO · El Niño · SST + ONI">
                  {historicalEvents.enso.map((event) => (
                    <option key={event.id} value={`enso:${event.id}`} className="bg-slate-900">
                      {event.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {historicalEvents.la_nina.length ? (
                <optgroup label="La Niña · SST + ONI">
                  {historicalEvents.la_nina.map((event) => (
                    <option key={event.id} value={`enso:${event.id}`} className="bg-slate-900">
                      {event.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {!historicalEvents.cyclones.length && !historicalEvents.enso.length && !historicalEvents.la_nina.length && (
                <option value="" disabled className="bg-slate-900">
                  {historicalEventsError
                    ? 'Replay unavailable'
                    : 'No local events — run loader'}
                </option>
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={onRefreshHistoricalEvents}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/5 text-slate-300 transition hover:bg-white/15 hover:text-white sm:h-9 sm:w-9"
            title={historicalEventsError || historicalEvents.message || 'Refresh local historical event catalog'}
            aria-label="Refresh historical event catalog"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <label
            className="flex min-w-0 items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] text-slate-300 sm:gap-1.5 sm:px-2.5"
            title="Select the local forecast model"
          >
            <Cpu className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span className="hidden sm:inline">Model</span>
            <select
              aria-label="Forecast model"
              value={selectedModelId}
              onChange={(event) => onSelectModel(event.target.value)}
              disabled={!models.length}
              className="max-w-[5.5rem] bg-transparent text-[11px] font-semibold text-white outline-none disabled:opacity-50 sm:max-w-28 sm:text-xs"
            >
              {models.length === 0 && <option value={selectedModelId}>Loading…</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available} className="bg-slate-900">
                  {model.label}{model.available ? '' : ' (missing)'}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={onToggleFullscreen}
            title="မျက်နှာပြင်အပြည့်ဖွင့်ရန် (Shortcut: [F])"
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-2.5 sm:px-3 py-1.5 text-xs font-bold text-white shadow-lg shadow-emerald-900/40 ring-1 ring-emerald-400/50 transition hover:from-emerald-500 hover:to-teal-500 active:scale-95 whitespace-nowrap"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            <span className="hidden sm:inline">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            <kbd className="hidden lg:inline-block rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-mono text-emerald-200 font-bold border border-emerald-400/40">
              F
            </kbd>
          </button>
        </div>
      </div>
    </header>
  );
};
