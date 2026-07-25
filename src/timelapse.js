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
const APP_URL = "posture-guard-rust.vercel.app";
function drawFrame(ctx, video, hud) {
  const { W, H } = TL;
  ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, W, H);
  // 카메라(4:3)를 가로 꽉 차게, 세로 중앙보다 살짝 위에 (거울 반전 = 앱 화면과 동일)
  const vw = W, vh = W * (video.videoHeight / video.videoWidth), vy = (H - vh) / 2 - 60;
  ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, vy, vw, vh);
  ctx.restore();
  // ── 상단 브랜드 바 (반투명) — 어떤 배경 위에서도 앱 표식이 또렷하게 ──
  ctx.fillStyle = "rgba(16,20,24,0.72)";
  ctx.fillRect(0, 0, W, 132);
  if (logoImg?.complete && logoImg.naturalWidth) ctx.drawImage(logoImg, 28, 34, 64, 64);
  ctx.textAlign = "left";
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 38px sans-serif";
  ctx.fillText("척추요정", 108, 66);
  ctx.fillStyle = "#5abe5a"; ctx.font = "700 24px sans-serif";
  ctx.fillText("자세 감지 공부 인증", 108, 102);
  ctx.fillStyle = "#8b98a5"; ctx.font = "24px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(hud.date, W - 28, 84);
  // ── 하단 브랜드 바 (반투명) — 타이머 + 자세 점수(앱만 만드는 값) + 앱 주소 ──
  ctx.fillStyle = "rgba(16,20,24,0.72)";
  ctx.fillRect(0, H - 260, W, 260);
  ctx.textAlign = "center";
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 108px sans-serif";
  ctx.fillText(hud.timer, W / 2, H - 130);
  if (hud.sub) {
    ctx.fillStyle = "#5abe5a"; ctx.font = "700 34px sans-serif";
    ctx.fillText(hud.sub, W / 2, H - 78);
  }
  // 앱 주소 — "우리 앱으로 만들었다"는 증거
  ctx.fillStyle = "#8b98a5"; ctx.font = "600 26px sans-serif";
  ctx.fillText(`척추요정 앱으로 측정  ·  ${APP_URL}`, W / 2, H - 32);
  // 요정 스프라이트 (하단 바 위, 오른쪽)
  if (hud.fairy?.complete && hud.fairy.naturalWidth) ctx.drawImage(hud.fairy, W - 168, H - 400, 130, 130);
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

// ── 오늘 통계 카드 (9:16 PNG, 즉시 생성) — 앱의 실제 통계를 담아 인스타 스토리 공유 ──
// info = { date, time, stats:[{value,label}]×최대4, subjectLine?, fairy? }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const fmtMin = (sec) => Math.round(sec / 60) + "분";
export async function makeStatsCard(info) {
  const { W, H } = TL;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#101418"); g.addColorStop(1, "#1a222b");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  // 헤더
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 46px sans-serif";
  ctx.fillText("척추요정 공부 인증", W / 2, 96);
  ctx.fillStyle = "#8b98a5"; ctx.font = "26px sans-serif";
  ctx.fillText(info.date, W / 2, 138);
  // 히어로 — 오늘 공부 시간
  ctx.fillStyle = "#8b98a5"; ctx.font = "700 28px sans-serif";
  ctx.fillText("오늘 공부 시간", W / 2, 200);
  ctx.fillStyle = "#e7ecf1"; ctx.font = "800 84px sans-serif";
  ctx.fillText(info.time, W / 2, 278);

  const donut = info.donut || [], btot = info.btot || 0, daily = info.daily || [];
  // ── 도넛: 오늘 자세 비율 (통계창과 동일) ──
  const cx = W / 2, cy = 470, rOut = 118, rIn = 76;
  if (btot > 0) {
    let a0 = -Math.PI / 2;
    donut.forEach((s) => {
      const a1 = a0 + (s.value / btot) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rOut, a0, a1); ctx.closePath();
      ctx.fillStyle = s.color; ctx.fill(); a0 = a1;
    });
    ctx.beginPath(); ctx.arc(cx, cy, rIn, 0, Math.PI * 2); ctx.fillStyle = "#14171e"; ctx.fill(); // 가운데 구멍
    ctx.fillStyle = "#4fd07a"; ctx.font = "800 58px sans-serif"; ctx.fillText(`${info.goodPct}%`, cx, cy + 6);
    ctx.fillStyle = "#8b98a5"; ctx.font = "600 24px sans-serif"; ctx.fillText("바른 자세", cx, cy + 44);
    // 범례 2×2
    ctx.textAlign = "left";
    donut.slice(0, 4).forEach((s, i) => {
      const lx = i % 2 === 0 ? W / 2 - 300 : W / 2 + 20, ly = 648 + Math.floor(i / 2) * 44;
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(lx, ly - 8, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e7ecf1"; ctx.font = "24px sans-serif";
      ctx.fillText(`${s.label} ${fmtMin(s.value)}`, lx + 24, ly);
    });
    ctx.textAlign = "center";
  } else {
    ctx.fillStyle = "#8b98a5"; ctx.font = "28px sans-serif";
    ctx.fillText("오늘 자세 기록이 아직 없어요", W / 2, cy + 6);
  }

  // ── 막대: 최근 7일 공부시간 (통계창과 동일 색/라벨) ──
  ctx.textAlign = "left"; ctx.fillStyle = "#8b98a5"; ctx.font = "700 28px sans-serif";
  ctx.fillText("최근 7일 공부시간", 70, 762);
  const x0 = 70, x1 = W - 70, yBase = 1010, maxH = 170;
  const maxMin = Math.max(30, ...daily.map((d) => d.min));
  const niceMax = Math.ceil(maxMin / 30) * 30;
  const slot = (x1 - x0) / 7, bw = slot * 0.54;
  ctx.strokeStyle = "#2a323c"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, yBase); ctx.lineTo(x1, yBase); ctx.stroke(); // 바닥선
  daily.forEach((d, i) => {
    const bx = x0 + i * slot + (slot - bw) / 2;
    const h = d.hasData ? Math.max(6, (d.min / niceMax) * maxH) : 0;
    const col = !d.hasData ? "#3a4260" : d.acc >= 70 ? "#4fd07a" : d.acc >= 40 ? "#f59e2b" : "#ff7a7a";
    if (h > 0) {
      ctx.fillStyle = col; ctx.globalAlpha = d.today ? 1 : 0.82;
      roundRect(ctx, bx, yBase - h, bw, h, 8); ctx.fill(); ctx.globalAlpha = 1;
      if (d.today) { ctx.strokeStyle = "#5abe5a"; ctx.lineWidth = 3; roundRect(ctx, bx, yBase - h, bw, h, 8); ctx.stroke(); }
      ctx.fillStyle = "#8b98a5"; ctx.font = "700 22px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${d.acc}%`, bx + bw / 2, yBase - h - 12);
    }
    ctx.fillStyle = d.today ? "#5abe5a" : "#8b98a5"; ctx.font = `${d.today ? "700 " : ""}24px sans-serif`; ctx.textAlign = "center";
    ctx.fillText(d.label, bx + bw / 2, yBase + 34);
  });

  // ── 하단: 부가 통계 + 앱 브랜딩 (앱 사용 증거) ──
  ctx.textAlign = "center";
  const extra = [];
  if (info.streak > 0) extra.push(`연속 출석 ${info.streak}일`);
  if (info.blinkAvg != null) extra.push(`눈 깜빡임 ${info.blinkAvg}회/분`);
  if (extra.length) { ctx.fillStyle = "#8b98a5"; ctx.font = "600 26px sans-serif"; ctx.fillText(extra.join("   ·   "), W / 2, 1108); }
  ctx.fillStyle = "#5abe5a"; ctx.font = "700 26px sans-serif";
  ctx.fillText(`척추요정  ·  ${APP_URL}`, W / 2, 1160);

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
