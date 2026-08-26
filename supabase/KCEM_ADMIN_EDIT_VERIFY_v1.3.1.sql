-- KCEM Web v1.3.1 관리자 수정/삭제 권한 확인
-- 기존 kcem_user_roles / kcem_sales 구조를 유지합니다.

-- 관리자 역할 확인
select
    ur.user_id,
    ur.role,
    au.email
from public.kcem_user_roles ur
left join auth.users au
    on au.id = ur.user_id
order by ur.created_at;

-- kcem_sales authenticated 권한 보장
grant select, insert, update, delete
on table public.kcem_sales
to authenticated;

-- 관리자 조회
drop policy if exists "kcem sales read"
on public.kcem_sales;

create policy "kcem sales read"
on public.kcem_sales
for select
to authenticated
using (
    exists (
        select 1
        from public.kcem_user_roles r
        where r.user_id = (select auth.uid())
          and r.role in ('admin', 'viewer')
    )
);

-- 관리자 수정
drop policy if exists "kcem sales update admin"
on public.kcem_sales;

create policy "kcem sales update admin"
on public.kcem_sales
for update
to authenticated
using (
    exists (
        select 1
        from public.kcem_user_roles r
        where r.user_id = (select auth.uid())
          and r.role = 'admin'
    )
)
with check (
    exists (
        select 1
        from public.kcem_user_roles r
        where r.user_id = (select auth.uid())
          and r.role = 'admin'
    )
);

-- 관리자 삭제
drop policy if exists "kcem sales delete admin"
on public.kcem_sales;

create policy "kcem sales delete admin"
on public.kcem_sales
for delete
to authenticated
using (
    exists (
        select 1
        from public.kcem_user_roles r
        where r.user_id = (select auth.uid())
          and r.role = 'admin'
    )
);

notify pgrst, 'reload schema';
