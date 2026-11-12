import { Rive } from "@rive-app/canvas";

const FILES = [
  { src: "yig-ch1.riv", opens: "loading", ends: "ad", noIntro: ["loading", "ad"] },
  { src: "yig-ch2.riv", opens: "from-chapter-1", ends: "to-chapter-3", noIntro: ["from-chapter-1", "to-chapter-3"], lockup: true },
  { src: "yig-ch3.riv", opens: "ad", ends: "end", noIntro: ["ad"] },
];
const ROOMS = [
  [3, ["ad", "chapter-3-personal-badges", "chapter-3-event-badges"]],
  [3, ["chapter-3", "chapter-3-2"]],
  [3, ["chapter-4", "chapter-4-top-game", "chapter-4-editor-video"]],
  [3, ["end", "share"]],
];
const roomOf = (file, scene) => ROOMS.find(([f, list]) => f === file && list.includes(scene))?.[1][0] ?? scene;
const GAME_ORDER = ["wordle", "connections", "spelling-bee", "mini", "midi", "crossword", "strands"];
const COMMUNITY_GAMES = ["wordle", "connections", "spelling-bee", "mini", "strands"];
const REVEAL_FADE_MS = 1450;
const PAN_MS = 1650;

let stage = null;
let files = [];
let cards = [];
let frame = 0;
let shown = 0;
let visited = new Set();
let copyFrom = {};
let firstVisits = {};
let pan = { dir: 0, endsAt: 0 };
let heldTimer = 0;
let holdToken = 0;
let swapTimer = 0;
let hopTimer = 0;
let hopRun = null;
let seenAds = new Set();
let signalMode = true;
let reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
let logFn = null;
let pending = null;
let cancelled = null;
const BACKSTOP_EXTRA_MS = 500;

function start(el, list) {
  stage = el;
  cards = list.map((c) => ({ ...c }));
  cards.forEach((c, i) => {
    const next = cards[i + 1];
    if (next && next.file !== c.file && next.file !== c.file + 1) {
      throw new Error(`card ${i}: file ${c.file} is followed by file ${next.file}; files go in order`);
    }
  });
  frame = 0;
  shown = 0;
  visited = new Set(FILES.map((f, i) => `${i + 1}:${f.opens}`));
  seenAds = new Set();
  copyFrom = {};
  firstVisits = {};
  pan = { dir: 0, endsAt: 0 };
  files = FILES.map(() => null);
  load(0);
  showCopy(0, { changed: true, delay: 0 });
}

function load(i) {
  const canvas = document.createElement("canvas");
  canvas.className = "yig-file";
  canvas.style.visibility = i === shown ? "visible" : "hidden";
  stage.append(canvas);
  const f = { canvas, rive: null, loaded: false };
  f.ready = new Promise((resolve) => {
    f.rive = new Rive({
      src: FILES[i].src,
      canvas,
      stateMachines: "Backdrop",
      autoplay: true,
      autoBind: true,
      onLoad: () => {
        f.rive.resizeDrawingSurfaceToCanvas();
        applyReducedMotion(f);
        const top = cards.find((c) => c.topGame)?.topGame;
        if (top && f.rive.viewModelInstance.enum("topGame")) f.rive.viewModelInstance.enum("topGame").value = top;
        f.loaded = true;
        f.signal = false;
        try {
          const t = f.rive.viewModelInstance.trigger("copyReady");
          if (t) { f.signal = true; t.on(() => onFire(i)); }
        } catch { /* not declared */ }
        requestAnimationFrame(() => requestAnimationFrame(() => { if (i !== shown) f.rive.pause(); }));
        if (i + 1 < FILES.length && !files[i + 1]) load(i + 1);
        resolve();
      },
    });
  });
  files[i] = f;
}

function revealChanges(card) {
  if (card.reveal === undefined) return false;
  const f = files[card.file - 1];
  const prop = f?.loaded && f.rive.viewModelInstance.boolean("reveal");
  return !!prop && prop.value !== !!card.reveal;
}

function applyReveal(card) {
  if (card.reveal === undefined) return;
  const f = files[card.file - 1];
  const prop = f?.loaded && f.rive.viewModelInstance.boolean("reveal");
  if (prop) prop.value = !!card.reveal;
}

function setScene(i, scene, step, community, reveal) {
  const vm = files[i].rive.viewModelInstance;
  vm.enum("direction").value = step < 0 ? "back" : "forward";
  if (FILES[i].lockup) vm.boolean("lockup").value = !community;
  if (reveal !== undefined && vm.boolean("reveal")) vm.boolean("reveal").value = !!reveal;
  vm.enum("scene").value = scene;
}

function show(i) {
  if (i === shown) return;
  const old = files[shown];
  const f = files[i];
  f.canvas.style.visibility = "visible";
  f.canvas.style.zIndex = "1";
  f.rive.play();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    old.canvas.style.visibility = "hidden";
    old.canvas.style.zIndex = "";
    old.rive.pause();
    f.canvas.style.zIndex = "";
  }));
  shown = i;
}

function onTap() {
  move(+1);
}

function onBack() {
  move(-1);
}

function landing(step) {
  let target = frame + step;
  while (cards[target]?.ad && seenAds.has(target)) target += step;
  return target;
}

function move(step) {
  clearTimeout(heldTimer);
  const token = ++holdToken;
  const target = landing(step);
  if (target < 1 && step < 0) return;
  if (target < 0 || target > cards.length - 1) return;
  const from = cards[frame];
  const to = cards[target];
  const sceneChange = to.file !== from.file || to.scene !== from.scene;
  const roomChange = to.file !== from.file || roomOf(to.file, to.scene) !== roomOf(from.file, from.scene);
  const now = performance.now();
  const legs = to.file !== from.file && (step > 0 ? from.scene !== FILES[from.file - 1].ends : to.scene !== FILES[to.file - 1].ends) ? 2 : 1;
  if (roomChange && pan.endsAt > now && (step < 0 || pan.dir < 0)) {
    heldTimer = setTimeout(() => move(step), pan.endsAt - now);
    return;
  }
  const fi = to.file - 1;
  if (step > 0 && !files[fi]?.loaded) {
    if (!files[fi]) load(fi);
    files[fi].ready.then(() => { if (token === holdToken) move(step); });
    return;
  }
  if (roomChange) clearTimeout(swapTimer);
  if (sceneChange && hopRun) { clearTimeout(hopTimer); hopRun(); }
  frame = target;
  if (to.ad) seenAds.add(target);
  const fading = !roomChange && revealChanges(to);
  if (!sceneChange) applyReveal(to);
  const room = roomOf(to.file, to.scene);
  const key = `${to.file}:${room}`;
  const firstVisit = roomChange && step > 0 && !visited.has(key) && !FILES[fi].noIntro.includes(room);
  if (roomChange) {
    pan = { dir: step, endsAt: now + PAN_MS * legs };
    if (to.file === from.file) {
      setScene(fi, to.scene, step, !!to.community, to.reveal);
    } else if (step > 0) {
      const takeOver = () => { hopRun = null; show(fi); setScene(fi, to.scene, step, !!to.community, to.reveal); };
      if (legs === 1) {
        takeOver();
      } else {
        setScene(from.file - 1, FILES[from.file - 1].ends, step, false);
        hopRun = takeOver;
        hopTimer = setTimeout(takeOver, PAN_MS);
      }
    } else {
      setScene(from.file - 1, FILES[from.file - 1].opens, step, false);
      swapTimer = setTimeout(() => { show(fi); if (legs === 2) setScene(fi, to.scene, step, !!to.community, to.reveal); }, PAN_MS);
    }
  }
  if (!roomChange && sceneChange) setScene(fi, to.scene, step, !!to.community, to.reveal);
  if (firstVisit) {
    visited.add(key);
    copyFrom[key] = now + (legs - 1) * PAN_MS + firstVisitCopyMs(to);
    firstVisits[key] = { setAt: now, waitKey: legs === 2 ? "crossing_to_new_room" : lockupShows(to) ? "game_first_card" : "first_visit" };
  }
  const iconChange = to.icon !== from.icon;
  const settleLeft = Math.max(0, (copyFrom[key] ?? 0) - now);
  let delay;
  if (!roomChange) delay = fading ? Math.max(settleLeft, REVEAL_FADE_MS) : settleLeft > 0 ? settleLeft : null;
  else if (firstVisit) delay = copyFrom[key] - now;
  else delay = Math.max(PAN_MS * legs, settleLeft);
  const onFirst = !firstVisit && settleLeft > 0 && delay === settleLeft && !!firstVisits[key];
  const waitKey = onFirst ? firstVisits[key].waitKey
    : firstVisit ? firstVisits[key].waitKey
    : !roomChange ? (fading ? "chapter_4_reveal" : "same_room")
    : legs === 2 ? "crossing_otherwise"
    : "seen_before";
  const path = !sceneChange ? "same scene" : to.file !== from.file || legs === 2 ? "crossing" : !roomChange ? "same room"
    : step < 0 ? "back" : firstVisit ? "first visit" : FILES[fi].noIntro.includes(room) ? "picture" : "revisit";
  showCopy(frame, { changed: roomChange || iconChange, delay, back: step < 0,
    sig: { file: to.file, scene: to.scene, path, waitKey, noSignal: !sceneChange, setAt: onFirst ? firstVisits[key].setAt : now } });
}

function lockupShows(card) {
  return card.file === 2 && GAME_ORDER.includes(card.scene) && !card.community;
}

function firstVisitCopyMs(card) {
  return lockupShows(card) ? cssMs("--yig-lockup", 3200) : cssMs("--yig-first-visit", 2000);
}

function showCopy(n, { changed, delay, back = false, sig = null }) {
  const visible = [...document.querySelectorAll(".yig-text:not([hidden]), .yig-icon:not([hidden])")];
  visible.filter((el) => changed || !el.classList.contains("yig-icon")).forEach((el) => leave(el, back));
  const o = { changed, delay, back };
  if (pending) clearTimeout(pending.timer);
  if (sig?.noSignal && pending && !pending.consumed && !pending.noSignal) cancelled = { ...pending };
  else if (sig && !sig.noSignal) cancelled = null;
  pending = null;
  if (!sig) return enterNew(n, o);
  const waitMs = delay === null ? clearMs() : delay;
  const p = pending = { setAt: performance.now(), ...sig, n, waitMs, consumed: false, timer: 0 };
  if (!signalMode) return enterNew(n, o);
  if (sig.noSignal) {
    p.consumed = true;
    enterNew(n, o);
    setTimeout(() => report(p, "same scene"), waitMs);
    return;
  }
  p.show = () => enterNew(n, { ...o, delay: delay === null ? null : 0 });
  p.timer = setTimeout(() => {
    if (p.consumed) return;
    p.consumed = true;
    report(p, `BACKSTOP (due ${+((waitMs + BACKSTOP_EXTRA_MS) / 1000).toFixed(2)} s)`, true);
    p.show();
  }, waitMs + BACKSTOP_EXTRA_MS);
}

function enterNew(n, { changed, delay, back = false }) {
  const next = document.querySelector(`[data-copy-frame="${n}"]`);
  const icon = cards[n].icon && document.querySelector(`[data-icon-game="${cards[n].icon}"]`);
  const iconStays = !changed && icon && !icon.hidden;
  if (delay === null && changed) delay = clearMs();
  if (icon && !iconStays) enter(icon, { delay, back });
  if (next) enter(next, delay === null ? { quick: true, back } : { delay, afterIcon: !!icon && !iconStays, back });
}

function onFire(i) {
  const p = pending;
  const sceneNow = () => files[i]?.rive.viewModelInstance.enum("scene").value;
  if (p && !p.consumed && !p.noSignal && p.file === i + 1) {
    p.consumed = true;
    clearTimeout(p.timer);
    report(p, signalMode ? "copyReady" : "Timer");
    if (signalMode) p.show();
  } else if (p && !p.consumed && p.path === "crossing" && p.file !== i + 1) {
    report({ ...p, file: i + 1, scene: sceneNow() }, "ignored", false, true);
  } else if (cancelled && cancelled.file === i + 1 && performance.now() <= cancelled.setAt + cancelled.waitMs + BACKSTOP_EXTRA_MS) {
    report(cancelled, "cancelled", false, true);
    cancelled = null;
  } else {
    report({ file: i + 1, scene: sceneNow(), path: "-", waitKey: null, setAt: null }, "STRAY", true, true);
  }
}

function report(p, how, red = false, fire = false) {
  if (!logFn) return;
  const since = p.setAt === null ? null : performance.now() - p.setAt;
  logFn({ time: Date.now(), name: "copyReady", file: p.file, scene: p.scene, path: p.path, waitKey: p.waitKey ?? null, since,
    frame: since === null ? null : Math.round(since * 60 / 1000), how, red, fire, wait: p.waitMs ?? null });
}

function setCopySignal(on) {
  signalMode = !!on;
}

function setReducedMotion(on) {
  reducedMotion = !!on;
  files.forEach((f) => f?.loaded && applyReducedMotion(f));
}

function applyReducedMotion(f) {
  try {
    const p = f.rive.viewModelInstance.boolean("reducedMotion");
    if (p) p.value = reducedMotion;
  } catch { /* not declared */ }
}

function onCopyLog(fn) {
  logFn = fn;
}

function signalFiles() {
  return files.map((f) => (f?.loaded ? !!f.signal : null));
}

function leave(el, back = false) {
  const settled = el.getAnimations({ subtree: true }).every((a) => a.playState === "finished");
  if (settled) {
    el.classList.toggle("yig-back", back);
    el.classList.add("yig-out");
    setTimeout(() => { el.hidden = true; }, clearMs());
  } else {
    el.hidden = true;
  }
}

function clearMs() {
  return cssMs("--yig-clear", 340);
}

function cssMs(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000;
  return Number.isFinite(ms) ? ms : fallback;
}

function enter(el, { quick = false, delay = null, afterIcon = false, back = false } = {}) {
  el.classList.remove("yig-in", "yig-out");
  el.classList.toggle("yig-quick", quick);
  el.classList.toggle("yig-after-icon", afterIcon);
  el.classList.toggle("yig-back", back);
  if (delay === null) el.style.removeProperty("--yig-delay");
  else el.style.setProperty("--yig-delay", `${delay}ms`);
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("yig-in");
}

function ready(file) {
  return files[file - 1]?.ready ?? Promise.resolve();
}

function resize() {
  files.forEach((f) => f?.loaded && f.rive.resizeDrawingSurfaceToCanvas());
}

const state = () => ({ frame, shown: shown + 1, card: cards[frame], scenes: files.map((f) => f?.loaded ? f.rive.viewModelInstance.enum("scene").value : null) });

export { start, onTap, onBack, ready, resize, state, setCopySignal, setReducedMotion, onCopyLog, signalFiles, FILES, GAME_ORDER, COMMUNITY_GAMES };
