#!/usr/bin/env bun

import { client } from "./src/client/client.gen";
import {
  getAllRestaurants,
  getDefaultMenuId,
  getMenuForLocation,
  getSnoozeData,
  createYocoOrder,
} from "./src/client/sdk.gen";
import type { MenuItem } from "./src/client/types.gen";

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function flagAll(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

const USAGE = `
Usage: bun run index.ts <command> [options]

Commands:
  locations                                        List all locations (JSON)
  hours      --location <name>                     Opening hours & status for a location
  categories --location <name>                     List menu categories with item counts
  search     --location <name> --query <text>      Search menu items (fuzzy match)
             [--category <name>]                   Optional: filter by category
  menu       --location <name>                     Dump full menu for a location (JSON)
  order      --from <file | ->                     Place an order from JSON file or stdin
  byo        --location <name> --size <regular|maxi>  Build Your Own bowl builder
             --base <name> [--base <name>]         1-2 bases (or "none")
             --protein <name>                      1 protein (or "none")
             --topping <n> [--topping <n> ...]     1-4 toppings
             --sauce <n> [--sauce <n>]             Sauce(s) — "none" for no sauce
             --crunch <name>                       1 crunch (or "none")
             [--extra <name> ...]                  Optional paid extras (up to 2)
             [--extra-protein <name>]              Optional extra protein
             [--extra-sauce <name> ...]            Optional extra sauces (paid)
             [--remove <name> ...]                 Remove default items
             [--side <name>]                       Add a side
             [--drink <name>]                      Add a drink
             [--json]                              Output order JSON instead of summary

Environment:
  POKE_TOKEN   JWT auth token (required for 'order')

Order JSON format:
  {
    "location": "Kloof St",           // partial match on location name
    "mobile": "+27718365958",
    "order_type": "collection",        // collection | delivery
    "time": "asap",                    // "asap" or ISO datetime
    "items": [
      {
        "name": "Miso Soup",           // partial match on product name
        "quantity": 1
      },
      {
        "name": "Build Your Own",      // deal item
        "quantity": 1,
        "instructions": "Extra sauce",
        "choices": {                   // group description -> [item names]
          "Choose Your Base": ["White Sushi Rice"],
          "Choose Your Protein": ["Salmon"]
        }
      }
    ]
  }

Build Your Own examples:
  bun run index.ts byo --location Kloof --size regular \\
    --base "sticky rice" --protein salmon \\
    --topping mango --topping cucumber --topping edamame --topping radish \\
    --sauce "house shoyu" --sauce "creamy togarashi" \\
    --crunch "cashew nuts"

  # No sauce:
  bun run index.ts byo --location Kloof --size regular \\
    --base "kale" --protein chicken \\
    --topping orange --topping carrot \\
    --sauce none --crunch "crispy onions"

  # Output order JSON for piping to 'order':
  bun run index.ts byo --location Kloof --size maxi \\
    --base "sticky rice" --base quinoa --protein tuna \\
    --topping mango --topping cucumber \\
    --sauce "hawaiian heat" --crunch macadamia --json
`;

// ── API helpers ──────────────────────────────────────────────────────────────

function initClient() {
  const token = process.env.POKE_TOKEN;
  client.setConfig({
    baseUrl: "https://hybrid-deliverect-lightspeed.5loyalty.com",
  });
  client.interceptors.request.use((req) => {
    req.headers.set("Origin", "https://thepokeco.5loyalty.com");
    req.headers.set("Referer", "https://thepokeco.5loyalty.com/");
    if (token) {
      req.headers.set("Authorization", `JWT ${token}`);
    }
    // Append version query param if not already present
    const url = new URL(req.url);
    if (!url.searchParams.has("version")) {
      url.searchParams.set("version", "1.14.2");
      return new Request(url.toString(), req);
    }
    return req;
  });
  return token;
}

function die(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

async function fetchRestaurants() {
  const { data } = await getAllRestaurants();
  const restaurants = (data as any)?.data as any[] | undefined;
  if (!restaurants?.length) die("No restaurants found");
  return restaurants;
}

async function fetchMenu(locationId: string) {
  const { data: menuIdData } = await getDefaultMenuId();
  const menuId = (menuIdData as any)?.data?.default_menu_id;
  if (!menuId) die("Could not load menu ID");

  const { data: menuData } = await getMenuForLocation({
    path: { menuId, locationId },
  });
  const menu = (menuData as any)?.data;
  if (!menu?.menuEntryGroups?.length) die("Menu is empty");

  const { data: snoozeRaw } = await getSnoozeData();
  const snoozeList = (snoozeRaw as any)?.data as any[] | undefined;
  const locationSnooze = snoozeList?.find((s: any) => s.business_location_id === locationId);
  const snoozedSkus = new Set([
    ...(locationSnooze?.data?.snoozed_skus || []),
    ...(locationSnooze?.data?.disabled_skus || []),
  ]);

  return { menu, menuId, snoozedSkus };
}

function findRestaurant(restaurants: any[], query: string) {
  const q = query.toLowerCase();
  const match = restaurants.find((r: any) => r.name?.toLowerCase().includes(q));
  if (!match) {
    die(
      `No location matching "${query}". Available: ${restaurants.map((r: any) => r.name).join(", ")}`,
    );
  }
  return match;
}

function findMenuItem(menuEntryGroups: any[], snoozedSkus: Set<string>, query: string): MenuItem {
  const q = query.toLowerCase();
  for (const group of menuEntryGroups) {
    for (const item of group.menuEntry || []) {
      if (snoozedSkus.has(item.sku)) continue;
      if (item.productName?.toLowerCase().includes(q)) return item;
    }
  }
  die(`No menu item matching "${query}"`);
}

function resolveDealChoices(
  item: MenuItem,
  choices: Record<string, string[]> | undefined,
): MenuItem {
  if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length) return item;
  if (!choices) die(`Item "${item.productName}" is a deal and requires "choices"`);

  const resolved = { ...item };
  resolved.menuDealGroups = item.menuDealGroups.map((group) => {
    const groupDesc = group.description || "";
    const groupKey = Object.keys(choices).find((k) =>
      groupDesc.toLowerCase().includes(k.toLowerCase()),
    );

    if (!groupKey) {
      const min = group.min ?? (group.mustSelectAnItem ? 1 : 0);
      if (min > 0) {
        die(
          `Deal "${item.productName}" requires choices for "${groupDesc}". Available groups: ${item.menuDealGroups!.map((g) => g.description).join(", ")}`,
        );
      }
      return { ...group, items: [] };
    }

    const wantedNames = choices[groupKey]!;
    const selected = wantedNames.map((name) => {
      const n = name.toLowerCase();
      const found = (group.items || []).find((gi) => gi.productName?.toLowerCase().includes(n));
      if (!found) {
        die(
          `No option matching "${name}" in group "${groupDesc}". Available: ${(group.items || []).map((gi) => gi.productName).join(", ")}`,
        );
      }
      return found;
    });

    return { ...group, items: selected };
  });

  return resolved;
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdLocations() {
  initClient();
  const restaurants = await fetchRestaurants();
  const output = restaurants.map((r: any) => ({
    name: r.name,
    business_location_id: r.business_location_id,
    address: r.address,
    town: r.town,
    is_accepting_orders: r.is_accepting_orders_currently,
    can_collection: r.can_collection_order,
    can_delivery: r.can_delivery_order || r.can_charter_delivery_order,
    kitchen_status: r.kitchen_status?.text,
  }));
  console.log(JSON.stringify(output, null, 2));
}

async function cmdMenu() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const output = (menu.menuEntryGroups as any[]).map((group: any) => ({
    category: group.name,
    items: (group.menuEntry || [])
      .filter((item: any) => !snoozedSkus.has(item.sku))
      .map((item: any) => ({
        name: item.productName,
        price: item.productPrice,
        type: item["@type"],
        sku: item.sku,
        ...(item["@type"] === "menuDeal" && item.menuDealGroups?.length
          ? {
              deal_groups: item.menuDealGroups.map((g: any) => ({
                description: g.description,
                min: g.min,
                max: g.max,
                required: g.mustSelectAnItem,
                options: (g.items || []).map((gi: any) => ({
                  name: gi.productName,
                  price: gi.productPrice,
                })),
              })),
            }
          : {}),
      })),
  }));
  console.log(JSON.stringify(output, null, 2));
}

async function cmdHours() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");

  const restaurants = await fetchRestaurants();
  const r = findRestaurant(restaurants, locationQuery);
  console.log(
    JSON.stringify(
      {
        name: r.name,
        is_open: r.is_accepting_orders_currently ?? false,
        kitchen_status: r.kitchen_status?.text ?? null,
        can_collection: r.can_collection_order ?? false,
        can_delivery: (r.can_delivery_order || r.can_charter_delivery_order) ?? false,
      },
      null,
      2,
    ),
  );
}

async function cmdCategories() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const output = (menu.menuEntryGroups as any[]).map((group: any) => ({
    category: group.name,
    item_count: (group.menuEntry || []).filter((item: any) => !snoozedSkus.has(item.sku)).length,
  }));
  console.log(JSON.stringify(output, null, 2));
}

async function cmdSearch() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");
  const query = flag("query");
  if (!query) die("--query <text> is required");
  const categoryFilter = flag("category");

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const q = query.toLowerCase();
  const catQ = categoryFilter?.toLowerCase();
  const matches: any[] = [];

  for (const group of menu.menuEntryGroups as any[]) {
    if (catQ && !group.name?.toLowerCase().includes(catQ)) continue;
    for (const item of group.menuEntry || []) {
      if (snoozedSkus.has(item.sku)) continue;
      if (!item.productName?.toLowerCase().includes(q)) continue;
      const entry: any = {
        name: item.productName,
        price: item.productPrice,
        type: item["@type"],
        category: group.name,
      };
      if (item["@type"] === "menuDeal" && item.menuDealGroups?.length) {
        entry.deal_groups = item.menuDealGroups.map((g: any) => ({
          description: g.description,
          min: g.min,
          max: g.max,
          required: g.mustSelectAnItem,
          options: (g.items || []).map((gi: any) => ({
            name: gi.productName,
            price: gi.productPrice,
          })),
        }));
      }
      matches.push(entry);
    }
  }

  console.log(JSON.stringify(matches, null, 2));
}

interface OrderSpec {
  location: string;
  mobile: string;
  order_type: "collection" | "delivery";
  time?: string;
  items: Array<{
    name: string;
    quantity?: number;
    instructions?: string;
    choices?: Record<string, string[]>;
  }>;
}

async function cmdOrder() {
  const token = initClient();
  if (!token) die("POKE_TOKEN environment variable is required to place orders");

  const fromPath = flag("from");
  if (!fromPath) die("--from <file.json | -> is required");

  let raw: string;
  if (fromPath === "-") {
    raw = await Bun.stdin.text();
  } else {
    const file = Bun.file(fromPath);
    if (!(await file.exists())) die(`File not found: ${fromPath}`);
    raw = await file.text();
  }

  let spec: OrderSpec;
  try {
    spec = JSON.parse(raw);
  } catch {
    die("Invalid JSON in order file");
  }

  if (!spec.location) die('Order JSON requires "location"');
  if (!spec.mobile) die('Order JSON requires "mobile"');
  if (!spec.items?.length) die('Order JSON requires "items" array');

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, spec.location);

  if (!restaurant.is_accepting_orders_currently) {
    die(`${restaurant.name} is not currently accepting orders`);
  }

  const { menu, menuId, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const cartItems = spec.items.map((specItem) => {
    const menuItem = findMenuItem(menu.menuEntryGroups, snoozedSkus, specItem.name);
    const resolved = resolveDealChoices(menuItem, specItem.choices);
    return {
      item: resolved,
      quantity: specItem.quantity ?? 1,
      special_instructions: specItem.instructions ?? "",
    };
  });

  const total = cartItems.reduce((sum, ci) => {
    let price = parseFloat(ci.item.productPrice || "0");
    if (ci.item.menuDealGroups) {
      for (const g of ci.item.menuDealGroups) {
        for (const sub of g.items || []) {
          price += parseFloat(sub.productPrice || "0");
        }
      }
    }
    return sum + price * ci.quantity;
  }, 0);

  const totalCents = Math.round(total * 100);
  const orderType = spec.order_type || "collection";
  const collectionTime = spec.time || "asap";

  const { data: orderResult, error } = await createYocoOrder({
    body: {
      items: cartItems,
      applicable_vouchers: [],
      applied_gift_cards: [],
      payment_token: "yoco",
      pay_on_collection: false,
      discount_applied: 0,
      business_location_id: restaurant.business_location_id,
      collection_time: collectionTime,
      mobile: spec.mobile,
      mobile_code: spec.mobile.slice(0, 3),
      mobile_value: spec.mobile.slice(3),
      currency: "zar",
      order_type: orderType,
      delivery_address: null,
      pick_up_point: null,
      is_gift: false,
      is_postal_gift: false,
      delivery_price: 0,
      _total: total,
      total: totalCents,
      allergen_data: [],
      service_charge_percentage: 0,
      service_charge_value: 0,
      is_asap: collectionTime === "asap",
      menu_id: menuId,
      already_paid: 0,
      uuid: `cli_${Date.now()}`,
      version: "1.14.2",
      client_id: null,
    },
  });

  if (error) {
    die(`Order failed: ${JSON.stringify(error)}`);
  }

  const result = orderResult as any;
  const order = result?.data?.order;
  const yoco = result?.data?.yoco;

  console.log(
    JSON.stringify(
      {
        order_id: order?.id,
        collection_code: order?.collection_code,
        status: order?.status,
        restaurant: restaurant.name,
        total: `R${total.toFixed(2)}`,
        payment_url: yoco?.redirectUrl,
        payment_amount_cents: yoco?.amount,
        payment_currency: yoco?.currency,
        items: cartItems.map((ci) => ({
          name: ci.item.productName,
          quantity: ci.quantity,
          ...(ci.special_instructions ? { instructions: ci.special_instructions } : {}),
        })),
      },
      null,
      2,
    ),
  );
}

async function cmdByoOptions() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const sizes = ["regular", "maxi"] as const;
  const output: Record<string, any> = {};

  for (const size of sizes) {
    const searchName = `Build Your Own - ${size === "regular" ? "Regular" : "Maxi"}`;
    const item = findMenuItem(menu.menuEntryGroups, snoozedSkus, searchName);
    if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length) continue;

    const groups: Record<string, any> = {};
    for (const g of item.menuDealGroups) {
      const desc = g.description || "";
      const step = byoGroupToStep(desc);
      if (!step) continue;
      groups[step] = {
        label: desc,
        min: g.min ?? 0,
        max: g.max ?? 0,
        required: g.mustSelectAnItem ?? false,
        options: (g.items || []).map((gi) => ({
          name: gi.productName,
          ...(parseFloat(gi.productPrice || "0") > 0 ? { price: `R${gi.productPrice}` } : {}),
        })),
      };
    }
    output[size] = { base_price: `R${item.productPrice}`, groups };
  }

  console.log(JSON.stringify(output, null, 2));
}

function byoGroupToStep(desc: string): string | null {
  const d = desc.toLowerCase();
  if (d.includes("choose your base") || d.includes("choose your base")) return "base";
  if (d.includes("pick a protein")) return "protein";
  if (d.includes("top it off")) return "topping";
  if (d.includes("dress it")) return "sauce";
  if (d.includes("add crunch")) return "crunch";
  if (d.includes("add extras") && !d.includes("protein")) return "extra";
  if (d.includes("extra protein")) return "extra_protein";
  if (d.includes("extra sauce")) return "extra_sauce";
  if (d.includes("removed")) return "remove";
  if (d.includes("add a side")) return "side";
  if (d.includes("add a drink")) return "drink";
  return null;
}

async function cmdByo() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery) die("--location <name> is required");
  const size = flag("size")?.toLowerCase();
  if (!size || (size !== "regular" && size !== "maxi")) die("--size <regular|maxi> is required");

  const bases = flagAll("base");
  const proteinRaw = flag("protein");
  const toppings = flagAll("topping");
  const sauces = flagAll("sauce");
  const crunchRaw = flag("crunch");
  const extras = flagAll("extra");
  const extraProtein = flag("extra-protein");
  const extraSauces = flagAll("extra-sauce");
  const removes = flagAll("remove");
  const side = flag("side");
  const drink = flag("drink");
  const jsonOutput = hasFlag("json");

  if (!bases.length) die("--base is required (1-2 bases, or 'none')");
  if (!proteinRaw) die("--protein is required (e.g. 'salmon', 'chicken', 'none')");
  if (!toppings.length) die("--topping is required (1-4 toppings)");
  if (!sauces.length && size === "regular")
    die("--sauce is required for regular (1-2 sauces, or 'none')");
  if (!crunchRaw) die("--crunch is required (e.g. 'cashew nuts', 'none')");

  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);

  const searchName = size === "regular" ? "Build Your Own - Regular" : "Build Your Own - Maxi";
  const item = findMenuItem(menu.menuEntryGroups, snoozedSkus, searchName);
  if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length)
    die(`${searchName} is not a deal item`);

  const choices: Record<string, string[]> = {};

  // Map each group by its step key
  for (const g of item.menuDealGroups) {
    const step = byoGroupToStep(g.description || "");
    if (!step) continue;

    const groupDesc = g.description || "";
    const min = g.min ?? 0;
    const max = g.max ?? 0;

    switch (step) {
      case "base": {
        if (bases.length === 1 && bases[0].toLowerCase() === "none") {
          choices[groupDesc] = ["None"];
        } else {
          if (bases.length < 1 || bases.length > 2) die("Choose 1-2 bases");
          choices[groupDesc] = bases;
        }
        break;
      }
      case "protein": {
        if (proteinRaw.toLowerCase() === "none") {
          choices[groupDesc] = ["No Protein"];
        } else {
          choices[groupDesc] = [proteinRaw];
        }
        break;
      }
      case "topping": {
        if (toppings.length < 1 || toppings.length > 4) die("Choose 1-4 toppings");
        choices[groupDesc] = toppings;
        break;
      }
      case "sauce": {
        // Handle the "select exactly 2" quirk for Regular
        if (sauces.length === 1 && sauces[0].toLowerCase() === "none") {
          // "none" → send "No Sauce" twice to fill the min:2 requirement
          if (min >= 2) {
            choices[groupDesc] = ["No Sauce", "No Sauce"];
          } else {
            choices[groupDesc] = ["No Sauce"];
          }
        } else if (sauces.length === 1 && min >= 2) {
          // Only 1 sauce provided but 2 required → fill second slot with "No Sauce"
          choices[groupDesc] = [sauces[0], "No Sauce"];
        } else {
          choices[groupDesc] = sauces;
        }
        break;
      }
      case "crunch": {
        if (crunchRaw.toLowerCase() === "none") {
          choices[groupDesc] = ["No Crunch"];
        } else {
          choices[groupDesc] = [crunchRaw];
        }
        break;
      }
      case "extra": {
        if (extras.length > 0) choices[groupDesc] = extras;
        break;
      }
      case "extra_protein": {
        if (extraProtein) choices[groupDesc] = [extraProtein];
        break;
      }
      case "extra_sauce": {
        if (extraSauces.length > 0) choices[groupDesc] = extraSauces;
        break;
      }
      case "remove": {
        if (removes.length > 0) choices[groupDesc] = removes;
        break;
      }
      case "side": {
        if (side) choices[groupDesc] = [side];
        break;
      }
      case "drink": {
        if (drink) choices[groupDesc] = [drink];
        break;
      }
    }
  }

  // Resolve and validate all choices against the actual menu data
  const resolved = resolveDealChoices(item, choices);

  // Calculate price
  let price = parseFloat(resolved.productPrice || "0");
  for (const g of resolved.menuDealGroups || []) {
    for (const sub of g.items || []) {
      price += parseFloat(sub.productPrice || "0");
    }
  }

  if (jsonOutput) {
    // Output order-ready JSON for piping to `order --from -`
    const orderChoices: Record<string, string[]> = {};
    for (const g of resolved.menuDealGroups || []) {
      if ((g.items || []).length > 0) {
        orderChoices[g.description || ""] = (g.items || []).map((gi) => gi.productName || "");
      }
    }
    console.log(
      JSON.stringify(
        {
          name: resolved.productName,
          quantity: 1,
          choices: orderChoices,
        },
        null,
        2,
      ),
    );
  } else {
    // Human-readable summary
    const summary: Record<string, any> = {
      bowl: resolved.productName,
      location: restaurant.name,
      base_price: `R${resolved.productPrice}`,
    };

    for (const g of resolved.menuDealGroups || []) {
      const step = byoGroupToStep(g.description || "");
      if (!step || (g.items || []).length === 0) continue;
      // Filter out "No Sauce"/"No Crunch"/"No Protein" padding from display
      const realItems = (g.items || []).filter(
        (gi) => !/^no (sauce|crunch|protein)$/i.test((gi.productName || "").trim()),
      );
      if (realItems.length === 0) {
        summary[step] = "None";
        continue;
      }
      const items = realItems.map((gi) => {
        const p = parseFloat(gi.productPrice || "0");
        return p > 0 ? `${gi.productName} (+R${gi.productPrice})` : gi.productName!;
      });
      summary[step] = items.length === 1 ? items[0] : items;
    }

    summary.total = `R${price.toFixed(2)}`;
    console.log(JSON.stringify(summary, null, 2));
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case "locations":
      return cmdLocations();
    case "hours":
      return cmdHours();
    case "categories":
      return cmdCategories();
    case "search":
      return cmdSearch();
    case "menu":
      return cmdMenu();
    case "order":
      return cmdOrder();
    case "byo":
      return cmdByo();
    case "byo-options":
      return cmdByoOptions();
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  die(err.message);
});
