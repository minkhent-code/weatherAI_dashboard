import { Clock, Pause, Play, Repeat, SkipBack, SkipForward } from 'lucide-react';

export interface TimelineStep {
  label: string;
  detail: string;
  fullLabel: string;
}

interface TimelineControlsProps {
  title: string;
  steps: TimelineStep[];
  currentStepIndex: number;
  onSelectStepIndex: (index: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  playbackSpeed: number;
  onChangeSpeed: (speed: number) => void;
  autoLoop: boolean;
  onToggleAutoLoop: () => void;
}

export function TimelineControls({
  title,
  steps,
  currentStepIndex,
  onSelectStepIndex,
  isPlaying,
  onTogglePlay,
  playbackSpeed,
  onChangeSpeed,
  autoLoop,
  onToggleAutoLoop,
}: TimelineControlsProps) {
  if (!steps.length) return null;
  const index = Math.min(Math.max(currentStepIndex, 0), steps.length - 1);
  const selectOffset = (offset: number) =>
    onSelectStepIndex((index + offset + steps.length) % steps.length);

  return (
    <div className="fixed bottom-3 left-1/2 z-30 w-[min(96%,58rem)] -translate-x-1/2 sm:bottom-4">
      <div className="rounded-2xl border border-white/15 bg-black/75 p-3 text-white shadow-2xl backdrop-blur-xl sm:p-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => selectOffset(-1)}
              disabled={steps.length < 2}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/5 text-slate-200 transition hover:bg-white/15 disabled:opacity-40"
              title="Previous timestep"
              aria-label="Previous timestep"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={steps.length < 2}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-900/40 transition hover:bg-emerald-500 active:scale-95 disabled:opacity-40"
              title={isPlaying ? 'Pause playback' : 'Play playback'}
              aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
              aria-pressed={isPlaying}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => selectOffset(1)}
              disabled={steps.length < 2}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/5 text-slate-200 transition hover:bg-white/15 disabled:opacity-40"
              title="Next timestep"
              aria-label="Next timestep"
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-[10px] sm:text-xs">
              <span className="truncate text-slate-300">{title} · {index + 1}/{steps.length}</span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-emerald-200">
                <Clock className="hidden h-3.5 w-3.5 sm:block" />
                {steps[index].fullLabel}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={steps.length - 1}
              value={index}
              onChange={(event) => onSelectStepIndex(Number(event.target.value))}
              className="h-1.5 w-full cursor-pointer accent-emerald-400"
              aria-label={`${title} timeline`}
            />
            <div className="flex justify-between gap-2 overflow-hidden text-[9px] text-slate-500 sm:text-[10px]">
              <span className="truncate">{steps[0].label} {steps[0].detail}</span>
              <span className="truncate text-right">{steps[steps.length - 1].label} {steps[steps.length - 1].detail}</span>
            </div>
          </div>

          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            {[0.5, 1, 2, 5].map((speed) => (
              <button
                key={speed}
                type="button"
                onClick={() => onChangeSpeed(speed)}
                aria-pressed={playbackSpeed === speed}
                className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                  playbackSpeed === speed
                    ? 'bg-emerald-500 text-slate-950'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                {speed}x
              </button>
            ))}
            <button
              type="button"
              onClick={onToggleAutoLoop}
              aria-label={autoLoop ? 'Turn looping off' : 'Turn looping on'}
              aria-pressed={autoLoop}
              title={autoLoop ? 'Loop enabled' : 'Loop disabled'}
              className={`ml-1 flex h-8 w-8 items-center justify-center rounded-full border transition ${
                autoLoop
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-white/15 bg-white/5 text-slate-400'
              }`}
            >
              <Repeat className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
