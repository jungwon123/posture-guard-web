// 타임랩스 순수 로직 테스트 — FrameBudget·시간 계산·mime 선택. 실행: node test/timelapse.mjs
import { FrameBudget, durationSec, hudTime, pickMime, fileStamp, TL } from "../src/timelapse.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name); } };

console.log("— FrameBudget 간격");
const b = new FrameBudget({ gap: 2, cap: 10 });
ok("첫 호출은 즉시 due", b.due(0));
b.onStored(0);
ok("간격 미달이면 skip", !b.due(1.5));
ok("간격 경과면 due", b.due(2));

console.log("— 상한 도달 → 솎아내기 + 간격 배증");
const b2 = new FrameBudget({ gap: 2, cap: 4 });
let thin = null;
for (let t = 0; t < 10; t += 2) { if (b2.due(t)) thin = b2.onStored(t) || thin; }
ok("cap 도달 시 thin 신호", thin === "thin");
b2.onThinned(2);
ok("솎은 뒤 count 반영", b2.count === 2);
ok("간격 배증 2→4초", b2.gap === 4);
ok("배증 간격 미달이면 skip", !b2.due(b2.last + 3));
ok("배증 간격 경과면 due", b2.due(b2.last + 4));

console.log("— 시간·길이 계산");
ok("30fps 1800프레임 = 60초", durationSec(1800, 30) === 60);
ok("상한 2700프레임 = 90초", durationSec(TL.CAP, TL.FPS) === 90);
ok("hudTime 65초 → 01:05", hudTime(65) === "01:05");
ok("hudTime 3725초 → 1:02:05", hudTime(3725) === "1:02:05");
ok("hudTime 음수 방어 → 00:00", hudTime(-3) === "00:00");

console.log("— mime 선택 (인스타는 mp4만)");
const mp4 = pickMime((m) => m.startsWith("video/mp4"));
ok("mp4 지원 시 mp4 우선", mp4.mp4 === true && mp4.ext === "mp4");
const webm = pickMime((m) => m.startsWith("video/webm"));
ok("mp4 미지원 시 webm 폴백(공유 불가 플래그)", webm.mp4 === false && webm.ext === "webm");
ok("아무것도 미지원 → null", pickMime(() => false) === null);

console.log("— 파일명 날짜");
ok("fileStamp 형식", fileStamp(new Date(2026, 6, 24)) === "20260724");

console.log(`결과: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
