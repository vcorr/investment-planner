# Tables added by task agents

Each task defines its new tables in its own file here (e.g. `calendars.ts`), with `.enableRLS()`.
Task agents do not generate migrations: parallel branches would clash on migration numbers.
The main session runs `pnpm db:generate` after merging. See `docs/tasks/README.md`.
