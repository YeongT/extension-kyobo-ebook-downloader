# Git & Versioning Guide

## Versioning

- **Git tag** 가 유일한 버전 소스 (e.g. `v1.0.0`, `v1.2.0`)
- `manifest.json`의 `"version"` 필드는 **최신 태그와 항상 일치**해야 함
- 커밋 메시지에 버전 번호를 포함하지 않음

### Semantic Versioning: `MAJOR.MINOR.PATCH`

| 구분 | 버전 변화 | 의미 | 예시 |
|------|-----------|------|------|
| **MAJOR** | `1.x.x` → `2.0.0` | 완전 개편 / 시즌 변경 | 아키텍처 재설계, UI 전면 개편 |
| **MINOR** | `1.2.x` → `1.3.0` | 새 기능 추가 (기능 수 증가) | 설정 페이지, 새 다운로드 모드 |
| **PATCH** | `1.2.0` → `1.2.1` | 버그 수정 / hotfix | 시크 오류 수정, 메모리 누수 해결 |

### 버전 올리기 절차

1. `manifest.json`의 `"version"` 업데이트
2. `popup/popup.html`의 `<span class="version">` 텍스트도 일치시킴
3. 변경사항 커밋
4. `git tag vX.Y.Z` 로 태그 생성

### Hotfix 브랜치 전략

- 긴급 버그 수정: `hotfix/간단설명` 브랜치에서 작업 → main에 머지
- PATCH 버전만 올림 (e.g. `v1.2.0` → `v1.2.1`)
- hotfix 커밋 타입: `fix:`

### 버전업 판단 기준

```
질문: 이 변경이 기존 기능을 깨뜨리나? → Yes → MAJOR
질문: 새로운 기능이 추가되었나?       → Yes → MINOR
질문: 기존 기능의 버그 수정인가?      → Yes → PATCH
```

## Commit Message Format

```
<type>: <short summary in English>

<한국어 상세 변경 내역>
- 항목1
- 항목2
```

### 첫 줄 (제목)

- **영어**, conventional commit 형식
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`
- 70자 이내, 마침표 없음
- 버전 번호 포함 금지

### 본문

- **한국어**로 상세하게 작성
- 빈 줄로 제목과 구분
- 변경 항목별 `-` 로 나열
- 왜 변경했는지 맥락 포함

### 예시

```
feat: add auto-play and manual URL input

- 자동 재생 (Auto Play) 체크박스 추가, 영상 종료 시 다음 항목 자동 재생
- 그룹별 재생 버튼으로 특정 해상도 그룹 연속 재생
- 수동 URL 입력란 추가 (M3U8/MP4 붙여넣기 → 분석 → 큐 추가)
- 큐 항목에 썸네일 표시
- 그룹 최대 높이 제한 및 그룹 간 여백 추가
```

## Branch 전략

- **기본 브랜치**: `master`
- 긴급 수정: `hotfix/간단설명` → `master` 머지 → PATCH 버전업
- 기능 개발: `feat/간단설명` → `master` 머지 → MINOR 버전업

## Tagging

```bash
# 태그 생성
git tag v1.2.0

# 태그 목록
git tag -l

# 태그 푸시 (→ GitHub Actions가 자동으로 Release 생성)
git push origin --tags
```

## Release 자동화

- `.github/workflows/release.yml` 워크플로우가 태그 푸시 시 자동 실행
- 확장 프로그램 파일을 `.zip`으로 패키징 → GitHub Release에 첨부
- Release 노트는 이전 태그 이후 커밋에서 자동 생성
