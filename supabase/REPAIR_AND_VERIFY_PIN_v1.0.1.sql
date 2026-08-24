-- ============================================================
-- KCEM Public PIN Repair / Verify v1.0.1
-- 통합 Supabase 프로젝트 SQL Editor에서 실행하세요.
-- ============================================================

-- 1) 함수가 존재하는지 확인
select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
      'kcem_set_public_pin',
      'kcem_public_login',
      'kcem_public_sales',
      'kcem_public_logout'
  )
order by p.proname;

-- 2) API 실행 권한을 다시 보장
revoke all on function public.kcem_public_login(text, text) from public;
grant execute on function public.kcem_public_login(text, text) to anon, authenticated;

revoke all on function public.kcem_public_sales(text, integer) from public;
grant execute on function public.kcem_public_sales(text, integer) to anon, authenticated;

revoke all on function public.kcem_public_logout(text) from public;
grant execute on function public.kcem_public_logout(text) to anon, authenticated;

-- PIN 설정 함수는 웹에서는 실행 불가
revoke all on function public.kcem_set_public_pin(text) from public, anon, authenticated;

-- 3) 원본 테이블은 anon에게 계속 직접 공개하지 않음
revoke all on table public.kcem_sales from anon;
revoke all on table public.kcem_public_pin_config from public, anon, authenticated;
revoke all on table public.kcem_public_sessions from public, anon, authenticated;
revoke all on table public.kcem_public_login_attempts from public, anon, authenticated;

-- 4) PostgREST 스키마 캐시 강제 갱신
notify pgrst, 'reload schema';

-- 5) PIN 설정 여부 확인
select
    exists (
        select 1
        from public.kcem_public_pin_config
        where config_id = 1
    ) as pin_configured;

-- ============================================================
-- 아래 두 줄은 PIN을 실제 설정한 뒤 테스트용입니다.
-- '여기에실제PIN' 부분만 본인이 설정한 PIN으로 바꿔 실행하세요.
--
-- select * from public.kcem_public_login('여기에실제PIN', 'sql-test-device');
--
-- 성공하면 access_token / expires_at 두 값이 나옵니다.
-- 테스트 후 발급된 SQL 테스트 세션을 지워도 됩니다:
-- delete from public.kcem_public_sessions;
-- ============================================================
