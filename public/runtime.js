import { standardDeviation } from "./utils.js";

export const BEHAVIOR_CHECKPOINTS_MS = [1500, 4000, 7000, 10000, 15000];

export function setupEventCapture(state) {
  const record = (type, detail = {}) => {
    state.events.push({ type, t: Math.round(performance.now() - state.startedAt), ...detail });
    if (state.events.length > 700) state.events.shift();
  };

  const pointerHandler = (event) => {
    const now = performance.now();
    if (event.type === "pointermove" && now - state.lastPointerSampleAt < 60) return;
    state.lastPointerSampleAt = now;
    record(event.type, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pointerType: event.pointerType,
      buttons: event.buttons,
      pressure: event.pressure
    });
  };

  ["pointermove", "pointerdown", "pointerup", "click"].forEach((type) => {
    window.addEventListener(type, pointerHandler, { passive: true });
  });
  window.addEventListener("keydown", (event) => record("keydown", { code: event.code, repeat: event.repeat }), { passive: true });
  window.addEventListener("scroll", () => record("scroll", { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }), { passive: true });
  window.addEventListener("focus", () => record("focus"));
  window.addEventListener("blur", () => record("blur"));
  document.addEventListener("visibilitychange", () => record("visibilitychange", { visibilityState: document.visibilityState }));
}

export function setupRafProbe(state) {
  let last = performance.now();
  const loop = (timestamp) => {
    state.rafSamples.push(timestamp - last);
    if (state.rafSamples.length > 240) state.rafSamples.shift();
    last = timestamp;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export function computeBehavior(state, now = performance.now()) {
  const elapsedMs = now - state.startedAt;
  const counts = {};
  for (const event of state.events) counts[event.type] = (counts[event.type] || 0) + 1;

  const pointerMoves = state.events.filter((event) => event.type === "pointermove");
  let pointerDistance = 0;
  const speeds = [];
  for (let i = 1; i < pointerMoves.length; i += 1) {
    const prev = pointerMoves[i - 1];
    const curr = pointerMoves[i];
    const distance = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    pointerDistance += distance;
    const dt = Math.max(1, curr.t - prev.t);
    speeds.push(distance / dt);
  }

  const rafStdDev = standardDeviation(state.rafSamples.slice(-120));
  const speedStdDev = standardDeviation(speeds);
  let score = 0.12;
  if (elapsedMs > 1200) score += 0.08;
  if (elapsedMs > 4000) score += 0.08;
  if (pointerMoves.length >= 5) score += 0.17;
  if (pointerDistance > 120) score += 0.16;
  if (speedStdDev > 0.02) score += 0.10;
  if ((counts.click || 0) > 0 || (counts.pointerdown || 0) > 0) score += 0.10;
  if ((counts.keydown || 0) > 0) score += 0.08;
  if ((counts.scroll || 0) > 0) score += 0.08;
  if (rafStdDev > 0.3) score += 0.05;
  if (state.challenge.completed) score += 0.16;
  if (elapsedMs > 3500 && Object.keys(counts).length === 0) score = 0.03;

  score = Math.max(0, Math.min(1, score));
  return {
    score: Math.round(score * 1000) / 1000,
    checkpointsMs: BEHAVIOR_CHECKPOINTS_MS,
    summary: {
      elapsedMs: Math.round(elapsedMs),
      eventCounts: counts,
      pointerMoveSamples: pointerMoves.length,
      pointerDistance: Math.round(pointerDistance),
      pointerSpeedStdDev: Math.round(speedStdDev * 10000) / 10000,
      rafStdDev: Math.round(rafStdDev * 1000) / 1000,
      challengeCompleted: state.challenge.completed
    },
    recentEvents: state.events.slice(-30)
  };
}
