import { setupChallenge } from "./challenge.js";
import { setupButtons } from "./controls.js";
import { runChecks } from "./report.js";
import {
  BEHAVIOR_CHECKPOINTS_MS,
  computeBehavior,
  setupEventCapture,
  setupPerformanceProbe,
  setupRafProbe,
  setupSensorProbe
} from "./runtime.js";
import { state } from "./state.js";
import { renderReport, renderRuntime, setStatus, updateHeroReadout } from "./ui.js";
import { renderPerformanceMemorySurface } from "./surface-ui.js";

boot();

function boot() {
  setupEventCapture(state);
  setupRafProbe(state);
  setupPerformanceProbe(state, renderPerformanceMemorySurface);
  setupSensorProbe(state);
  setupChallenge(state, renderRuntime);
  setupButtons(state, runChecks, setStatus);
  renderRuntime(state);
  updateHeroReadout();

  runChecks(state);
  BEHAVIOR_CHECKPOINTS_MS.forEach((delay) => {
    setTimeout(() => {
      renderRuntime(state);
      if (state.report) {
        state.report.client.behavior = computeBehavior(state);
        renderReport(state, state.report, { preserveJson: true });
      }
    }, delay);
  });
}
