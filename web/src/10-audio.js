/* SOURCE DRIVE - synthesised facility audio.
 *
 * Every sound is generated with oscillators and a noise buffer: no audio files,
 * no network, nothing to license. The context is created on the first real user
 * gesture so autoplay policy never blocks the boot. Browser only.
 */
(function (SD) {
  'use strict';

  function Audio(opts) {
    this.options = opts || {};
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.noise = null;
    this.started = false;
  }

  Audio.prototype.ensure = function () {
    if (this.ctx) { this.resume(); return true; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch (e) {
      return false;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.35;
    this.master.connect(this.ctx.destination);
    // one second of white noise, reused for every impact
    var len = Math.floor(this.ctx.sampleRate);
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    this.noise = buf;
    this.started = true;
    return true;
  };

  Audio.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') {
      try { this.ctx.resume(); } catch (e) { /* ignore */ }
    }
  };

  Audio.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.35;
  };

  Audio.prototype._tone = function (spec) {
    if (!this.ctx || this.muted) return;
    var t0 = this.ctx.currentTime + (spec.delay || 0);
    var osc = this.ctx.createOscillator();
    var gain = this.ctx.createGain();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.f0, t0);
    if (spec.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.f1), t0 + spec.dur);
    }
    var peak = spec.gain === undefined ? 0.25 : spec.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, spec.dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
  };

  Audio.prototype._noise = function (spec) {
    if (!this.ctx || this.muted || !this.noise) return;
    var t0 = this.ctx.currentTime + (spec.delay || 0);
    var src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    var filter = this.ctx.createBiquadFilter();
    filter.type = spec.filter || 'bandpass';
    filter.frequency.setValueAtTime(spec.f0 || 900, t0);
    if (spec.f1) filter.frequency.exponentialRampToValueAtTime(spec.f1, t0 + spec.dur);
    filter.Q.value = spec.q === undefined ? 1.2 : spec.q;
    var gain = this.ctx.createGain();
    var peak = spec.gain === undefined ? 0.22 : spec.gain;
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t0);
    src.stop(t0 + spec.dur + 0.02);
  };

  Audio.prototype.play = function (name) {
    if (!this.ensure()) return;
    switch (name) {
      case 'portal-blue':
        this._tone({ type: 'sine', f0: 380, f1: 880, dur: 0.22, gain: 0.2 });
        this._tone({ type: 'triangle', f0: 760, f1: 1320, dur: 0.16, gain: 0.1, delay: 0.03 });
        break;
      case 'portal-orange':
        this._tone({ type: 'sine', f0: 520, f1: 240, dur: 0.22, gain: 0.2 });
        this._tone({ type: 'triangle', f0: 900, f1: 520, dur: 0.16, gain: 0.1, delay: 0.03 });
        break;
      case 'portal-refused':
        this._tone({ type: 'square', f0: 160, f1: 110, dur: 0.16, gain: 0.12 });
        break;
      case 'enter':
        this._noise({ f0: 300, f1: 2400, dur: 0.35, gain: 0.22, q: 0.7 });
        this._tone({ type: 'sine', f0: 180, f1: 60, dur: 0.4, gain: 0.18 });
        break;
      case 'pickup':
        this._tone({ type: 'triangle', f0: 620, f1: 760, dur: 0.08, gain: 0.12 });
        this._noise({ f0: 1400, dur: 0.06, gain: 0.08 });
        break;
      case 'drop':
        this._tone({ type: 'sine', f0: 150, f1: 70, dur: 0.14, gain: 0.2 });
        this._noise({ f0: 380, dur: 0.1, gain: 0.12, q: 0.8 });
        break;
      case 'plate':
        this._tone({ type: 'square', f0: 210, f1: 150, dur: 0.12, gain: 0.12 });
        this._tone({ type: 'sine', f0: 330, dur: 0.5, gain: 0.1, delay: 0.05 });
        break;
      case 'plate-reject':
        this._tone({ type: 'sawtooth', f0: 190, f1: 120, dur: 0.28, gain: 0.1 });
        break;
      case 'door-open':
        this._noise({ f0: 220, f1: 900, dur: 0.7, gain: 0.1, q: 0.6 });
        this._tone({ type: 'triangle', f0: 120, f1: 200, dur: 0.6, gain: 0.08 });
        break;
      case 'door-close':
        this._noise({ f0: 900, f1: 200, dur: 0.5, gain: 0.1, q: 0.6 });
        break;
      case 'exit':
        this._tone({ type: 'sine', f0: 392, dur: 0.6, gain: 0.12 });
        this._tone({ type: 'sine', f0: 523, dur: 0.6, gain: 0.1, delay: 0.08 });
        this._tone({ type: 'sine', f0: 659, dur: 0.9, gain: 0.1, delay: 0.16 });
        break;
      case 'land':
        this._tone({ type: 'sine', f0: 120, f1: 60, dur: 0.12, gain: 0.14 });
        break;
      case 'jump':
        this._noise({ f0: 700, f1: 300, dur: 0.1, gain: 0.06 });
        break;
      case 'step':
        this._noise({ f0: 260 + Math.random() * 90, dur: 0.07, gain: 0.05, q: 0.9 });
        break;
      case 'ui':
        this._tone({ type: 'triangle', f0: 520, f1: 600, dur: 0.06, gain: 0.08 });
        break;
      case 'recover':
        this._tone({ type: 'sine', f0: 300, f1: 120, dur: 0.35, gain: 0.12 });
        break;
      default:
        break;
    }
  };

  SD.Audio = {
    create: function (opts) { return new Audio(opts); },
    Audio: Audio
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
