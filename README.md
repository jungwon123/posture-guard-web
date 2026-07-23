# 척추요정 — 프론트엔드 (posture-guard-web)

웹캠으로 공부 자세를 실시간 감지하는 PWA. React + Vite + MediaPipe.
자세 판정(33포인트 랜드마크)은 **전부 사용자 기기 안에서** 실행되며 영상은 서버로 전송되지 않는다.

- 프로덕션: https://posture-guard-rust.vercel.app
- 백엔드 API: [posture-guard-api](https://github.com/jungwon123/posture-guard-api)

## 구조

| 경로 | 역할 |
|---|---|
| `src/app.js` | 감지 엔진 — MediaPipe 추론·판정·상태머신·렌더 |
| `src/posture3d.js` | 3D 절대 지표·임계값(논문 3편 근거)·드리프트 감지 |
| `src/core.js` | 개인 기준 z-score 판정·상태머신(히스테리시스) |
| `src/components/` | React UI (타이머·통계·상점·함께 공부·요정) |
| `test/` | 단위 테스트 (`node test/*.mjs`) |
| `docs/` | 발표 자료 · 임계값 선정 · 아키텍처 · 설계 기록(ADR) |

## 개발

```bash
npm install
npm run dev        # localhost:5173
for f in test/*.mjs; do node "$f"; done   # 테스트
```

URL 플래그: `?fwd=1` 디버그 오버레이 · `?tune=1` 임계값 튜닝 패널 · `?model=lite` 저사양 포즈 모델 · `?lkself=1` 셀프호스팅 SFU

## 배포

`main`에 push하면 GitHub Actions가 테스트 → 빌드 → Vercel 프로덕션 배포까지 자동 수행한다.
