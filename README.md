# 전력 ICT 지식백과 웹 포털

Notion `전력 ICT 지식백과`의 핵심 문서 20개와 검증된 원본 출처 416개를 탐색하는 GitHub Pages 사이트입니다.

## 구조

- `docs/index.html`: 로그인 및 포털 UI
- `docs/assets/app.js`: 검색·필터·본문 표시
- `docs/data/topics.json`: Notion 백과 문서 스냅샷 20개
- `docs/data/documents.json`: 원본 출처 색인 416개
- `docs/previews/*.json`: 브라우저에서 바로 읽는 문서별 정적 미리보기
- `scripts/build_previews.py`: HWP 및 기타 형식 미리보기 생성기

## 웹 문서 뷰어

- HWP 56개는 `rhwp v0.7.11`로 페이지별 텍스트를 추출해 웹 안에서 바로 읽습니다.
- PDF, XLSX/XLSM, PPTX, HWPX, Markdown, CSV, TXT, 이미지도 다운로드 없이 미리볼 수 있습니다.
- 원본 416개 모두에 미리보기 항목이 있으며, 암호화된 파일이나 실행 파일처럼 본문 해석이 불가능한 형식은 안전한 메타데이터 안내를 표시합니다.
- 계정정보 및 명백한 비밀번호·토큰 형태는 공개 정적 데이터에 포함하지 않고 자동 마스킹합니다.

미리보기를 다시 생성하려면:

```bash
python3 scripts/build_previews.py
```

## 접근 방식

정적 GitHub Pages의 단순 접속 코드 화면입니다. 브라우저에서 해시를 검사하므로 강한 서버 인증이 아니며, 민감정보 보호 수단으로 사용하면 안 됩니다.

## 로컬 확인

```bash
python3 -m http.server 4173 -d docs
```

브라우저에서 `http://localhost:4173`을 엽니다.
