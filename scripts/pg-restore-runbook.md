# Postgres restore runbook

Backups are written by `scripts/pg-backup.sh` (nightly systemd timer
`crystal-forge-backup.timer`) to `/var/backups/crystal-forge/{daily,weekly,monthly}/`.

Each archive is `crystal-forge-YYYY-MM-DD.tar` containing:

- `globals.sql` — roles/global objects (incl. every `<db>_app` login role)
- `<db>.dump` — one custom-format (`pg_dump -Fc`) dump per database
- `SHA256SUMS` — integrity manifest

All `psql`/`pg_restore` below run **inside** the `crystal-forge-pg` container as
superuser `crystal` (local socket auth = trust, no password). `pg_restore`
reads the dump from the host over stdin with `docker exec -i`.

## 0. Unpack an archive

```bash
cd /var/backups/crystal-forge
tar xf daily/crystal-forge-2026-07-27.tar          # -> crystal-forge-2026-07-27/
cd crystal-forge-2026-07-27
sha256sum -c SHA256SUMS                             # verify integrity
```

## 1. Undo an accidental DELETE — recover one table's rows

Restore the **whole** database into a throwaway DB, then copy the missing rows
across. Never restore straight over a live table you still care about.

> Don't try to shortcut this with `pg_restore -t interactions` into an empty DB:
> a table that uses a custom type (e.g. the `Direction` enum) fails, because
> `-t` restores only the table, not the type it depends on. Restoring the full
> DB to scratch always works and these DBs are tiny.

```bash
# scratch DB on the same server
docker exec crystal-forge-pg psql -U crystal -d postgres -c \
  'DROP DATABASE IF EXISTS scratch_restore;'
docker exec crystal-forge-pg psql -U crystal -d postgres -c \
  'CREATE DATABASE scratch_restore;'

# restore the full database (enum + all tables + data) into scratch
docker exec -i crystal-forge-pg pg_restore -U crystal -d scratch_restore \
  < crystal_lattice.dump

# generate INSERTs for the rows you need, review, then apply to the live DB:
docker exec crystal-forge-pg pg_dump -U crystal -d scratch_restore \
  --data-only --table=interactions --column-inserts > /tmp/interactions.sql
#   ...edit down to the specific rows, then:
#   docker exec -i crystal-forge-pg psql -U crystal -d crystal_lattice < /tmp/interactions.sql

# tidy up
docker exec crystal-forge-pg psql -U crystal -d postgres -c \
  'DROP DATABASE scratch_restore;'
```

> Note: `-Fc` dumps still allow selective `--data-only --table=...` *extraction*
> (as above) and `-t` restore when the target already has the schema/types. A
> plain `pg_dumpall` gives none of this — that's why we dump per-DB in custom
> format.

## 2. Restore an entire database (in place)

```bash
# recreate objects and data; --clean drops existing objects first
docker exec -i crystal-forge-pg pg_restore -U crystal -d crystal_lattice \
  --clean --if-exists < crystal_lattice.dump
```

To restore into a fresh database instead:

```bash
docker exec crystal-forge-pg psql -U crystal -d postgres -c \
  'CREATE DATABASE crystal_lattice_new;'
docker exec -i crystal-forge-pg pg_restore -U crystal -d crystal_lattice_new \
  < crystal_lattice.dump
```

## 3. Full-cluster rebuild (bare metal / new server)

```bash
# 1. roles and other globals FIRST (so per-DB ownership/grants resolve)
docker exec -i crystal-forge-pg psql -U crystal -d postgres < globals.sql

# 2. each database
for f in *.dump; do
  db="${f%.dump}"
  docker exec crystal-forge-pg psql -U crystal -d postgres -c \
    "CREATE DATABASE \"$db\";" 2>/dev/null || true
  docker exec -i crystal-forge-pg pg_restore -U crystal -d "$db" < "$f"
done
```

## Which tier to pull from

- Deletion noticed within ~1 month  → `daily/`   (day-level granularity)
- within ~6 months                  → `weekly/`  (week-level)
- within ~2 years                   → `monthly/` (month-level)

Pick the newest archive dated **before** the data was lost.
