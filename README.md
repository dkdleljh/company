# 전력 ICT 지식백과 웹 포털

Notion `전력 ICT 지식백과`의 핵심 문서 20개와 검증된 원본 출처 416개를 탐색하는 GitHub Pages 사이트입니다.

## 구조

- `docs/index.html`: 로그인 및 포털 UI
- `docs/assets/app.js`: 검색·필터·본문 표시
- `docs/data/topics.json`: Notion 백과 문서 스냅샷 20개
- `docs/data/documents.json`: 원본 출처 색인 416개

## 접근 방식

정적 GitHub Pages의 단순 접속 코드 화면입니다. 브라우저에서 해시를 검사하므로 강한 서버 인증이 아니며, 민감정보 보호 수단으로 사용하면 안 됩니다.

## 로컬 확인

```bash
python3 -m http.server 4173 -d docs
```

브라우저에서 `http://localhost:4173`을 엽니다.
