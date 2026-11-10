let context: AudioContext | null = null;

/**
 * Browsers only allow audio after a user gesture. Call this from a click
 * handler (the login button) so the context is unlocked before the first alert.
 */
export function unlockAudio(): void {
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) return;
    context = new Ctor();
  }

  if (context.state === 'suspended') {
    void context.resume();
  }
}

/**
 * De-duplicated beep keyed by alert id.
 *
 * The same alert can reach the dashboard twice: once as a socket `alert:new`
 * and once as a foreground FCM message (push is deliberately additive). Both
 * paths must be allowed to beep, but only one of them may actually sound —
 * a double beep reads as "two emergencies". Five seconds is comfortably
 * longer than the gap between the two delivery paths.
 */
const BEEP_DEDUPE_MS = 5_000;
const lastBeepAt = new Map<string, number>();

export function playBeepForAlert(alertId: string): void {
  const now = Date.now();
  const previous = lastBeepAt.get(alertId);

  if (previous !== undefined && now - previous < BEEP_DEDUPE_MS) {
    return;
  }

  lastBeepAt.set(alertId, now);

  // Opportunistic prune so a long shift cannot grow this map forever.
  if (lastBeepAt.size > 200) {
    for (const [id, timestamp] of lastBeepAt) {
      if (now - timestamp > BEEP_DEDUPE_MS) {
        lastBeepAt.delete(id);
      }
    }
  }

  playBeep();
}

export function playBeep(): void {
  if (!context) return;

  if (context.state === 'suspended') {
    void context.resume();
  }

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(880, now);
  oscillator.frequency.setValueAtTime(1320, now + 0.18);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(now);
  oscillator.stop(now + 0.5);
}
