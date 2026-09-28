-- Allow users to flip the `enabled` toggle on their own linked groups
-- (the bot worker writes group rows with the service role, bypassing RLS).
drop policy if exists "own linked_groups update" on public.linked_groups;
create policy "own linked_groups update" on public.linked_groups
  for update using (
    exists (
      select 1 from public.bot_links l
      where l.id = linked_groups.link_id and l.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.bot_links l
      where l.id = linked_groups.link_id and l.user_id = auth.uid()
    )
  );
