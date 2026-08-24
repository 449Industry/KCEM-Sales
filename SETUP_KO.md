# KCEM 박물관 매출 웹 v1.0.1

## 구조

`OOZYSales → Supabase kcem_sales → PIN 조회 RPC → GitHub Pages`

웹페이지는 `kcem_sales`를 직접 읽지 않습니다.

공용 조회 PIN은 GitHub 소스에 저장하지 않고 Supabase DB에 bcrypt 해시로 저장합니다.
PIN 인증 성공 시 브라우저별 30일 조회 토큰이 발급됩니다.

---

## 1. Supabase에 PIN 조회 기능 설치

통합 Supabase 프로젝트의 SQL Editor에서:

`supabase/kcem_public_pin.sql`

내용 전체를 실행합니다.

마지막 결과:

```text
pin_configured
false
```

라면 정상입니다.

---

## 2. 공용 조회 PIN 설정

새 SQL Query에서 아래 한 줄을 실행합니다.

```sql
select public.kcem_set_public_pin('원하는PIN');
```

예를 들어 숫자 PIN이라면 8자리 이상을 권장합니다.

```sql
select public.kcem_set_public_pin('12345678');
```

실제 운영 PIN은 예시 번호를 사용하지 마세요.

PIN을 변경하면 기존 기기의 30일 인증 토큰이 모두 즉시 무효화됩니다.

---

## 3. 로컬 테스트

`RUN_LOCAL.bat`을 더블클릭합니다.

브라우저:

```text
http://localhost:8000
```

PIN을 입력하면 현재 통합 Supabase의 `kcem_sales`를 읽습니다.

이미 입력한 테스트 데이터가 있다면:

- 2026-08-24
- 계좌
- 3,000원
- 꼬마거북이

가 일매출 화면에 표시되어야 합니다.

---

## 4. 30일 인증

PIN 인증이 성공하면 브라우저 `localStorage`에 랜덤 조회 토큰과 만료시각만 저장됩니다.

PIN 자체는 저장하지 않습니다.

토큰 원문도 Supabase DB에는 저장하지 않고 SHA-256 해시만 저장합니다.

상단의 `이 기기 인증 해제` 버튼을 누르면 즉시 로그아웃됩니다.

---

## 5. 보안

`config.js`의 아래 두 값은 브라우저 공개용 값입니다.

- Supabase Project URL
- Supabase Publishable Key

`secret key`, `service_role key`, DB password는 절대로 GitHub에 올리지 않습니다.

현재 웹에 공개된 RPC는:

- `kcem_public_login` : PIN 인증
- `kcem_public_sales` : 토큰을 검증한 뒤 조회
- `kcem_public_logout` : 해당 토큰 폐기

뿐이며, 웹용 INSERT / UPDATE / DELETE RPC는 만들지 않았습니다.

`anon` 역할은 `kcem_sales` 테이블을 직접 조회할 수 없습니다.

---

## 6. 갱신

웹은 5초 간격으로 현재 선택 연도의 데이터를 다시 확인합니다.

따라서 OOZYSales가 `kcem_sales`에 거래를 저장하면 보통 몇 초 안에 웹 화면에 반영됩니다.

---

## 7. GitHub Pages

로컬 테스트를 마친 후 이 폴더 전체를 GitHub 저장소의 `main` 브랜치에 올립니다.

`.github/workflows/pages.yml`이 포함되어 있으므로 저장소의 Pages 설정을 GitHub Actions 방식으로 사용하면 자동 배포할 수 있습니다.

---

## 앞으로 동일하게 적용할 이름 규칙

- UWash: `uwash_*`
- OOZY Coffee: `oozy_*`
- KCEM Museum: `kcem_*`

공용 조회 PIN 구조도 필요하면 `uwash_public_*`, `oozy_public_*`로 동일 패턴을 재사용할 수 있습니다.


---

## 인증이 안 될 때

1. Supabase SQL Editor에서 `supabase/REPAIR_AND_VERIFY_PIN_v1.0.1.sql` 전체 실행
2. `pin_configured = true`인지 확인
3. 필요하면 `supabase/OPTIONAL_HEALTH_RPC.sql` 실행
4. 새 Query에서 직접 PIN 인증 테스트

```sql
select *
from public.kcem_public_login(
  '본인이설정한PIN',
  'sql-test-device'
);
```

정상이면 `access_token`, `expires_at`이 반환됩니다.

- SQL 테스트도 실패 → Supabase PIN/함수 문제
- SQL 테스트 성공 + 웹만 실패 → RPC 캐시/브라우저 연결 문제
- 복구 SQL에는 `notify pgrst, 'reload schema'`가 포함되어 API 스키마 캐시를 강제로 갱신합니다.


---

## GitHub 자동 배포

`GITHUB_DEPLOY.bat`을 더블클릭하면 다음 작업을 자동으로 수행합니다.

1. Git / GitHub CLI 확인 및 필요 시 설치
2. GitHub 공식 브라우저 로그인
3. 저장소 생성
4. 현재 웹 파일 Commit / Push
5. GitHub Pages를 GitHub Actions 방식으로 설정
6. Pages Workflow 실행
7. GitHub Actions 화면 열기

GitHub는 명령줄에서 계정 비밀번호 인증을 지원하지 않으므로,
비밀번호를 BAT 파일에 입력하거나 저장하지 않습니다.

첫 로그인 이후에는 저장된 GitHub 인증을 재사용합니다.
