-- Le dessin n'est plus stocké qu'en PNG (aperçu): fin du projet JSON.
drop policy if exists storage_projects_insert on storage.objects;
drop policy if exists storage_projects_read on storage.objects;

delete from public.drawing_assets where kind <> 'preview';
alter table public.drawing_assets drop constraint drawing_assets_kind_check;
alter table public.drawing_assets add constraint drawing_assets_kind_check check (kind = 'preview');

alter table public.drawing_projects drop column format_version;
