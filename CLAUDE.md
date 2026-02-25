# Poke Co CLI

TypeScript CLI for The Poke Co restaurant ordering API. Works with Bun or Node (via tsx).

## Commands

`./index.ts <command>` — locations, hours, categories, search, menu, order

## Dev Setup

```bash
npm install          # or bun install
./index.ts locations                          # no auth needed
POKE_TOKEN=xxx ./index.ts order --from order.json  # auth needed
```

## Key Files

- `index.ts` — CLI entry point, all commands
- `src/client/sdk.gen.ts` — generated API client (do not edit)
- `src/client/types.gen.ts` — generated types (do not edit)
- `openapi.yaml` — API spec, source of truth for client generation
- `.claude/skills/poke/SKILL.md` — agent skill file with workflow + order format

## Environment Variables

- `POKE_TOKEN` — JWT auth token (required for placing orders)

## Conventions

- All output is JSON to stdout, errors are `{ "error": "..." }` to stderr
- Location/item matching is case-insensitive partial match
- Generated client files in `src/client/` should not be manually edited
