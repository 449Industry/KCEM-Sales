KCEM 박물관 매출 GitHub Pages v1.2.0

구조
- 원본 DB: public.kcem_sales
- 신규 등록: OOZYSales의 '박물관 매출' 탭에서만 수행
- 웹: 조회 + 기존 거래 수정/삭제
- 조회: 공용 PIN
- 수정/삭제: Supabase KCEM admin 이메일 로그인

최초 설정
1) Supabase SQL Editor에서 KCEM_Web_Read_API_v1.2.sql 실행
2) 같은 SQL 파일 맨 아래 주석의 UPDATE 문에서 CURRENT_PUBLIC_PIN을 현재 공용 PIN으로 바꿔 1회 실행
3) OOZYSales의 '웹 업로드 설정'을 저장하면 이 폴더 config.js에 동일 Project URL/Publishable Key가 자동 생성됨
4) GITHUB_DEPLOY_KCEM.bat 실행

주의
- PIN은 config.js/GitHub에 넣지 않습니다.
- 웹에서는 신규 매출 등록 기능을 제공하지 않습니다.
- kcem_sales를 anon에 직접 공개하지 않고 PIN 검증 RPC로 읽습니다.
