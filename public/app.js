const state = {
  startedAt: performance.now(),
  report: null,
  events: [],
  rafSamples: [],
  lastPointerSampleAt: 0,
  challenge: {
    formSubmitted: false,
    confirmAccepted: false,
    tableShown: false,
    updatedRows: 0,
    completed: false
  }
};

const $ = (selector) => document.querySelector(selector);

boot();

function boot() {
  setupEventCapture();
  setupRafProbe();
  setupChallenge();
  setupButtons();
  renderRuntime();
  updateHeroReadout();

  runChecks();
  [1500, 4000, 7000, 10000, 15000].forEach((delay) => {
    setTimeout(() => {
      renderRuntime();
      if (state.report) {
        state.report.client.behavior = computeBehavior();
        renderReport(state.report, { preserveJson: true });
      }
    }, delay);
  });
}

function setupButtons() {
  $("#runBtn").addEventListener("click", runChecks);
  $("#copyBtn").addEventListener("click", async () => {
    if (!state.report) return;
    await navigator.clipboard.writeText(JSON.stringify(state.report, null, 2));
    setStatus("JSON copied.");
  });
  $("#downloadBtn").addEventListener("click", () => {
    if (!state.report) return;
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amiabot-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function setupEventCapture() {
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
  window.addEventListener("scroll", () => record("scroll", { x: Math.round(scrollX), y: Math.round(scrollY) }), { passive: true });
  window.addEventListener("focus", () => record("focus"));
  window.addEventListener("blur", () => record("blur"));
  document.addEventListener("visibilitychange", () => record("visibilitychange", { visibilityState: document.visibilityState }));
}

function setupRafProbe() {
  let last = performance.now();
  const loop = (timestamp) => {
    state.rafSamples.push(timestamp - last);
    if (state.rafSamples.length > 240) state.rafSamples.shift();
    last = timestamp;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function setupChallenge() {
  const form = $("#challengeForm");
  const wrap = $("#challengeTableWrap");
  const status = $("#challengeStatus");
  const table = $("#challengeTable");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.challenge.formSubmitted = true;
    state.challenge.submittedAtMs = Math.round(performance.now() - state.startedAt);

    if (window.confirm("Start the human check?")) {
      state.challenge.confirmAccepted = true;
      state.challenge.tableShown = true;
      wrap.classList.remove("hidden");
      status.textContent = "Match each target value, then verify the row.";
    }
    renderRuntime();
  });

  table.querySelectorAll("tbody tr").forEach((row) => {
    const button = row.querySelector("button");
    const input = row.querySelector("input");
    const probeName = row.cells[0]?.textContent || "Probe";
    const target = row.dataset.target || "";

    button.addEventListener("click", () => {
      if (button.dataset.updated === "1") return;
      if (input.value.trim() !== target) {
        status.textContent = `${probeName}: enter ${target} before verifying.`;
        input.focus();
        return;
      }

      button.dataset.updated = "1";
      button.textContent = "Verified";
      button.disabled = true;
      input.disabled = true;
      row.classList.add("is-verified");
      state.challenge.updatedRows += 1;
      state.challenge.lastUpdatedAtMs = Math.round(performance.now() - state.startedAt);
      if (state.challenge.updatedRows >= table.querySelectorAll("tbody tr").length) {
        state.challenge.completed = true;
        status.textContent = "Human check complete. Run checks again to update the verdict.";
      } else {
        status.textContent = `${state.challenge.updatedRows} of ${table.querySelectorAll("tbody tr").length} rows verified.`;
      }
      renderRuntime();
    });
  });
}

async function runChecks() {
  const runBtn = $("#runBtn");
  runBtn.disabled = true;
  setStatus("Collecting signals…");
  updateHeroReadout({ webdriver: "checking", verdict: "pending", behaviour: "sampling" });

  try {
    const browser = await collectBrowser();
    const automation = collectAutomationSignals();

    const [workers, fingerprints, network] = await Promise.all([
      collectWorkers(),
      collectFingerprints(),
      collectNetwork()
    ]);

    const client = {
      page: collectPageData(),
      browser,
      automation,
      workers,
      fingerprints,
      network,
      consistency: computeConsistency(browser, workers, network),
      behavior: computeBehavior(),
      challenge: { ...state.challenge }
    };

    setStatus("Sending report to Worker…");
    const report = await postReport(client);
    state.report = report;
    renderReport(report);
    $("#copyBtn").disabled = false;
    $("#downloadBtn").disabled = false;
  } catch (error) {
    setStatus(`Error: ${error && error.message ? error.message : error}`);
    $("#jsonOut").textContent = String(error && error.stack ? error.stack : error);
  } finally {
    runBtn.disabled = false;
  }
}

async function postReport(client) {
  const response = await fetch("/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(client)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function collectPageData() {
  return {
    url: location.href,
    origin: location.origin,
    referrer: document.referrer || null,
    title: document.title,
    visibilityState: document.visibilityState,
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    elapsedMs: Math.round(performance.now() - state.startedAt),
    navigation: performance.getEntriesByType("navigation")[0] ? simplifyPerformanceEntry(performance.getEntriesByType("navigation")[0]) : null
  };
}

async function collectBrowser() {
  const permissions = await collectPermissions();
  const uaData = await collectUaData(navigator.userAgentData);
  const storage = await collectStorage();
  const mediaDevices = await collectMediaDevices();

  return {
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
    vendor: navigator.vendor,
    productSub: navigator.productSub,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory || null,
    maxTouchPoints: navigator.maxTouchPoints,
    cookieEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack || null,
    pdfViewerEnabled: navigator.pdfViewerEnabled ?? null,
    globalPrivacyControl: navigator.globalPrivacyControl ?? null,
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    locale: collectLocaleData(),
    screen: collectScreenData(),
    historyLength: history.length,
    devicePixelRatio: window.devicePixelRatio,
    userAgentData: uaData,
    plugins: collectPlugins(),
    mimeTypes: collectMimeTypes(),
    permissions,
    storage,
    mediaDevices,
    features: collectFeaturePresence(),
    prototypeChecks: collectPrototypeChecks(),
    pluginsConsistency: collectPluginConsistency(),
    stackProbe: collectStackProbe()
  };
}

async function collectUaData(userAgentData) {
  if (!userAgentData) return null;
  const out = {
    brands: userAgentData.brands || null,
    mobile: userAgentData.mobile,
    platform: userAgentData.platform
  };
  if (userAgentData.getHighEntropyValues) {
    out.highEntropy = await safeAsync(() => userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
      "formFactor",
      "fullVersionList",
      "model",
      "platformVersion",
      "uaFullVersion",
      "wow64"
    ]));
  }
  return out;
}

function collectLocaleData() {
  return {
    numberSample: safe(() => new Intl.NumberFormat().format(1234567.89)),
    dateSample: safe(() => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(new Date("2026-05-12T12:34:56Z"))),
    calendar: safe(() => Intl.DateTimeFormat().resolvedOptions().calendar),
    numberingSystem: safe(() => Intl.DateTimeFormat().resolvedOptions().numberingSystem)
  };
}

function collectScreenData() {
  return {
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    pixelDepth: screen.pixelDepth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    visualViewport: window.visualViewport ? {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      scale: window.visualViewport.scale,
      offsetLeft: Math.round(window.visualViewport.offsetLeft),
      offsetTop: Math.round(window.visualViewport.offsetTop)
    } : null
  };
}

function collectPlugins() {
  return Array.from(navigator.plugins || []).map((plugin) => ({
    name: plugin.name,
    filename: plugin.filename,
    description: plugin.description,
    mimeTypes: Array.from(plugin || []).map((mime) => ({ type: mime.type, suffixes: mime.suffixes, description: mime.description }))
  }));
}

function collectMimeTypes() {
  return Array.from(navigator.mimeTypes || []).map((mime) => ({
    type: mime.type,
    suffixes: mime.suffixes,
    description: mime.description,
    enabledPlugin: mime.enabledPlugin ? mime.enabledPlugin.name : null
  }));
}

async function collectPermissions() {
  const out = {};
  if (!navigator.permissions || !navigator.permissions.query) return { supported: false };
  const queries = ["notifications", "geolocation", "camera", "microphone", "clipboard-read", "clipboard-write"];
  for (const name of queries) {
    out[name] = await safeAsync(async () => {
      const result = await navigator.permissions.query({ name });
      return { state: result.state, permission: name === "notifications" ? Notification.permission : undefined };
    });
  }
  return out;
}

async function collectStorage() {
  return {
    localStorage: storageProbe("localStorage"),
    sessionStorage: storageProbe("sessionStorage"),
    indexedDB: "indexedDB" in window,
    caches: "caches" in window,
    estimate: navigator.storage?.estimate ? await safeAsync(() => navigator.storage.estimate()) : null,
    persisted: navigator.storage?.persisted ? await safeAsync(() => navigator.storage.persisted()) : null
  };
}

function storageProbe(name) {
  try {
    const store = window[name];
    const key = "__amiabot_probe__";
    store.setItem(key, "1");
    const ok = store.getItem(key) === "1";
    store.removeItem(key);
    return { supported: true, writable: ok, length: store.length };
  } catch (error) {
    return { supported: false, error: String(error && error.message ? error.message : error) };
  }
}

async function collectMediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { supported: false };
  return await safeAsync(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const counts = {};
    let labelsVisible = 0;
    for (const device of devices) {
      counts[device.kind] = (counts[device.kind] || 0) + 1;
      if (device.label) labelsVisible += 1;
    }
    return { supported: true, counts, labelsVisible, total: devices.length };
  });
}

function collectFeaturePresence() {
  return {
    chromeObject: Boolean(window.chrome),
    permissions: Boolean(navigator.permissions),
    serviceWorker: Boolean(navigator.serviceWorker),
    webWorker: Boolean(window.Worker),
    sharedWorker: Boolean(window.SharedWorker),
    webAssembly: Boolean(window.WebAssembly),
    webGL: Boolean(document.createElement("canvas").getContext("webgl")),
    webGL2: Boolean(document.createElement("canvas").getContext("webgl2")),
    webGPU: Boolean(navigator.gpu),
    webRTC: Boolean(window.RTCPeerConnection),
    bluetooth: Boolean(navigator.bluetooth),
    hid: Boolean(navigator.hid),
    usb: Boolean(navigator.usb),
    serial: Boolean(navigator.serial),
    battery: Boolean(navigator.getBattery),
    notification: Boolean(window.Notification),
    credentialManagement: Boolean(navigator.credentials),
    clipboard: Boolean(navigator.clipboard),
    offscreenCanvas: Boolean(window.OffscreenCanvas),
    touchEvent: Boolean(window.TouchEvent)
  };
}

function collectPrototypeChecks() {
  const props = ["userAgent", "platform", "languages", "hardwareConcurrency", "plugins", "webdriver", "deviceMemory", "maxTouchPoints"];
  const proto = Object.getPrototypeOf(navigator);
  const descriptors = {};
  const nativeGetterFailures = [];

  for (const prop of props) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop) || Object.getOwnPropertyDescriptor(navigator, prop);
    if (!desc) {
      descriptors[prop] = null;
      continue;
    }
    const source = desc.get ? Function.prototype.toString.call(desc.get) : desc.value ? Function.prototype.toString.call(desc.value) : null;
    descriptors[prop] = {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      hasGetter: Boolean(desc.get),
      hasSetter: Boolean(desc.set),
      hasValue: "value" in desc,
      sourceSnippet: source ? source.slice(0, 140) : null
    };
    if (source && !source.includes("[native code]") && prop !== "webdriver") {
      nativeGetterFailures.push({ prop, sourceSnippet: source.slice(0, 140) });
    }
  }

  return { descriptors, nativeGetterFailures };
}

function collectPluginConsistency() {
  const plugins = navigator.plugins;
  const result = { supported: Boolean(plugins), length: plugins ? plugins.length : 0 };
  if (!plugins || plugins.length === 0) return result;

  try {
    const firstPlugin = plugins[0];
    const firstMime = firstPlugin && firstPlugin[0];
    if (firstMime && firstMime.enabledPlugin) {
      result.nameMatch = firstPlugin.name === firstMime.enabledPlugin.name;
      result.referenceMismatch = firstMime.enabledPlugin !== firstPlugin;
    }
  } catch (error) {
    result.referenceError = String(error && error.message ? error.message : error);
  }

  try {
    result.itemOverflowMatchesFirst = plugins.item(4294967296) === plugins[0];
  } catch (error) {
    result.itemOverflowError = String(error && error.message ? error.message : error);
  }

  try {
    const original = plugins.refresh;
    plugins.refresh = "amiabot-test";
    result.refreshWritable = plugins.refresh === "amiabot-test";
    plugins.refresh = original;
  } catch (error) {
    result.refreshWritable = false;
    result.refreshError = String(error && error.message ? error.message : error);
  }

  return result;
}

function collectStackProbe() {
  let recursion = null;
  try {
    let depth = 0;
    (function recurse() {
      depth += 1;
      recurse();
    })();
  } catch (error) {
    recursion = {
      depth: countStackDepth(error),
      name: error.name,
      message: error.message,
      stackLength: String(error.stack || "").length
    };
  }
  return recursion;
}

function countStackDepth(error) {
  const stack = String(error.stack || "");
  const lines = stack.split("\n").length;
  return lines || null;
}

function collectAutomationSignals() {
  const markers = [
    "_phantom",
    "callPhantom",
    "__nightmare",
    "domAutomation",
    "domAutomationController",
    "__webdriver_script_fn",
    "__driver_evaluate",
    "__webdriver_evaluate",
    "__selenium_evaluate",
    "__fxdriver_evaluate",
    "__driver_unwrapped",
    "__webdriver_unwrapped",
    "__selenium_unwrapped",
    "__fxdriver_unwrapped",
    "_Selenium_IDE_Recorder",
    "_selenium",
    "calledSelenium",
    "cdc_adoQpoasnfa76pfcZLmcfl_Array",
    "cdc_adoQpoasnfa76pfcZLmcfl_Promise",
    "cdc_adoQpoasnfa76pfcZLmcfl_Symbol"
  ];
  const present = markers.filter((name) => name in window);

  return {
    present,
    cdpSerializationSignal: detectCdpSerialization(),
    webdriver: navigator.webdriver === true,
    headlessUserAgent: /HeadlessChrome|PhantomJS|SlimerJS/i.test(navigator.userAgent)
  };
}

function detectCdpSerialization() {
  let tripped = false;
  try {
    const error = new Error("amiabot-cdp-probe");
    Object.defineProperty(error, "stack", {
      configurable: true,
      get() {
        tripped = true;
        return "";
      }
    });
    // Some automation stacks serialize console arguments through CDP and trigger the getter.
    console.debug(error);
  } catch (_) {
    return false;
  }
  return tripped;
}

async function collectWorkers() {
  const [webWorker, iframe, serviceWorker] = await Promise.all([
    collectWebWorker(),
    collectIframeNavigator(),
    collectServiceWorker()
  ]);
  return { webWorker, iframe, serviceWorker };
}

async function collectWebWorker() {
  if (!window.Worker) return { supported: false };
  const code = `
    async function collect() {
      const out = {
        supported: true,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: Array.from(navigator.languages || []),
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || null,
        webdriver: navigator.webdriver,
        vendor: navigator.vendor,
        appVersion: navigator.appVersion
      };
      try {
        if (navigator.userAgentData) {
          out.userAgentData = {
            brands: navigator.userAgentData.brands,
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform
          };
          if (navigator.userAgentData.getHighEntropyValues) {
            out.userAgentData.highEntropy = await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','formFactor','fullVersionList','model','platformVersion','uaFullVersion','wow64']);
          }
        }
      } catch (error) {
        out.userAgentData = { error: String(error && error.message ? error.message : error) };
      }
      postMessage(out);
    }
    collect();
  `;
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const worker = new Worker(url);
    const data = await promiseWithTimeout(new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message || "Web Worker error"));
    }), 1800, "Web Worker timeout");
    worker.terminate();
    return data;
  } catch (error) {
    return { supported: true, error: String(error && error.message ? error.message : error) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function collectIframeNavigator() {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0";
  document.body.appendChild(iframe);
  await sleep(0);
  try {
    const n = iframe.contentWindow.navigator;
    return {
      supported: true,
      userAgent: n.userAgent,
      platform: n.platform,
      language: n.language,
      languages: Array.from(n.languages || []),
      hardwareConcurrency: n.hardwareConcurrency,
      deviceMemory: n.deviceMemory || null,
      webdriver: n.webdriver,
      vendor: n.vendor,
      appVersion: n.appVersion,
      pluginsLength: n.plugins ? n.plugins.length : null
    };
  } catch (error) {
    return { supported: true, error: String(error && error.message ? error.message : error) };
  } finally {
    iframe.remove();
  }
}

async function collectServiceWorker() {
  if (!navigator.serviceWorker || !window.isSecureContext) {
    return { supported: false, reason: "Service Worker requires secure context and navigator.serviceWorker." };
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw-detector.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const sw = registration.active || registration.waiting || registration.installing || navigator.serviceWorker.controller;
    if (!sw) return { supported: true, error: "No active service worker after registration." };

    const channel = new MessageChannel();
    const responsePromise = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    sw.postMessage({ type: "amiabot:inspect" }, [channel.port2]);
    return await promiseWithTimeout(responsePromise, 1800, "Service Worker timeout");
  } catch (error) {
    return { supported: true, error: String(error && error.message ? error.message : error) };
  }
}

async function collectFingerprints() {
  const [canvas, webgl, audio, fonts, cssMedia, webgpu] = await Promise.all([
    collectCanvasFingerprint(),
    collectWebglFingerprint(),
    collectAudioFingerprint(),
    collectFontFingerprint(),
    collectCssMediaFingerprint(),
    collectWebGpuFingerprint()
  ]);
  return { canvas, webgl, audio, fonts, cssMedia, webgpu };
}

async function collectCanvasFingerprint() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 140;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { supported: false };

    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 420, 140);
    ctx.fillStyle = "#069";
    ctx.font = "18px Arial";
    ctx.fillText("Am I a Bot canvas 1.0", 18, 36);
    ctx.fillStyle = "rgba(102, 204, 0, 0.65)";
    ctx.font = "32px Georgia";
    ctx.fillText("Fingerprint", 18, 82);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgb(255,0,255)";
    ctx.beginPath();
    ctx.arc(320, 55, 45, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.fillStyle = "rgb(0,255,255)";
    ctx.beginPath();
    ctx.arc(355, 85, 45, 0, Math.PI * 2, true);
    ctx.fill();

    const dataUrl = canvas.toDataURL();
    return { supported: true, hash: await sha256(dataUrl), dataUrlLength: dataUrl.length };
  } catch (error) {
    return { supported: false, hashError: String(error && error.message ? error.message : error) };
  }
}

async function collectWebglFingerprint() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return { supported: false };

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const extensions = gl.getSupportedExtensions() || [];
    const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") || gl.getExtension("MOZ_EXT_texture_filter_anisotropic");

    const params = {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
      maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []),
      aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
      maxAnisotropy: anisotropy ? gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null
    };

    return {
      supported: true,
      webgl2: Boolean(document.createElement("canvas").getContext("webgl2")),
      params,
      extensions,
      extensionsHash: await sha256(extensions.join("|")),
      fingerprintHash: await sha256(JSON.stringify({ params, extensions }))
    };
  } catch (error) {
    return { supported: false, error: String(error && error.message ? error.message : error) };
  }
}

async function collectAudioFingerprint() {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return { supported: false };
  try {
    const context = new OfflineCtx(1, 5000, 44100);
    const oscillator = context.createOscillator();
    const compressor = context.createDynamicsCompressor();

    oscillator.type = "triangle";
    oscillator.frequency.value = 10000;
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;

    oscillator.connect(compressor);
    compressor.connect(context.destination);
    oscillator.start(0);

    const buffer = await promiseWithTimeout(context.startRendering(), 2000, "Audio render timeout");
    const samples = Array.from(buffer.getChannelData(0).slice(4500, 5000));
    const sum = samples.reduce((acc, value) => acc + Math.abs(value), 0);
    return {
      supported: true,
      sum,
      hash: await sha256(samples.map((value) => value.toFixed(8)).join(","))
    };
  } catch (error) {
    return { supported: false, error: String(error && error.message ? error.message : error) };
  }
}

async function collectFontFingerprint() {
  try {
    const testFonts = [
      "Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Courier New",
      "Georgia", "Helvetica", "Impact", "Lucida Console", "Menlo", "Monaco", "Palatino", "Segoe UI",
      "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Wingdings", "Roboto", "Noto Sans", "San Francisco"
    ];
    const baseFonts = ["monospace", "sans-serif", "serif"];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const text = "mmmmmmmmmmlliWW@@@12345";
    const size = "72px";
    const baseline = {};

    for (const base of baseFonts) {
      ctx.font = `${size} ${base}`;
      baseline[base] = ctx.measureText(text).width;
    }

    const detected = [];
    for (const font of testFonts) {
      const found = baseFonts.some((base) => {
        ctx.font = `${size} '${font}', ${base}`;
        return ctx.measureText(text).width !== baseline[base];
      });
      if (found) detected.push(font);
    }

    return { supported: true, detected, count: detected.length, hash: await sha256(detected.join("|")) };
  } catch (error) {
    return { supported: false, error: String(error && error.message ? error.message : error) };
  }
}

async function collectCssMediaFingerprint() {
  const queries = [
    "(prefers-color-scheme: dark)",
    "(prefers-color-scheme: light)",
    "(prefers-reduced-motion: reduce)",
    "(prefers-contrast: more)",
    "(forced-colors: active)",
    "(hover: hover)",
    "(pointer: fine)",
    "(pointer: coarse)",
    "(any-pointer: fine)",
    "(display-mode: browser)",
    "(dynamic-range: high)"
  ];
  const values = Object.fromEntries(queries.map((query) => [query, matchMedia(query).matches]));
  return { supported: true, values, hash: await sha256(JSON.stringify(values)) };
}

async function collectWebGpuFingerprint() {
  if (!navigator.gpu?.requestAdapter) return { supported: false };
  try {
    const adapter = await promiseWithTimeout(navigator.gpu.requestAdapter(), 1500, "WebGPU adapter timeout");
    if (!adapter) return { supported: true, adapter: null };
    const info = adapter.info ? copyPlain(adapter.info) : adapter.requestAdapterInfo ? await safeAsync(() => adapter.requestAdapterInfo()) : null;
    return {
      supported: true,
      adapterInfo: copyPlain(info),
      features: adapter.features ? Array.from(adapter.features) : [],
      limits: adapter.limits ? copyPlain(adapter.limits) : null
    };
  } catch (error) {
    return { supported: true, error: String(error && error.message ? error.message : error) };
  }
}

async function collectNetwork() {
  const [ping, webrtc] = await Promise.all([collectPing(), collectWebRtcLeak()]);
  return { ping, webrtc, connection: collectConnectionInfo() };
}

async function collectPing() {
  const timings = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    try {
      await fetch(`/api/ping?i=${i}&t=${Date.now()}`, { cache: "no-store" });
      timings.push(performance.now() - start);
    } catch (error) {
      timings.push(null);
    }
    await sleep(80);
  }
  const good = timings.filter((value) => typeof value === "number").sort((a, b) => a - b);
  return {
    timingsMs: timings.map((value) => value == null ? null : Math.round(value * 10) / 10),
    minMs: good.length ? Math.round(good[0] * 10) / 10 : null,
    medianMs: good.length ? Math.round(good[Math.floor(good.length / 2)] * 10) / 10 : null,
    maxMs: good.length ? Math.round(good[good.length - 1] * 10) / 10 : null
  };
}

async function collectWebRtcLeak() {
  if (!window.RTCPeerConnection) return { supported: false };
  const candidates = [];
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
    pc.createDataChannel("amiabot");
    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sleep(2500);
  } catch (error) {
    return { supported: true, error: String(error && error.message ? error.message : error), candidates };
  } finally {
    if (pc) pc.close();
  }

  const parsed = candidates.map(parseIceCandidate).filter(Boolean);
  const publicIps = unique(parsed.filter((item) => item.isPublic).map((item) => item.address));
  const privateIps = unique(parsed.filter((item) => item.isPrivate).map((item) => item.address));
  const mdnsHosts = unique(parsed.filter((item) => item.isMdns).map((item) => item.address));
  return { supported: true, candidates: parsed, publicIps, privateIps, mdnsHosts };
}

function collectConnectionInfo() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null;
  return {
    effectiveType: c.effectiveType || null,
    downlink: c.downlink || null,
    rtt: c.rtt || null,
    saveData: c.saveData || false,
    type: c.type || null
  };
}

function computeConsistency(browser, workers, network) {
  const consistency = {};
  const uaOS = guessUaOs(browser.userAgent);
  const platformOS = guessPlatformOs(browser.platform);

  if (uaOS && platformOS && uaOS !== platformOS) {
    consistency.uaPlatformMismatch = { userAgentOS: uaOS, platformOS, platform: browser.platform };
  }
  if (workers.webWorker?.platform && browser.platform && workers.webWorker.platform !== browser.platform) {
    consistency.workerPlatformMismatch = { windowPlatform: browser.platform, workerPlatform: workers.webWorker.platform };
  }
  if (workers.iframe?.platform && browser.platform && workers.iframe.platform !== browser.platform) {
    consistency.iframePlatformMismatch = { windowPlatform: browser.platform, iframePlatform: workers.iframe.platform };
  }
  if (browser.screen?.innerWidth > browser.screen?.width + 8 || browser.screen?.innerHeight > browser.screen?.height + 8) {
    consistency.screenViewportImpossible = browser.screen;
  }
  if (network.webrtc?.publicIps?.length) {
    consistency.webrtcPublicIps = network.webrtc.publicIps;
  }
  return consistency;
}

function computeBehavior() {
  const elapsedMs = performance.now() - state.startedAt;
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
    checkpointsMs: [1500, 4000, 7000, 10000, 15000],
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

function renderReport(report, options = {}) {
  const verdict = report.verdict || {};
  const scoreCard = $("#scoreCard");
  scoreCard.className = `score-card ${verdict.risk || "pending"}`;
  scoreCard.innerHTML = verdict.score == null ? "Pending" : `${escapeHtml(String(verdict.score))}<small>${escapeHtml(verdict.classification || "unknown")}</small>`;
  setStatus(`Classification: ${verdict.classification || "unknown"}. Risk: ${verdict.risk || "unknown"}.`);

  renderReasons(verdict.reasons || []);
  renderCoverage(report.detections || []);
  renderServerSummary(report.server || {});
  renderBrowserSummary(report.client || {});
  renderRuntime();
  updateHeroReadoutFromReport(report);

  if (!options.preserveJson) {
    $("#jsonOut").textContent = JSON.stringify(report, null, 2);
  }
}

function renderReasons(reasons) {
  const el = $("#reasons");
  if (!reasons.length) {
    el.innerHTML = `<div class="muted">No suspicious signals in current report.</div>`;
    return;
  }
  el.innerHTML = reasons.slice(0, 12).map((reason) => `
    <div class="reason">
      <strong>${escapeHtml(reason.id)} · ${escapeHtml(reason.severity)} · -${escapeHtml(String(reason.points))}</strong>
      <span>${escapeHtml(reason.message)}</span>
    </div>
  `).join("");
}

function renderCoverage(rows) {
  const tbody = $("#coverageTable tbody");
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.name)}</td>
      <td><span class="status-pill status-${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.notes || "")}</td>
    </tr>
  `).join("");
}

function renderServerSummary(server) {
  const ipIntel = server.ipIntel?.normalized || {};
  const cfBot = server.cloudflareBotManagement || {};
  const summary = {
    IP: server.ip || "n/a",
    Country: server.cf?.country || ipIntel.country || "n/a",
    Colo: server.cf?.colo || "n/a",
    ASN: server.cf?.asn || ipIntel.asn || "n/a",
    Organization: server.cf?.asOrganization || ipIntel.providerName || "n/a",
    "HTTP protocol": server.cf?.httpProtocol || "n/a",
    "TCP RTT": server.cf?.clientTcpRtt != null ? `${server.cf.clientTcpRtt} ms` : "n/a",
    "Proxy/VPN/Tor/DC": `proxy=${bool(ipIntel.isProxy)} vpn=${bool(ipIntel.isVpn)} tor=${bool(ipIntel.isTor)} dc=${bool(ipIntel.isDatacenter)}`,
  };

  if (server.ipIntel?.enabled) {
    summary["IP reputation"] = `${server.ipIntel.provider || "active"} ${server.ipIntel.elapsedMs ? `(${server.ipIntel.elapsedMs} ms)` : ""}`;
  }

  if (cfBot.available) {
    summary["Managed bot score"] = `${cfBot.score} verified=${bool(cfBot.verifiedBot)}`;
    summary["JA3/JA4"] = `${cfBot.ja3Hash || "n/a"} / ${cfBot.ja4 || "n/a"}`;
  }

  renderKv("#serverSummary", summary);
}

function renderBrowserSummary(client) {
  const b = client.browser || {};
  const fp = client.fingerprints || {};
  const workers = client.workers || {};
  const webrtc = client.network?.webrtc || {};
  renderKv("#browserSummary", {
    "User-Agent": b.userAgent || "n/a",
    Platform: b.platform || "n/a",
    Timezone: b.timezone || "n/a",
    WebDriver: bool(b.webdriver),
    Plugins: Array.isArray(b.plugins) ? b.plugins.length : "n/a",
    "Canvas hash": fp.canvas?.hash || "n/a",
    "WebGL renderer": fp.webgl?.params?.unmaskedRenderer || fp.webgl?.params?.renderer || "n/a",
    "Audio hash": fp.audio?.hash || "n/a",
    "Worker platform": workers.webWorker?.platform || "n/a",
    "Service worker platform": workers.serviceWorker?.platform || "n/a",
    "WebRTC public IPs": (webrtc.publicIps || []).join(", ") || "none",
    "WebRTC private/mDNS": `${(webrtc.privateIps || []).join(", ") || "none"} / ${(webrtc.mdnsHosts || []).length || 0} mDNS`,
    "Behavior score": client.behavior?.score ?? "n/a",
    "Human check": state.challenge.completed ? "complete" : state.challenge.tableShown ? "in progress" : state.challenge.formSubmitted ? "submitted" : "not started"
  });
}

function renderRuntime() {
  const behavior = computeBehavior();
  renderKv("#runtime", {
    "Elapsed": `${Math.round(performance.now() - state.startedAt)} ms`,
    "Behavior score": behavior.score,
    "Events": Object.entries(behavior.summary.eventCounts).map(([key, value]) => `${key}:${value}`).join(" ") || "none",
    "Pointer distance": behavior.summary.pointerDistance,
    "Human check": state.challenge.completed ? "complete" : state.challenge.tableShown ? "in progress" : state.challenge.formSubmitted ? "submitted" : "not started"
  });
  if (!state.report) {
    updateHeroReadout({ behaviour: String(behavior.score) });
  }
}

function updateHeroReadoutFromReport(report) {
  const webdriver = report.client?.browser?.webdriver;
  const score = report.verdict?.score;
  const behaviorScore = report.client?.behavior?.score;
  updateHeroReadout({
    webdriver: webdriver == null ? "unknown" : webdriver ? "yes" : "no",
    verdict: score == null ? "pending" : String(score),
    behaviour: behaviorScore == null ? "sampling" : String(behaviorScore)
  });
}

function updateHeroReadout(values = {}) {
  const webdriver = $("#heroWebdriver");
  const verdict = $("#heroVerdict");
  const behaviour = $("#heroBehaviour");
  if (webdriver && values.webdriver) webdriver.textContent = values.webdriver;
  if (verdict && values.verdict) verdict.textContent = values.verdict;
  if (behaviour && values.behaviour) behaviour.textContent = values.behaviour;
}

function renderKv(selector, obj) {
  const el = $(selector);
  el.innerHTML = Object.entries(obj).map(([key, value]) => `
    <div>${escapeHtml(key)}</div><div><code>${escapeHtml(formatValue(value))}</code></div>
  `).join("");
}

function setStatus(text) {
  $("#status").textContent = text;
}

function parseIceCandidate(candidate) {
  const parts = candidate.trim().split(/\s+/);
  if (parts.length < 8) return null;
  const address = parts[4];
  const port = parts[5];
  const typeIndex = parts.indexOf("typ");
  const type = typeIndex >= 0 ? parts[typeIndex + 1] : null;
  return {
    foundation: parts[0].replace(/^candidate:/, ""),
    component: parts[1],
    protocol: parts[2],
    priority: parts[3],
    address,
    port,
    type,
    isMdns: /\.local$/i.test(address),
    isPrivate: isPrivateIp(address),
    isPublic: isPublicIp(address),
    raw: candidate
  };
}

function isPrivateIp(address) {
  if (!address || /\.local$/i.test(address)) return false;
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function isPublicIp(address) {
  if (!address || /\.local$/i.test(address)) return false;
  if (address.includes(":")) return !isPrivateIp(address);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && !isPrivateIp(address);
}

function guessUaOs(ua) {
  if (/Windows NT/i.test(ua)) return "windows";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  if (/CrOS/i.test(ua)) return "chromeos";
  return null;
}

function guessPlatformOs(platform) {
  if (!platform) return null;
  if (/Win/i.test(platform)) return "windows";
  if (/iPhone|iPad|iPod/i.test(platform)) return "ios";
  if (/Mac/i.test(platform)) return "macos";
  if (/Android/i.test(platform)) return "android";
  if (/Linux|X11/i.test(platform)) return "linux";
  return null;
}

function simplifyPerformanceEntry(entry) {
  const out = {};
  for (const key of ["type", "redirectCount", "domContentLoadedEventEnd", "loadEventEnd", "duration", "transferSize", "encodedBodySize", "decodedBodySize"]) {
    if (entry[key] !== undefined) out[key] = typeof entry[key] === "number" ? Math.round(entry[key] * 10) / 10 : entry[key];
  }
  return out;
}

function standardDeviation(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (nums.length < 2) return 0;
  const mean = nums.reduce((acc, value) => acc + value, 0) / nums.length;
  const variance = nums.reduce((acc, value) => acc + (value - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promiseWithTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || "Timeout")), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function safeAsync(fn) {
  try {
    const value = await fn();
    return value === undefined ? null : value;
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

function safe(fn) {
  try {
    const value = fn();
    return value === undefined ? null : value;
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

async function sha256(text) {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return `fallback-${Math.abs(hash)}`;
  }
}

function copyPlain(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

function bool(value) {
  return value === true ? "true" : value === false ? "false" : value == null ? "n/a" : String(value);
}

function formatValue(value) {
  if (value == null) return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
