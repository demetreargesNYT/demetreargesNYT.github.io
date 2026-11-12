(() => {
  if (window.__yigClock) return;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const FRAME_MS = 1000 / 60;
  const BUFFER = 120;
  const CAPTURE_W = 420;

  const clock = {
    paused: false,
    speed: 1,
    time: 0,
    view: 0,
    onFrame: null,
    stopAt: null,
    stopped: false,
  };

  let queue = [];
  let ids = 0;
  const t0 = performance.now();
  window.requestAnimationFrame = (cb) => {
    if (typeof cb !== "function" || !/^bound/.test(cb.name)) return nativeRaf(cb);
    queue.push({ id: ++ids, cb });
    return -ids;
  };
  window.cancelAnimationFrame = (id) => {
    if (id < 0) queue = queue.filter((e) => e.id !== -id);
    else nativeCancel(id);
  };
  try {
    Object.defineProperty(document.timeline, "currentTime", { configurable: true, get: () => t0 + clock.time });
  } catch { /* a browser that won't allow it keeps the real time */ }

  const ring = [];
  let spare = [];
  let ghost = null;
  const liveCanvas = () => [...document.querySelectorAll("canvas.yig-file")].filter((c) => c.style.visibility !== "hidden").pop() || null;

  function capture() {
    const src = liveCanvas();
    if (!src || !src.width) return;
    const w = CAPTURE_W, h = Math.max(1, Math.round((src.height * w) / src.width));
    if (ring.length && (ring[0].canvas.width !== w || ring[0].canvas.height !== h)) { spare = []; ring.length = 0; }
    const entry = ring.length >= BUFFER ? ring.shift() : { time: 0, canvas: spare.pop() || document.createElement("canvas") };
    entry.canvas.width = w;
    entry.canvas.height = h;
    entry.canvas.getContext("2d").drawImage(src, 0, 0, w, h);
    entry.time = clock.time;
    ring.push(entry);
  }

  function showHistory() {
    const live = liveCanvas();
    if (!live) return;
    if (clock.view <= 0 || !ring.length) { if (ghost) ghost.style.display = "none"; return; }
    const entry = ring[Math.max(0, ring.length - 1 - clock.view)];
    if (!ghost) {
      ghost = document.createElement("canvas");
      ghost.className = "yig-file";
      ghost.style.pointerEvents = "none";
      ghost.style.zIndex = "5";
    }
    if (ghost.parentNode !== live.parentNode) live.parentNode.append(ghost);
    ghost.width = entry.canvas.width;
    ghost.height = entry.canvas.height;
    ghost.style.display = "block";
    ghost.getContext("2d").drawImage(entry.canvas, 0, 0);
  }

  function runFrame(dt) {
    clock.time += dt;
    const batch = queue;
    queue = [];
    for (const e of batch) {
      try { e.cb(t0 + clock.time); } catch (err) { console.error(err); }
    }
    capture();
    if (clock.onFrame) clock.onFrame(clock);
  }

  function syncAnimations() {
    const hold = clock.paused || clock.view > 0;
    for (const a of document.getAnimations()) {
      if (a.playbackRate !== clock.speed) a.playbackRate = clock.speed;
      if (hold && a.playState === "running") { a.pause(); a.__held = true; }
      else if (!hold && a.__held) { a.play(); a.__held = false; }
    }
  }

  let last = null;
  let steps = 0;
  function tick(now) {
    nativeRaf(tick);
    const gap = Math.max(0, now - (last ?? t0));
    const real = clock.speed === 1 ? gap : Math.min(gap, 100);
    last = now;
    syncAnimations();
    if (clock.view > 0) {
      if (!clock.paused) { clock.view--; showHistory(); }
      return;
    }
    if (steps > 0) { while (steps-- > 0) runFrame(FRAME_MS); steps = 0; return; }
    if (clock.paused) return;
    const dt = real * clock.speed;
    if (clock.stopAt !== null && clock.time + dt >= clock.stopAt) {
      const last = Math.max(0, clock.stopAt - clock.time);
      clock.stopAt = null;
      clock.paused = clock.stopped = true;
      if (last > 0) runFrame(last);
      return;
    }
    runFrame(dt);
  }
  nativeRaf(tick);

  clock.setPaused = (p) => { clock.paused = !!p; };
  clock.setSpeed = (s) => { clock.speed = s; };
  clock.stepForward = () => {
    if (clock.view > 0) { clock.view--; showHistory(); } else steps++;
  };
  clock.stepBack = () => {
    if (clock.view < ring.length - 1) { clock.view++; showHistory(); }
  };
  clock.stepsBehind = () => clock.view;
  clock.available = () => ring.length - 1 - clock.view;
  clock.redraw = () => {
    const batch = queue;
    if (!batch.length) return false;
    queue = [];
    for (const e of batch) {
      try { e.cb(t0 + clock.time); } catch (err) { console.error(err); }
    }
    return true;
  };
  clock.frameCanvas = () => (clock.view > 0 && ghost && ghost.style.display === "block" ? ghost : liveCanvas());
  clock.shownTime = () => (clock.view > 0 && ring.length ? ring[Math.max(0, ring.length - 1 - clock.view)].time : clock.time);
  window.__yigClock = clock;
})();
