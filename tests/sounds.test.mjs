import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioSounds } from '../ui/sounds.js';

function fixture() {
  const instances = [];
  const stored = new Map();
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  class AudioContext {
    constructor() { this.currentTime = 10; this.state = 'suspended'; this.destination = {}; this.voices = []; this.gains = []; instances.push(this); }
    async resume() { this.state = 'running'; }
    createOscillator() {
      const voice = { frequency: { setValueAtTime: () => {} }, stops: [], connect() {}, disconnect() {}, start(at) { this.startedAt = at; }, stop(at) { this.stops.push(at); } };
      this.voices.push(voice); return voice;
    }
    createGain() {
      const gain = { ramps: [], connect() {}, disconnect() {} };
      gain.gain = { setValueAtTime() {}, exponentialRampToValueAtTime(value, at) { gain.ramps.push({ value, at }); } };
      this.gains.push(gain); return gain;
    }
  }
  return { sounds: createStudioSounds({ AudioContext, storage }), instances, storage, AudioContext };
}

test('audio stays silent until unlocked and unsupported browsers can still use Studio', async () => {
  const e = fixture();
  assert.equal(e.sounds.play('success'), false);
  assert.equal(e.instances.length, 0);
  await e.sounds.unlock();
  assert.equal(e.sounds.play('success'), true);
  const unsupported = createStudioSounds({ AudioContext: null, storage: e.storage });
  await unsupported.unlock();
  assert.equal(unsupported.play('success'), false);
});

test('cues are clearly audible, suppress duplicates, and allow deployment completion after loading', async () => {
  const e = fixture();
  await e.sounds.unlock();
  for (const cue of ['loaded', 'success', 'reply', 'cloudflare', 'warning', 'error']) {
    const context = e.instances[0];
    const firstVoice = context.voices.length;
    context.currentTime += 1;
    assert.equal(e.sounds.play(cue), true);
    const count = context.voices.length;
    assert.equal(e.sounds.play(cue), false);
    assert.equal(context.voices.length, count);
    assert.ok(context.voices.slice(firstVoice).every(voice => voice.type === (cue === 'error' ? 'triangle' : 'sine')));
  }
  for (const voice of e.instances[0].voices) {
    assert.ok(voice.stops[0] - voice.startedAt < .4);
  }
  const peaks = e.instances[0].gains.map(gain => Math.max(...gain.ramps.map(ramp => ramp.value)));
  assert.ok(peaks.every(peak => peak >= .08 && peak <= .32));
  assert.ok(Math.max(...peaks) >= .28, 'notification peaks are at least eight times the former .035 level');
  e.instances[0].currentTime += 1;
  assert.equal(e.sounds.play('loaded'), true);
  assert.equal(e.sounds.play('success'), true, 'completion is audible even when a mocked job finishes very quickly');
});

test('muting stops scheduled notes immediately and persists across reloads', async () => {
  const e = fixture();
  await e.sounds.unlock();
  e.sounds.play('success');
  const lastVoices = e.instances[0].voices.slice();
  e.sounds.setEnabled(false);
  assert.ok(lastVoices.every(voice => voice.stops.at(-1) === undefined));
  assert.equal(e.sounds.play('success'), false);
  assert.equal(e.storage.getItem(e.sounds.storageKey), 'off');
  const reloaded = createStudioSounds({ AudioContext: e.AudioContext, storage: e.storage });
  await reloaded.unlock();
  assert.equal(reloaded.enabled, false);
  assert.equal(e.instances.length, 1, 'muted sessions do not create an audio context');
});

test('storage and audio failures never interrupt interface operations', async () => {
  const sounds = createStudioSounds({ AudioContext: class { constructor() { throw Error('audio blocked'); } },
    storage: { getItem() { throw Error('storage blocked'); }, setItem() { throw Error('storage blocked'); } } });
  sounds.setEnabled(false);
  sounds.setEnabled(true);
  await sounds.unlock();
  assert.equal(sounds.play('loaded'), false);
});
