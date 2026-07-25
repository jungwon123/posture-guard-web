// 타임랩스 공부 인증 — 전 과정 온디바이스 (캡처 → IndexedDB → MediaRecorder 인코딩 → 공유 시트).
// 순수 로직(FrameBudget·시간 계산)은 브라우저 API를 건드리지 않아 node 테스트 가능.

// ── 캡처 예산: 2초 간격 시작, 상한 도달 시 절반 솎아내고 간격 배증 (장시간 공부도 출력 90초 상한) ──
export const TL = {
  BASE_GAP: 2,      // 캡처 간격(초)
  CAP: 2700,        // 프레임 상한 = 30fps × 90초
  FPS: 30,          // 출력 프레임률
  W: 720, H: 1280,  // 출력 해상도 (인스타 릴스 최소 권장)
  JPEG_Q: 0.68,
  MIN_FRAMES: 24,   // 약 50초 분량 — "1분 공부"가 예열 손실을 감안해도 통과하는 여유치
};

export class FrameBudget {
  constructor({ gap = TL.BASE_GAP, cap = TL.CAP } = {}) {
    this.gap = gap; this.cap = cap; this.last = -Infinity; this.count = 0;
  }
  // t(초)에 캡처해야 하나 — 간격 경과 시 true (호출측이 저장 성공 후 onStored 호출)
  due(t) { return t - this.last >= this.gap; }
  onStored(t) {
    this.last = t; this.count++;
    if (this.count >= this.cap) { // 솎아내기 신호 — 호출측이 홀수 프레임 삭제 후 onThinned
      return "thin";
    }
    return null;
  }
  onThinned(remaining) { this.count = remaining; this.gap *= 2; }
}

// 출력 길이(초) — 프레임 수 기준
export const durationSec = (frames, fps = TL.FPS) => frames / fps;

// HUD 타이머 텍스트 — 세션 경과(초) → "H:MM:SS" 또는 "MM:SS"
export function hudTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

// 인코딩 mime 선택 — 인스타는 mp4만 받으므로 mp4 우선, 안 되면 webm(저장 전용) 폴백
export function pickMime(isSupported) {
  const cands = [
    ["video/mp4;codecs=avc1.42E01E", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of cands) if (isSupported(mime)) return { mime, ext, mp4: ext === "mp4" };
  return null;
}

// ── IndexedDB 프레임 저장소 (세션 단위) ──
const DB = "pg_timelapse", STORE = "frames";
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export class FrameStore {
  constructor() { this.db = null; this.seq = 0; }
  async open() { this.db = await openDB(); }
  async clear() { await req(tx(this.db, "readwrite").clear()); this.seq = 0; }
  async put(blob) { await req(tx(this.db, "readwrite").put(blob, this.seq)); this.seq++; }
  async keys() { return req(tx(this.db, "readonly").getAllKeys()); }
  async get(key) { return req(tx(this.db, "readonly").get(key)); }
  async delete(key) { return req(tx(this.db, "readwrite").delete(key)); }
  // 홀수 인덱스 프레임 삭제 → 남은 수 반환 (FrameBudget.onThinned에 전달)
  async thin() {
    const ks = await this.keys();
    const drop = ks.filter((_, i) => i % 2 === 1);
    for (const k of drop) await this.delete(k);
    return ks.length - drop.length;
  }
  async count() { return (await this.keys()).length; }
}

// ── 캡처 세션 (app.js가 사용) ──
let store = null, budget = null, capCanvas = null, busy = false;
let logoImg = null;
// 디버그 카운터 — 실기기에서 "왜 안 찍히나"를 바로 진단 (window.__tlDebug)
const dbg = { calls: 0, notReady: 0, busySkip: 0, notDue: 0, noVideo: 0, drawn: 0, stored: 0, putErr: 0, lastErr: null };
if (typeof window !== "undefined") window.__tlDebug = () => ({ ...dbg, hasStore: !!store, hasBudget: !!budget, busy, count: budget?.count ?? -1, gap: budget?.gap });

async function ensureStore() { // clear 없이 열기 — 리로드 후에도 직전 세션 프레임 접근 가능
  if (!store) { store = new FrameStore(); await store.open(); }
  return store;
}

export async function beginSession() {
  await ensureStore();
  await store.clear();
  budget = new FrameBudget();
  if (!capCanvas) { capCanvas = document.createElement("canvas"); capCanvas.width = TL.W; capCanvas.height = TL.H; }
  if (!logoImg) { logoImg = new Image(); logoImg.src = "/assets/ui/logo.png"; }
}

export function frameCount() { return budget ? budget.count : 0; }
// IndexedDB 실측 카운트 — 리로드로 세션 메모리가 날아가도 직전 세션 프레임을 셀 수 있다
export async function storedCount() {
  try { return await (await ensureStore()).count(); } catch { return 0; }
}

// 매 틱 호출 — 간격이 됐고 인코딩 바쁘지 않을 때만 실제 캡처
export function maybeCapture(video, hud, now) {
  dbg.calls++;
  if (!store || !budget) { dbg.notReady++; return; }
  if (busy) { dbg.busySkip++; return; }
  if (!budget.due(now)) { dbg.notDue++; return; }
  if (!video.videoWidth) { dbg.noVideo++; return; }
  busy = true;
  try {
    drawFrame(capCanvas.getContext("2d"), video, hud);
    dbg.drawn++;
    capCanvas.toBlob(async (blob) => {
      try {
        if (blob && store) {
          await store.put(blob);
          dbg.stored++;
          if (budget.onStored(now) === "thin") budget.onThinned(await store.thin());
        }
      } catch (e) { dbg.putErr++; dbg.lastErr = String(e); } finally { busy = false; }
    }, "image/jpeg", TL.JPEG_Q);
  } catch (e) { busy = false; dbg.lastErr = String(e); }
}

// 9:16 프레임 렌더 — 중앙 카메라 + 상단 로고·날짜 + 하단 타이머·바른자세 비율·요정
function drawFrame(ctx, video, hud) {
  const { W, H } = TL;
  ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, W, H);
  // 카메라(4:3)를 가로 꽉 차게, 세로 중앙보다 살짝 위에 (거울 반전 = 앱 화면과 동일)
  const vw = W, vh = W * (video.videoHeight / video.videoWidth), vy = (H - vh) / 2 - 60;
  ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, vy, vw, vh);
  ctx.restore();
  // 상단 — 로고 + 타이틀 + 날짜
  if (logoImg?.complete && logoImg.naturalWidth) ctx.drawImage(logoImg, 40, 44, 64, 64);
  ctx.fillStyle = "#e7ecf1"; ctx.font = "700 40px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("척추요정 공부 인증", 120, 88);
  ctx.fillStyle = "#8b98a5"; ctx.font = "26px sans-serif";
  ctx.fillText(hud.date, 122, 126);
  // 하단 — 큰 타이머 + 비율
  ctx.textAlign = "center";
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 110px sans-serif";
  ctx.fillText(hud.timer, W / 2, H - 170);
  ctx.fillStyle = "#5abe5a"; ctx.font = "700 34px sans-serif";
  ctx.fillText(hud.sub, W / 2, H - 100);
  // 요정 스프라이트 (하단 오른쪽)
  if (hud.fairy?.complete && hud.fairy.naturalWidth) ctx.drawImage(hud.fairy, W - 180, H - 320, 140, 140);
  ctx.textAlign = "left";
}

// ── 인코딩: 저장된 프레임을 30fps로 재생하며 MediaRecorder로 굽기 ──
export async function encode(onProgress) {
  await ensureStore();
  const keys = await store.keys();
  if (!keys.length) throw new Error("프레임 없음");
  const picked = pickMime((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
  if (!picked) throw new Error("이 브라우저는 영상 인코딩을 지원하지 않아요");
  const canvas = document.createElement("canvas");
  canvas.width = TL.W; canvas.height = TL.H;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(TL.FPS);
  const rec = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(1000);
  const gap = 1000 / TL.FPS;
  let next = performance.now();
  for (let i = 0; i < keys.length; i++) {
    const blob = await store.get(keys[i]);
    if (blob) {
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, TL.W, TL.H);
      bmp.close();
    }
    onProgress?.(i + 1, keys.length);
    next += gap;
    const wait = next - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await new Promise((r) => setTimeout(r, 300)); // 마지막 프레임 플러시
  rec.stop();
  await done;
  return { blob: new Blob(chunks, { type: picked.mime.split(";")[0] }), ...picked, shareable: picked.mp4, frames: keys.length };
}

// ── 오늘 통계 카드 (9:16 PNG, 즉시 생성) — 타임랩스와 같은 규격으로 인스타 스토리 공유용 ──
export async function makeStatsCard(info) {
  const { W, H } = TL;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#101418"); g.addColorStop(1, "#1a222b");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 52px sans-serif";
  ctx.fillText("척추요정 공부 인증", W / 2, 250);
  ctx.fillStyle = "#8b98a5"; ctx.font = "30px sans-serif";
  ctx.fillText(info.date, W / 2, 300);
  // 중앙 — 큰 오늘 공부 시간
  ctx.fillStyle = "#8b98a5"; ctx.font = "700 36px sans-serif";
  ctx.fillText("오늘 공부 시간", W / 2, 560);
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 132px sans-serif";
  ctx.fillText(info.time, W / 2, 700);
  // 스탯 2단 — 바른 자세 시간 · 바름 비율
  const stat = (x, big, small) => {
    ctx.fillStyle = "#5abe5a"; ctx.font = "800 64px sans-serif"; ctx.fillText(big, x, 880);
    ctx.fillStyle = "#8b98a5"; ctx.font = "600 30px sans-serif"; ctx.fillText(small, x, 930);
  };
  stat(W / 2 - 160, info.goodMin, "바른 자세");
  stat(W / 2 + 160, info.ratio, "바름 비율");
  // 요정 — 하단 중앙 마무리
  if (info.fairy?.complete && info.fairy.naturalWidth) ctx.drawImage(info.fairy, W / 2 - 110, 1010, 220, 220);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return { blob, ext: "png", shareable: true, frames: 0 };
}

// ── 공유/저장 ──
export async function share(result) {
  const file = new File([result.blob], `척추요정-공부인증-${fileStamp()}.${result.ext}`, { type: result.blob.type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return true; }
  return false; // 호출측이 저장으로 폴백
}

export function download(result) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(result.blob);
  a.download = `척추요정-공부인증-${fileStamp()}.${result.ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
