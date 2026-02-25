# Poke Co Ordering CLI

CLI for browsing menus and placing orders at The Poke Co (South Africa).

## Commands

| Command | Flags | Output |
|---------|-------|--------|
| `locations` | — | All locations with open/closed status |
| `hours --location <name>` | `--location` (partial match) | `{ name, is_open, kitchen_status, can_collection, can_delivery }` |
| `categories --location <name>` | `--location` | `[{ category, item_count }]` |
| `search --location <name> --query <text>` | `--location`, `--query`, optional `--category` | Matching items with prices, types, deal groups |
| `menu --location <name>` | `--location` | Full menu dump (large — prefer `search`) |
| `order --from <file \| ->` | `--from` | Order confirmation with payment URL |
| `byo --location <name> --size <regular\|maxi> ...` | see below | Build Your Own bowl builder |
| `byo-options --location <name>` | `--location` | All BYO ingredient options for a location |

## Workflow

1. **Find location**: `bun run index.ts locations` — pick one by name
2. **Check hours**: `bun run index.ts hours --location "Kloof"` — confirm `is_open: true`
3. **Search items**: `bun run index.ts search --location "Kloof" --query "salmon"` — find what to order
4. **Place order**: pipe JSON to `bun run index.ts order --from -`

### BYO Workflow

1. **Find location**: `bun run index.ts locations`
2. **Check hours**: `bun run index.ts hours --location "Kloof"`
3. **Get options**: `bun run index.ts byo-options --location "Kloof"` — shows all available bases, proteins, toppings, sauces, crunches, extras with prices for both regular and maxi
4. **Build bowl**: `bun run index.ts byo --location Kloof --size regular --base ... --protein ... --topping ... --sauce ... --crunch ...`

Always run `byo-options` first to see what ingredients are available before building a bowl.

## Order JSON Format

```json
{
  "location": "Kloof St",
  "mobile": "+27XXXXXXXXX",
  "order_type": "collection",
  "time": "asap",
  "items": [
    { "name": "Miso Soup", "quantity": 1 },
    {
      "name": "Build Your Own",
      "quantity": 1,
      "instructions": "Extra sauce",
      "choices": {
        "Choose Your Base": ["White Sushi Rice"],
        "Choose Your Protein": ["Salmon"]
      }
    }
  ]
}
```

### Build Your Own (BYO) Command

The `byo` command provides a typed CLI for building custom bowls without needing to know the raw deal group structure.

**Required flags:**
- `--location <name>` — location (partial match)
- `--size <regular|maxi>` — bowl size (R83 regular, R99 maxi)
- `--base <name>` — 1-2 bases (repeat flag for split base, or "none")
- `--protein <name>` — 1 protein (or "none")
- `--topping <name>` — 1-4 toppings (repeat flag)
- `--sauce <name>` — 1-2 sauces (repeat flag), or "none" for no sauce
- `--crunch <name>` — 1 crunch (or "none")

**Optional flags:**
- `--extra <name>` — paid extras, up to 2 (repeat flag)
- `--extra-protein <name>` — extra protein
- `--extra-sauce <name>` — extra sauce (paid, repeat flag)
- `--remove <name>` — remove defaults (e.g. "no sesame seeds", "sauce on the side")
- `--side <name>` — add a side
- `--drink <name>` — add a drink
- `--json` — output order-ready JSON item (for piping into `order`)

**Example:**
```bash
bun run index.ts byo --location Kloof --size regular \
  --base "sticky rice" --protein salmon \
  --topping mango --topping cucumber --topping edamame --topping radish \
  --sauce "house shoyu" --sauce "creamy togarashi" \
  --crunch "cashew nuts"
```

**Discover options:** Use `byo-options --location <name>` to see all available ingredients with prices.

### Deal Items (generic)

When `search` returns an item with `deal_groups`, you must provide `choices` in the order:
- Each key is a partial match on the group's `description`
- Each value is an array of partial matches on option names
- Check `required` and `min`/`max` to know which groups need selections

## Environment

- `POKE_TOKEN` — JWT auth token, required only for `order`

## Errors

All errors return `{ "error": "..." }` to stderr with exit code 1.

| Error | Fix |
|-------|-----|
| No location matching "X" | Check `locations` output for exact names |
| Not currently accepting orders | `is_open` is false — try another location or wait |
| No menu item matching "X" | Broaden search query or check `categories` first |
| Deal requires "choices" | Use `search` to see `deal_groups`, then provide `choices` |

## Tips

- **Prefer `search` over `menu`** — menu dumps 80+ items; search returns only matches
- **Partial matching everywhere** — "kloof" matches "Kloof St", "salmon" matches "Salmon Sashimi"
- **Mobile format** — use international format: `+27XXXXXXXXX`
- **Filter by category** — `search --location Kloof --query rice --category sides`
