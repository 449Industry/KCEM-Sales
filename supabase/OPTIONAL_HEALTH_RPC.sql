-- Optional diagnostic RPC.
-- 인증 자체와 무관하며, 웹이 현재 Supabase 프로젝트의 RPC를 볼 수 있는지만 확인합니다.

create or replace function public.kcem_public_health()
returns jsonb
language sql
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'ok', true,
        'pin_configured',
        exists (
            select 1
            from public.kcem_public_pin_config
            where config_id = 1
        ),
        'server_time',
        now()
    );
$$;

revoke all on function public.kcem_public_health() from public;
grant execute on function public.kcem_public_health() to anon, authenticated;

notify pgrst, 'reload schema';
