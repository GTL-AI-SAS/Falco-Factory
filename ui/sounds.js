// Locally synthesized cues. Audio starts only after a user gesture.
const outputGain = 8;
const cues = {
  loaded: [[0, 659.25, .09, .028], [.09, 880, .16, .032]],
  success: [[0, 523.25, .13, .035], [.1, 659.25, .13, .032], [.21, 783.99, .24, .032], [.22, 1046.5, .25, .011]],
  reply: [[0, 783.99, .08, .018], [.07, 987.77, .12, .018]],
  cloudflare: [[0, 698.46, .15, .035], [.12, 880, .15, .035], [.25, 1046.5, .24, .038]],
  warning: [[0, 440, .16, .026], [.18, 392, .22, .024]],
  error: [[0, 392, .14, .036], [.16, 311.13, .14, .036], [.32, 261.63, .25, .036]]
};

export function createStudioSounds({ AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext, storage } = {}) {
  const storageKey = 'falco.studio.sounds';
  let enabled = true;
  let context;
  let lastCueTime = -Infinity;
  let lastCue;
  const voices = new Set();
  try {
    storage ??= globalThis.localStorage;
    enabled = storage?.getItem(storageKey) !== 'off';
  } catch { /* Private browsing may disallow local preferences. */ }

  function silence() {
    for (const voice of voices) { try { voice.stop(); } catch {} }
    voices.clear();
  }
  return {
    storageKey,
    get enabled() { return enabled; },
    get ready() { return context?.state === 'running'; },
    setEnabled(value, { persist = true } = {}) {
      enabled = Boolean(value);
      if (!enabled) silence();
      if (persist) { try { storage?.setItem(storageKey, enabled ? 'on' : 'off'); } catch {} }
    },
    async unlock() {
      if (!enabled || !AudioContext) return;
      try {
        context ??= new AudioContext();
        if (context.state === 'suspended') await context.resume();
      } catch { /* Audio support never blocks Studio operations. */ }
    },
    play(cue) {
      if (!enabled || !context || context.state !== 'running' || !cues[cue]) return false;
      if (cue === lastCue && context.currentTime - lastCueTime < .35) return false;
      try {
        silence();
        lastCueTime = context.currentTime;
        lastCue = cue;
        for (const [delay, frequency, duration, volume] of cues[cue]) {
          const start = context.currentTime + .01 + delay;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = cue === 'error' ? 'triangle' : 'sine';
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume * outputGain, start + .012);
          gain.gain.setValueAtTime(volume * outputGain, start + .045);
          gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(context.destination);
          voices.add(oscillator);
          oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(start);
          oscillator.stop(start + duration + .02);
        }
        return true;
      } catch { silence(); return false; }
    }
  };
}
