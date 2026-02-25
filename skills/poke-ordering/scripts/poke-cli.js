#!/usr/bin/env node

// index.ts
import { readFileSync, existsSync } from "node:fs";

// src/client/core/bodySerializer.gen.ts
var jsonBodySerializer = {
  bodySerializer: (body) => JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)
};
// src/client/core/params.gen.ts
var extraPrefixesMap = {
  $body_: "body",
  $headers_: "headers",
  $path_: "path",
  $query_: "query"
};
var extraPrefixes = Object.entries(extraPrefixesMap);
// src/client/core/serverSentEvents.gen.ts
var createSseClient = ({
  onRequest,
  onSseError,
  onSseEvent,
  responseTransformer,
  responseValidator,
  sseDefaultRetryDelay,
  sseMaxRetryAttempts,
  sseMaxRetryDelay,
  sseSleepFn,
  url,
  ...options
}) => {
  let lastEventId;
  const sleep = sseSleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createStream = async function* () {
    let retryDelay = sseDefaultRetryDelay ?? 3000;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted)
        break;
      attempt++;
      const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
      if (lastEventId !== undefined) {
        headers.set("Last-Event-ID", lastEventId);
      }
      try {
        const requestInit = {
          redirect: "follow",
          ...options,
          body: options.serializedBody,
          headers,
          signal
        };
        let request = new Request(url, requestInit);
        if (onRequest) {
          request = await onRequest(url, requestInit);
        }
        const _fetch = options.fetch ?? globalThis.fetch;
        const response = await _fetch(request);
        if (!response.ok)
          throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body)
          throw new Error("No body in SSE response");
        const reader = response.body.pipeThrough(new TextDecoderStream).getReader();
        let buffer = "";
        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {}
        };
        signal.addEventListener("abort", abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += value;
            buffer = buffer.replace(/\r\n/g, `
`).replace(/\r/g, `
`);
            const chunks = buffer.split(`

`);
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const lines = chunk.split(`
`);
              const dataLines = [];
              let eventName;
              for (const line of lines) {
                if (line.startsWith("data:")) {
                  dataLines.push(line.replace(/^data:\s*/, ""));
                } else if (line.startsWith("event:")) {
                  eventName = line.replace(/^event:\s*/, "");
                } else if (line.startsWith("id:")) {
                  lastEventId = line.replace(/^id:\s*/, "");
                } else if (line.startsWith("retry:")) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }
              }
              let data;
              let parsedJson = false;
              if (dataLines.length) {
                const rawData = dataLines.join(`
`);
                try {
                  data = JSON.parse(rawData);
                  parsedJson = true;
                } catch {
                  data = rawData;
                }
              }
              if (parsedJson) {
                if (responseValidator) {
                  await responseValidator(data);
                }
                if (responseTransformer) {
                  data = await responseTransformer(data);
                }
              }
              onSseEvent?.({
                data,
                event: eventName,
                id: lastEventId,
                retry: retryDelay
              });
              if (dataLines.length) {
                yield data;
              }
            }
          }
        } finally {
          signal.removeEventListener("abort", abortHandler);
          reader.releaseLock();
        }
        break;
      } catch (error) {
        onSseError?.(error);
        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          break;
        }
        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 30000);
        await sleep(backoff);
      }
    }
  };
  const stream = createStream();
  return { stream };
};

// src/client/core/pathSerializer.gen.ts
var separatorArrayExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var separatorArrayNoExplode = (style) => {
  switch (style) {
    case "form":
      return ",";
    case "pipeDelimited":
      return "|";
    case "spaceDelimited":
      return "%20";
    default:
      return ",";
  }
};
var separatorObjectExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var serializeArrayParam = ({
  allowReserved,
  explode,
  name,
  style,
  value
}) => {
  if (!explode) {
    const joinedValues2 = (allowReserved ? value : value.map((v) => encodeURIComponent(v))).join(separatorArrayNoExplode(style));
    switch (style) {
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      case "simple":
        return joinedValues2;
      default:
        return `${name}=${joinedValues2}`;
    }
  }
  const separator = separatorArrayExplode(style);
  const joinedValues = value.map((v) => {
    if (style === "label" || style === "simple") {
      return allowReserved ? v : encodeURIComponent(v);
    }
    return serializePrimitiveParam({
      allowReserved,
      name,
      value: v
    });
  }).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};
var serializePrimitiveParam = ({
  allowReserved,
  name,
  value
}) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error("Deeply-nested arrays/objects aren’t supported. Provide your own `querySerializer()` to handle these.");
  }
  return `${name}=${allowReserved ? value : encodeURIComponent(value)}`;
};
var serializeObjectParam = ({
  allowReserved,
  explode,
  name,
  style,
  value,
  valueOnly
}) => {
  if (value instanceof Date) {
    return valueOnly ? value.toISOString() : `${name}=${value.toISOString()}`;
  }
  if (style !== "deepObject" && !explode) {
    let values = [];
    Object.entries(value).forEach(([key, v]) => {
      values = [...values, key, allowReserved ? v : encodeURIComponent(v)];
    });
    const joinedValues2 = values.join(",");
    switch (style) {
      case "form":
        return `${name}=${joinedValues2}`;
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      default:
        return joinedValues2;
    }
  }
  const separator = separatorObjectExplode(style);
  const joinedValues = Object.entries(value).map(([key, v]) => serializePrimitiveParam({
    allowReserved,
    name: style === "deepObject" ? `${name}[${key}]` : key,
    value: v
  })).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};

// src/client/core/utils.gen.ts
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var defaultPathSerializer = ({ path, url: _url }) => {
  let url = _url;
  const matches = _url.match(PATH_PARAM_RE);
  if (matches) {
    for (const match of matches) {
      let explode = false;
      let name = match.substring(1, match.length - 1);
      let style = "simple";
      if (name.endsWith("*")) {
        explode = true;
        name = name.substring(0, name.length - 1);
      }
      if (name.startsWith(".")) {
        name = name.substring(1);
        style = "label";
      } else if (name.startsWith(";")) {
        name = name.substring(1);
        style = "matrix";
      }
      const value = path[name];
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        url = url.replace(match, serializeArrayParam({ explode, name, style, value }));
        continue;
      }
      if (typeof value === "object") {
        url = url.replace(match, serializeObjectParam({
          explode,
          name,
          style,
          value,
          valueOnly: true
        }));
        continue;
      }
      if (style === "matrix") {
        url = url.replace(match, `;${serializePrimitiveParam({
          name,
          value
        })}`);
        continue;
      }
      const replaceValue = encodeURIComponent(style === "label" ? `.${value}` : value);
      url = url.replace(match, replaceValue);
    }
  }
  return url;
};
var getUrl = ({
  baseUrl,
  path,
  query,
  querySerializer,
  url: _url
}) => {
  const pathUrl = _url.startsWith("/") ? _url : `/${_url}`;
  let url = (baseUrl ?? "") + pathUrl;
  if (path) {
    url = defaultPathSerializer({ path, url });
  }
  let search = query ? querySerializer(query) : "";
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    url += `?${search}`;
  }
  return url;
};
function getValidRequestBody(options) {
  const hasBody = options.body !== undefined;
  const isSerializedBody = hasBody && options.bodySerializer;
  if (isSerializedBody) {
    if ("serializedBody" in options) {
      const hasSerializedBody = options.serializedBody !== undefined && options.serializedBody !== "";
      return hasSerializedBody ? options.serializedBody : null;
    }
    return options.body !== "" ? options.body : null;
  }
  if (hasBody) {
    return options.body;
  }
  return;
}

// src/client/core/auth.gen.ts
var getAuthToken = async (auth, callback) => {
  const token = typeof callback === "function" ? await callback(auth) : callback;
  if (!token) {
    return;
  }
  if (auth.scheme === "bearer") {
    return `Bearer ${token}`;
  }
  if (auth.scheme === "basic") {
    return `Basic ${btoa(token)}`;
  }
  return token;
};

// src/client/client/utils.gen.ts
var createQuerySerializer = ({
  parameters = {},
  ...args
} = {}) => {
  const querySerializer = (queryParams) => {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === undefined || value === null) {
          continue;
        }
        const options = parameters[name] || args;
        if (Array.isArray(value)) {
          const serializedArray = serializeArrayParam({
            allowReserved: options.allowReserved,
            explode: true,
            name,
            style: "form",
            value,
            ...options.array
          });
          if (serializedArray)
            search.push(serializedArray);
        } else if (typeof value === "object") {
          const serializedObject = serializeObjectParam({
            allowReserved: options.allowReserved,
            explode: true,
            name,
            style: "deepObject",
            value,
            ...options.object
          });
          if (serializedObject)
            search.push(serializedObject);
        } else {
          const serializedPrimitive = serializePrimitiveParam({
            allowReserved: options.allowReserved,
            name,
            value
          });
          if (serializedPrimitive)
            search.push(serializedPrimitive);
        }
      }
    }
    return search.join("&");
  };
  return querySerializer;
};
var getParseAs = (contentType) => {
  if (!contentType) {
    return "stream";
  }
  const cleanContent = contentType.split(";")[0]?.trim();
  if (!cleanContent) {
    return;
  }
  if (cleanContent.startsWith("application/json") || cleanContent.endsWith("+json")) {
    return "json";
  }
  if (cleanContent === "multipart/form-data") {
    return "formData";
  }
  if (["application/", "audio/", "image/", "video/"].some((type) => cleanContent.startsWith(type))) {
    return "blob";
  }
  if (cleanContent.startsWith("text/")) {
    return "text";
  }
  return;
};
var checkForExistence = (options, name) => {
  if (!name) {
    return false;
  }
  if (options.headers.has(name) || options.query?.[name] || options.headers.get("Cookie")?.includes(`${name}=`)) {
    return true;
  }
  return false;
};
var setAuthParams = async ({
  security,
  ...options
}) => {
  for (const auth of security) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }
    const token = await getAuthToken(auth, options.auth);
    if (!token) {
      continue;
    }
    const name = auth.name ?? "Authorization";
    switch (auth.in) {
      case "query":
        if (!options.query) {
          options.query = {};
        }
        options.query[name] = token;
        break;
      case "cookie":
        options.headers.append("Cookie", `${name}=${token}`);
        break;
      case "header":
      default:
        options.headers.set(name, token);
        break;
    }
  }
};
var buildUrl = (options) => getUrl({
  baseUrl: options.baseUrl,
  path: options.path,
  query: options.query,
  querySerializer: typeof options.querySerializer === "function" ? options.querySerializer : createQuerySerializer(options.querySerializer),
  url: options.url
});
var mergeConfigs = (a, b) => {
  const config = { ...a, ...b };
  if (config.baseUrl?.endsWith("/")) {
    config.baseUrl = config.baseUrl.substring(0, config.baseUrl.length - 1);
  }
  config.headers = mergeHeaders(a.headers, b.headers);
  return config;
};
var headersEntries = (headers) => {
  const entries = [];
  headers.forEach((value, key) => {
    entries.push([key, value]);
  });
  return entries;
};
var mergeHeaders = (...headers) => {
  const mergedHeaders = new Headers;
  for (const header of headers) {
    if (!header) {
      continue;
    }
    const iterator = header instanceof Headers ? headersEntries(header) : Object.entries(header);
    for (const [key, value] of iterator) {
      if (value === null) {
        mergedHeaders.delete(key);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          mergedHeaders.append(key, v);
        }
      } else if (value !== undefined) {
        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : value);
      }
    }
  }
  return mergedHeaders;
};

class Interceptors {
  fns = [];
  clear() {
    this.fns = [];
  }
  eject(id) {
    const index = this.getInterceptorIndex(id);
    if (this.fns[index]) {
      this.fns[index] = null;
    }
  }
  exists(id) {
    const index = this.getInterceptorIndex(id);
    return Boolean(this.fns[index]);
  }
  getInterceptorIndex(id) {
    if (typeof id === "number") {
      return this.fns[id] ? id : -1;
    }
    return this.fns.indexOf(id);
  }
  update(id, fn) {
    const index = this.getInterceptorIndex(id);
    if (this.fns[index]) {
      this.fns[index] = fn;
      return id;
    }
    return false;
  }
  use(fn) {
    this.fns.push(fn);
    return this.fns.length - 1;
  }
}
var createInterceptors = () => ({
  error: new Interceptors,
  request: new Interceptors,
  response: new Interceptors
});
var defaultQuerySerializer = createQuerySerializer({
  allowReserved: false,
  array: {
    explode: true,
    style: "form"
  },
  object: {
    explode: true,
    style: "deepObject"
  }
});
var defaultHeaders = {
  "Content-Type": "application/json"
};
var createConfig = (override = {}) => ({
  ...jsonBodySerializer,
  headers: defaultHeaders,
  parseAs: "auto",
  querySerializer: defaultQuerySerializer,
  ...override
});

// src/client/client/client.gen.ts
var createClient = (config = {}) => {
  let _config = mergeConfigs(createConfig(), config);
  const getConfig = () => ({ ..._config });
  const setConfig = (config2) => {
    _config = mergeConfigs(_config, config2);
    return getConfig();
  };
  const interceptors = createInterceptors();
  const beforeRequest = async (options) => {
    const opts = {
      ..._config,
      ...options,
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: undefined
    };
    if (opts.security) {
      await setAuthParams({
        ...opts,
        security: opts.security
      });
    }
    if (opts.requestValidator) {
      await opts.requestValidator(opts);
    }
    if (opts.body !== undefined && opts.bodySerializer) {
      opts.serializedBody = opts.bodySerializer(opts.body);
    }
    if (opts.body === undefined || opts.serializedBody === "") {
      opts.headers.delete("Content-Type");
    }
    const url = buildUrl(opts);
    return { opts, url };
  };
  const request = async (options) => {
    const { opts, url } = await beforeRequest(options);
    const requestInit = {
      redirect: "follow",
      ...opts,
      body: getValidRequestBody(opts)
    };
    let request2 = new Request(url, requestInit);
    for (const fn of interceptors.request.fns) {
      if (fn) {
        request2 = await fn(request2, opts);
      }
    }
    const _fetch = opts.fetch;
    let response;
    try {
      response = await _fetch(request2);
    } catch (error2) {
      let finalError2 = error2;
      for (const fn of interceptors.error.fns) {
        if (fn) {
          finalError2 = await fn(error2, undefined, request2, opts);
        }
      }
      finalError2 = finalError2 || {};
      if (opts.throwOnError) {
        throw finalError2;
      }
      return opts.responseStyle === "data" ? undefined : {
        error: finalError2,
        request: request2,
        response: undefined
      };
    }
    for (const fn of interceptors.response.fns) {
      if (fn) {
        response = await fn(response, request2, opts);
      }
    }
    const result = {
      request: request2,
      response
    };
    if (response.ok) {
      const parseAs = (opts.parseAs === "auto" ? getParseAs(response.headers.get("Content-Type")) : opts.parseAs) ?? "json";
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        let emptyData;
        switch (parseAs) {
          case "arrayBuffer":
          case "blob":
          case "text":
            emptyData = await response[parseAs]();
            break;
          case "formData":
            emptyData = new FormData;
            break;
          case "stream":
            emptyData = response.body;
            break;
          case "json":
          default:
            emptyData = {};
            break;
        }
        return opts.responseStyle === "data" ? emptyData : {
          data: emptyData,
          ...result
        };
      }
      let data;
      switch (parseAs) {
        case "arrayBuffer":
        case "blob":
        case "formData":
        case "text":
          data = await response[parseAs]();
          break;
        case "json": {
          const text = await response.text();
          data = text ? JSON.parse(text) : {};
          break;
        }
        case "stream":
          return opts.responseStyle === "data" ? response.body : {
            data: response.body,
            ...result
          };
      }
      if (parseAs === "json") {
        if (opts.responseValidator) {
          await opts.responseValidator(data);
        }
        if (opts.responseTransformer) {
          data = await opts.responseTransformer(data);
        }
      }
      return opts.responseStyle === "data" ? data : {
        data,
        ...result
      };
    }
    const textError = await response.text();
    let jsonError;
    try {
      jsonError = JSON.parse(textError);
    } catch {}
    const error = jsonError ?? textError;
    let finalError = error;
    for (const fn of interceptors.error.fns) {
      if (fn) {
        finalError = await fn(error, response, request2, opts);
      }
    }
    finalError = finalError || {};
    if (opts.throwOnError) {
      throw finalError;
    }
    return opts.responseStyle === "data" ? undefined : {
      error: finalError,
      ...result
    };
  };
  const makeMethodFn = (method) => (options) => request({ ...options, method });
  const makeSseFn = (method) => async (options) => {
    const { opts, url } = await beforeRequest(options);
    return createSseClient({
      ...opts,
      body: opts.body,
      headers: opts.headers,
      method,
      onRequest: async (url2, init) => {
        let request2 = new Request(url2, init);
        for (const fn of interceptors.request.fns) {
          if (fn) {
            request2 = await fn(request2, opts);
          }
        }
        return request2;
      },
      serializedBody: getValidRequestBody(opts),
      url
    });
  };
  return {
    buildUrl,
    connect: makeMethodFn("CONNECT"),
    delete: makeMethodFn("DELETE"),
    get: makeMethodFn("GET"),
    getConfig,
    head: makeMethodFn("HEAD"),
    interceptors,
    options: makeMethodFn("OPTIONS"),
    patch: makeMethodFn("PATCH"),
    post: makeMethodFn("POST"),
    put: makeMethodFn("PUT"),
    request,
    setConfig,
    sse: {
      connect: makeSseFn("CONNECT"),
      delete: makeSseFn("DELETE"),
      get: makeSseFn("GET"),
      head: makeSseFn("HEAD"),
      options: makeSseFn("OPTIONS"),
      patch: makeSseFn("PATCH"),
      post: makeSseFn("POST"),
      put: makeSseFn("PUT"),
      trace: makeSseFn("TRACE")
    },
    trace: makeMethodFn("TRACE")
  };
};
// src/client/client.gen.ts
var client = createClient(createConfig({ baseUrl: "https://hybrid-deliverect-lightspeed.5loyalty.com" }));

// src/client/sdk.gen.ts
var getDefaultMenuId = (options) => (options?.client ?? client).get({ url: "/get_default_menu_id", ...options });
var getSnoozeData = (options) => (options?.client ?? client).get({ url: "/ikentoo_menu/get_snooze_data", ...options });
var getAllRestaurants = (options) => (options?.client ?? client).get({ url: "/restaurants/all", ...options });
var getMenuForLocation = (options) => (options.client ?? client).get({ url: "/ikentoo_menu/{menuId}/location/{locationId}", ...options });
var createYocoOrder = (options) => (options.client ?? client).post({
  security: [{ scheme: "bearer", type: "http" }],
  url: "/order/create_yoco_order",
  ...options,
  headers: {
    "Content-Type": "application/json",
    ...options.headers
  }
});

// index.ts
var args = process.argv.slice(2);
var command = args[0];
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length)
    return;
  return args[i + 1];
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}
function flagAll(name) {
  const results = [];
  for (let i = 0;i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}
var USAGE = `
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
function initClient() {
  const token = process.env.POKE_TOKEN;
  client.setConfig({
    baseUrl: "https://hybrid-deliverect-lightspeed.5loyalty.com"
  });
  client.interceptors.request.use((req) => {
    req.headers.set("Origin", "https://thepokeco.5loyalty.com");
    req.headers.set("Referer", "https://thepokeco.5loyalty.com/");
    if (token) {
      req.headers.set("Authorization", `JWT ${token}`);
    }
    const url = new URL(req.url);
    if (!url.searchParams.has("version")) {
      url.searchParams.set("version", "1.14.2");
      return new Request(url.toString(), req);
    }
    return req;
  });
  return token;
}
function die(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}
async function fetchRestaurants() {
  const { data } = await getAllRestaurants();
  const restaurants = data?.data;
  if (!restaurants?.length)
    die("No restaurants found");
  return restaurants;
}
async function fetchMenu(locationId) {
  const { data: menuIdData } = await getDefaultMenuId();
  const menuId = menuIdData?.data?.default_menu_id;
  if (!menuId)
    die("Could not load menu ID");
  const { data: menuData } = await getMenuForLocation({
    path: { menuId, locationId }
  });
  const menu = menuData?.data;
  if (!menu?.menuEntryGroups?.length)
    die("Menu is empty");
  const { data: snoozeRaw } = await getSnoozeData();
  const snoozeList = snoozeRaw?.data;
  const locationSnooze = snoozeList?.find((s) => s.business_location_id === locationId);
  const snoozedSkus = new Set([
    ...locationSnooze?.data?.snoozed_skus || [],
    ...locationSnooze?.data?.disabled_skus || []
  ]);
  return { menu, menuId, snoozedSkus };
}
function findRestaurant(restaurants, query) {
  const q = query.toLowerCase();
  const match = restaurants.find((r) => r.name?.toLowerCase().includes(q));
  if (!match) {
    die(`No location matching "${query}". Available: ${restaurants.map((r) => r.name).join(", ")}`);
  }
  return match;
}
function findMenuItem(menuEntryGroups, snoozedSkus, query) {
  const q = query.toLowerCase();
  for (const group of menuEntryGroups) {
    for (const item of group.menuEntry || []) {
      if (snoozedSkus.has(item.sku))
        continue;
      if (item.productName?.toLowerCase().includes(q))
        return item;
    }
  }
  die(`No menu item matching "${query}"`);
}
function resolveDealChoices(item, choices) {
  if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length)
    return item;
  if (!choices)
    die(`Item "${item.productName}" is a deal and requires "choices"`);
  const resolved = { ...item };
  resolved.menuDealGroups = item.menuDealGroups.map((group) => {
    const groupDesc = group.description || "";
    const groupKey = Object.keys(choices).find((k) => groupDesc.toLowerCase().includes(k.toLowerCase()));
    if (!groupKey) {
      const min = group.min ?? (group.mustSelectAnItem ? 1 : 0);
      if (min > 0) {
        die(`Deal "${item.productName}" requires choices for "${groupDesc}". Available groups: ${item.menuDealGroups.map((g) => g.description).join(", ")}`);
      }
      return { ...group, items: [] };
    }
    const wantedNames = choices[groupKey];
    const selected = wantedNames.map((name) => {
      const n = name.toLowerCase();
      const found = (group.items || []).find((gi) => gi.productName?.toLowerCase().includes(n));
      if (!found) {
        die(`No option matching "${name}" in group "${groupDesc}". Available: ${(group.items || []).map((gi) => gi.productName).join(", ")}`);
      }
      return found;
    });
    return { ...group, items: selected };
  });
  return resolved;
}
async function cmdLocations() {
  initClient();
  const restaurants = await fetchRestaurants();
  const output = restaurants.map((r) => ({
    name: r.name,
    business_location_id: r.business_location_id,
    address: r.address,
    town: r.town,
    is_accepting_orders: r.is_accepting_orders_currently,
    can_collection: r.can_collection_order,
    can_delivery: r.can_delivery_order || r.can_charter_delivery_order,
    kitchen_status: r.kitchen_status?.text
  }));
  console.log(JSON.stringify(output, null, 2));
}
async function cmdMenu() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);
  const output = menu.menuEntryGroups.map((group) => ({
    category: group.name,
    items: (group.menuEntry || []).filter((item) => !snoozedSkus.has(item.sku)).map((item) => ({
      name: item.productName,
      price: item.productPrice,
      type: item["@type"],
      sku: item.sku,
      ...item["@type"] === "menuDeal" && item.menuDealGroups?.length ? {
        deal_groups: item.menuDealGroups.map((g) => ({
          description: g.description,
          min: g.min,
          max: g.max,
          required: g.mustSelectAnItem,
          options: (g.items || []).map((gi) => ({
            name: gi.productName,
            price: gi.productPrice
          }))
        }))
      } : {}
    }))
  }));
  console.log(JSON.stringify(output, null, 2));
}
async function cmdHours() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const restaurants = await fetchRestaurants();
  const r = findRestaurant(restaurants, locationQuery);
  console.log(JSON.stringify({
    name: r.name,
    is_open: r.is_accepting_orders_currently ?? false,
    kitchen_status: r.kitchen_status?.text ?? null,
    can_collection: r.can_collection_order ?? false,
    can_delivery: (r.can_delivery_order || r.can_charter_delivery_order) ?? false
  }, null, 2));
}
async function cmdCategories() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);
  const output = menu.menuEntryGroups.map((group) => ({
    category: group.name,
    item_count: (group.menuEntry || []).filter((item) => !snoozedSkus.has(item.sku)).length
  }));
  console.log(JSON.stringify(output, null, 2));
}
async function cmdSearch() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const query = flag("query");
  if (!query)
    die("--query <text> is required");
  const categoryFilter = flag("category");
  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);
  const q = query.toLowerCase();
  const catQ = categoryFilter?.toLowerCase();
  const matches = [];
  for (const group of menu.menuEntryGroups) {
    if (catQ && !group.name?.toLowerCase().includes(catQ))
      continue;
    for (const item of group.menuEntry || []) {
      if (snoozedSkus.has(item.sku))
        continue;
      if (!item.productName?.toLowerCase().includes(q))
        continue;
      const entry = {
        name: item.productName,
        price: item.productPrice,
        type: item["@type"],
        category: group.name
      };
      if (item["@type"] === "menuDeal" && item.menuDealGroups?.length) {
        entry.deal_groups = item.menuDealGroups.map((g) => ({
          description: g.description,
          min: g.min,
          max: g.max,
          required: g.mustSelectAnItem,
          options: (g.items || []).map((gi) => ({
            name: gi.productName,
            price: gi.productPrice
          }))
        }));
      }
      matches.push(entry);
    }
  }
  console.log(JSON.stringify(matches, null, 2));
}
async function cmdOrder() {
  const token = initClient();
  if (!token)
    die("POKE_TOKEN environment variable is required to place orders");
  const fromPath = flag("from");
  if (!fromPath)
    die("--from <file.json | -> is required");
  let raw;
  if (fromPath === "-") {
    const chunks = [];
    for await (const chunk of process.stdin)
      chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf-8");
  } else {
    if (!existsSync(fromPath))
      die(`File not found: ${fromPath}`);
    raw = readFileSync(fromPath, "utf-8");
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    die("Invalid JSON in order file");
  }
  if (!spec.location)
    die('Order JSON requires "location"');
  if (!spec.mobile)
    die('Order JSON requires "mobile"');
  if (!spec.items?.length)
    die('Order JSON requires "items" array');
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
      special_instructions: specItem.instructions ?? ""
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
      client_id: null
    }
  });
  if (error) {
    die(`Order failed: ${JSON.stringify(error)}`);
  }
  const result = orderResult;
  const order = result?.data?.order;
  const yoco = result?.data?.yoco;
  console.log(JSON.stringify({
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
      ...ci.special_instructions ? { instructions: ci.special_instructions } : {}
    }))
  }, null, 2));
}
async function cmdByoOptions() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);
  const sizes = ["regular", "maxi"];
  const output = {};
  for (const size of sizes) {
    const searchName = `Build Your Own - ${size === "regular" ? "Regular" : "Maxi"}`;
    const item = findMenuItem(menu.menuEntryGroups, snoozedSkus, searchName);
    if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length)
      continue;
    const groups = {};
    for (const g of item.menuDealGroups) {
      const desc = g.description || "";
      const step = byoGroupToStep(desc);
      if (!step)
        continue;
      groups[step] = {
        label: desc,
        min: g.min ?? 0,
        max: g.max ?? 0,
        required: g.mustSelectAnItem ?? false,
        options: (g.items || []).map((gi) => ({
          name: gi.productName,
          ...parseFloat(gi.productPrice || "0") > 0 ? { price: `R${gi.productPrice}` } : {}
        }))
      };
    }
    output[size] = { base_price: `R${item.productPrice}`, groups };
  }
  console.log(JSON.stringify(output, null, 2));
}
function byoGroupToStep(desc) {
  const d = desc.toLowerCase();
  if (d.includes("choose your base") || d.includes("choose your base"))
    return "base";
  if (d.includes("pick a protein"))
    return "protein";
  if (d.includes("top it off"))
    return "topping";
  if (d.includes("dress it"))
    return "sauce";
  if (d.includes("add crunch"))
    return "crunch";
  if (d.includes("add extras") && !d.includes("protein"))
    return "extra";
  if (d.includes("extra protein"))
    return "extra_protein";
  if (d.includes("extra sauce"))
    return "extra_sauce";
  if (d.includes("removed"))
    return "remove";
  if (d.includes("add a side"))
    return "side";
  if (d.includes("add a drink"))
    return "drink";
  return null;
}
async function cmdByo() {
  initClient();
  const locationQuery = flag("location");
  if (!locationQuery)
    die("--location <name> is required");
  const size = flag("size")?.toLowerCase();
  if (!size || size !== "regular" && size !== "maxi")
    die("--size <regular|maxi> is required");
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
  if (!bases.length)
    die("--base is required (1-2 bases, or 'none')");
  if (!proteinRaw)
    die("--protein is required (e.g. 'salmon', 'chicken', 'none')");
  if (!toppings.length)
    die("--topping is required (1-4 toppings)");
  if (!sauces.length && size === "regular")
    die("--sauce is required for regular (1-2 sauces, or 'none')");
  if (!crunchRaw)
    die("--crunch is required (e.g. 'cashew nuts', 'none')");
  const restaurants = await fetchRestaurants();
  const restaurant = findRestaurant(restaurants, locationQuery);
  const { menu, snoozedSkus } = await fetchMenu(restaurant.business_location_id);
  const searchName = size === "regular" ? "Build Your Own - Regular" : "Build Your Own - Maxi";
  const item = findMenuItem(menu.menuEntryGroups, snoozedSkus, searchName);
  if (item["@type"] !== "menuDeal" || !item.menuDealGroups?.length)
    die(`${searchName} is not a deal item`);
  const choices = {};
  for (const g of item.menuDealGroups) {
    const step = byoGroupToStep(g.description || "");
    if (!step)
      continue;
    const groupDesc = g.description || "";
    const min = g.min ?? 0;
    const max = g.max ?? 0;
    switch (step) {
      case "base": {
        if (bases.length === 1 && bases[0].toLowerCase() === "none") {
          choices[groupDesc] = ["None"];
        } else {
          if (bases.length < 1 || bases.length > 2)
            die("Choose 1-2 bases");
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
        if (toppings.length < 1 || toppings.length > 4)
          die("Choose 1-4 toppings");
        choices[groupDesc] = toppings;
        break;
      }
      case "sauce": {
        if (sauces.length === 1 && sauces[0].toLowerCase() === "none") {
          if (min >= 2) {
            choices[groupDesc] = ["No Sauce", "No Sauce"];
          } else {
            choices[groupDesc] = ["No Sauce"];
          }
        } else if (sauces.length === 1 && min >= 2) {
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
        if (extras.length > 0)
          choices[groupDesc] = extras;
        break;
      }
      case "extra_protein": {
        if (extraProtein)
          choices[groupDesc] = [extraProtein];
        break;
      }
      case "extra_sauce": {
        if (extraSauces.length > 0)
          choices[groupDesc] = extraSauces;
        break;
      }
      case "remove": {
        if (removes.length > 0)
          choices[groupDesc] = removes;
        break;
      }
      case "side": {
        if (side)
          choices[groupDesc] = [side];
        break;
      }
      case "drink": {
        if (drink)
          choices[groupDesc] = [drink];
        break;
      }
    }
  }
  const resolved = resolveDealChoices(item, choices);
  let price = parseFloat(resolved.productPrice || "0");
  for (const g of resolved.menuDealGroups || []) {
    for (const sub of g.items || []) {
      price += parseFloat(sub.productPrice || "0");
    }
  }
  if (jsonOutput) {
    const orderChoices = {};
    for (const g of resolved.menuDealGroups || []) {
      if ((g.items || []).length > 0) {
        orderChoices[g.description || ""] = (g.items || []).map((gi) => gi.productName || "");
      }
    }
    console.log(JSON.stringify({
      name: resolved.productName,
      quantity: 1,
      choices: orderChoices
    }, null, 2));
  } else {
    const summary = {
      bowl: resolved.productName,
      location: restaurant.name,
      base_price: `R${resolved.productPrice}`
    };
    for (const g of resolved.menuDealGroups || []) {
      const step = byoGroupToStep(g.description || "");
      if (!step || (g.items || []).length === 0)
        continue;
      const realItems = (g.items || []).filter((gi) => !/^no (sauce|crunch|protein)$/i.test((gi.productName || "").trim()));
      if (realItems.length === 0) {
        summary[step] = "None";
        continue;
      }
      const items = realItems.map((gi) => {
        const p = parseFloat(gi.productPrice || "0");
        return p > 0 ? `${gi.productName} (+R${gi.productPrice})` : gi.productName;
      });
      summary[step] = items.length === 1 ? items[0] : items;
    }
    summary.total = `R${price.toFixed(2)}`;
    console.log(JSON.stringify(summary, null, 2));
  }
}
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
