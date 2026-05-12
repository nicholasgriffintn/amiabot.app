import { parseIceCandidate, sleep, unique } from "./utils.js";

export async function collectNetwork() {
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
