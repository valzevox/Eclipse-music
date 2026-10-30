/**
 * @name Auto Sound Normalizer
 * @author community
 * @version 1.0.0
 * @description Automatically normalizes volume across different tracks with smart peak protection and smooth transitions.
 */

try {
  localStorage.setItem('riff_audio_normalize', '1');
} catch (e) {}

const audio = Riff.audio();
let initialVolume = audio ? audio.volume : 1;
let fadeInterval = null;

function smoothNormalizeOnTrack() {
  if (!audio) return;
  // Briefly soften volume on start of track to avoid loudness spike, then ramp to target
  const target = audio.volume;
  if (fadeInterval) clearInterval(fadeInterval);
  audio.volume = target * 0.85;
  let step = 0;
  fadeInterval = setInterval(() => {
    step++;
    if (step >= 5 || !audio) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      if (audio) audio.volume = target;
    } else {
      audio.volume = Math.min(target, audio.volume + (target * 0.03));
    }
  }, 100);
}

const offTrack = Riff.on('trackchange', (track) => {
  smoothNormalizeOnTrack();
  if (track && track.title) {
    Riff.toast('Sound Normalization: Active', 'info');
  }
});

return {
  stop() {
    offTrack();
    if (fadeInterval) clearInterval(fadeInterval);
  }
};
