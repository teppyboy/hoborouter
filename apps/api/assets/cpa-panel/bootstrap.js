(() => {
  "use strict";
  const adminOrigin = __HBR_ADMIN_ORIGIN__;
  const limit = 65536;
  const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  const error = (code = "HBR_PANEL_UNSUPPORTED", message = "Unsupported in the isolated panel") =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  const storage = () => {
    const values = new Map();
    return Object.freeze({
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => {
        key = String(key);
        value = String(value);
        const next = new Map(values);
        next.set(key, value);
        if (size([...next]) > limit) throw new DOMException("Storage limit", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key) => values.delete(String(key)),
      clear: () => values.clear(),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
  };
  Object.defineProperty(window, "localStorage", {
    value: storage(),
    writable: false,
    configurable: false,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: storage(),
    writable: false,
    configurable: false,
  });
  localStorage.setItem("apiBase", JSON.stringify("https://fakepanel.invalid"));
  localStorage.setItem("managementKey", JSON.stringify("hbr-panel-placeholder"));
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem(
    "cli-proxy-language",
    JSON.stringify({ state: { language: "en" }, version: 0 }),
  );
  Object.defineProperty(window, "XMLHttpRequest", {
    value: undefined,
    writable: false,
    configurable: false,
  });
  let channel = null;
  let sequence = 0;
  const pending = new Map();
  const providers = new Set([
    "qwen",
    "gemini",
    "kimi",
    "aistudio",
    "claude",
    "codex",
    "antigravity",
    "xai",
    "iflow",
    "vertex",
  ]);
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
  const keys = (value, required, optional = []) =>
    plain(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const text = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\x00-\x1f\x7f]/.test(value);
  const filename = (value) =>
    text(value) && !/[\\/%]/.test(value) && !value.includes("..") && value !== ".";
  const unique = (values) => new Set(values).size === values.length;
  const send = (id, item) =>
    parent.postMessage(
      { type: "hbr-cpa-panel:request", version: 1, channel, id, ...item.message },
      adminOrigin,
    );
  addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== adminOrigin) return;
    const value = event.data;
    if (
      keys(value, ["type", "version", "channel"]) &&
      value.type === "hbr-cpa-panel:init" &&
      value.version === 1 &&
      typeof value.channel === "string" &&
      /^[0-9a-f-]{36}$/i.test(value.channel) &&
      channel === null
    ) {
      channel = value.channel;
      for (const [id, item] of pending) send(id, item);
      return;
    }
    if (
      !keys(value, ["type", "version", "channel", "id", "status", "data"]) ||
      value.type !== "hbr-cpa-panel:response" ||
      value.version !== 1 ||
      value.channel !== channel ||
      !Number.isSafeInteger(value.id) ||
      !Number.isInteger(value.status) ||
      value.status < 200 ||
      value.status > 599
    )
      return;
    const item = pending.get(value.id);
    if (!item) return;
    try {
      if (size(value.data) > limit) return;
      const response = new Response(JSON.stringify(value.data), {
        status: value.status,
        headers: { "content-type": "application/json", "x-cpa-support-plugin": "false" },
      });
      pending.delete(value.id);
      clearTimeout(item.timer);
      item.resolve(response);
    } catch {
      /* Malformed parent responses cannot settle requests. */
    }
  });
  const mapRequest = async (request) => {
    // Inspect before URL normalization can erase encoded paths or dot segments.
    const raw = request.url;
    if (/%|\\/.test(raw)) throw Error();
    const url = new URL(raw);
    if (url.origin !== "https://fakepanel.invalid" || url.username || url.password || url.hash)
      throw Error();
    const path = url.pathname;
    const method = request.method;
    const reads = {
      "/v0/management/config": "readConfig",
      "/v0/management/auth-files": "listAuthFiles",
      "/v0/management/oauth-model-alias": "readModelAliases",
      "/v0/management/oauth-excluded-models": "readModelExclusions",
    };
    if (method === "GET" && !url.search && Object.hasOwn(reads, path))
      return { operation: reads[path] };
    if (method === "DELETE" && path === "/v0/management/oauth-excluded-models") {
      const entries = [...url.searchParams];
      if (entries.length !== 1 || entries[0][0] !== "provider" || !providers.has(entries[0][1]))
        throw Error();
      return { operation: "replaceModelExclusions", args: { provider: entries[0][1], models: [] } };
    }
    if (url.search) throw Error();
    const reader = request.body?.getReader();
    if (!reader) throw Error();
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (
      method === "PATCH" &&
      path === "/v0/management/auth-files/status" &&
      keys(body, ["name", "disabled"]) &&
      filename(body.name) &&
      typeof body.disabled === "boolean"
    )
      return { operation: "setAuthFileStatus", args: body };
    if (
      method === "DELETE" &&
      path === "/v0/management/auth-files" &&
      keys(body, ["names"]) &&
      Array.isArray(body.names) &&
      body.names.length > 0 &&
      body.names.length <= 50 &&
      body.names.every(filename) &&
      unique(body.names)
    )
      return { operation: "deleteAuthFiles", args: body };
    if (
      method === "PATCH" &&
      path === "/v0/management/oauth-model-alias" &&
      keys(body, ["channel", "aliases"]) &&
      providers.has(body.channel) &&
      Array.isArray(body.aliases) &&
      body.aliases.length <= 200 &&
      body.aliases.every(
        (alias) =>
          keys(alias, ["name", "alias"], ["fork", "force-mapping"]) &&
          text(alias.name) &&
          text(alias.alias) &&
          (alias.fork === undefined || typeof alias.fork === "boolean") &&
          (alias["force-mapping"] === undefined || typeof alias["force-mapping"] === "boolean"),
      ) &&
      unique(body.aliases.map((alias) => alias.alias))
    )
      return {
        operation: "replaceModelAliases",
        args: {
          channel: body.channel,
          aliases: body.aliases.map(({ "force-mapping": forceMapping, ...rest }) => ({
            ...rest,
            ...(forceMapping === undefined ? {} : { force_mapping: forceMapping }),
          })),
        },
      };
    if (
      method === "PATCH" &&
      path === "/v0/management/oauth-excluded-models" &&
      keys(body, ["provider", "models"]) &&
      providers.has(body.provider) &&
      Array.isArray(body.models) &&
      body.models.length <= 500 &&
      body.models.every(text) &&
      unique(body.models)
    )
      return { operation: "replaceModelExclusions", args: body };
    throw Error();
  };
  Object.defineProperty(window, "fetch", {
    writable: false,
    configurable: false,
    value: async (input, init) => {
      if (pending.size >= 32 || sequence >= Number.MAX_SAFE_INTEGER)
        return error("HBR_PANEL_BUSY", "Too many panel requests");
      try {
        // Raw strings must be checked before Request silently normalizes traversal.
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (/%|\\|\/\.\.?\//.test(raw)) return error();
        const request = new Request(input, init);
        const message = await mapRequest(request);
        if (size(message) > limit || pending.size >= 32) return error();
        if (request.signal.aborted) return error("HBR_PANEL_CANCELLED", "Panel request cancelled");
        return await new Promise((resolve) => {
          const id = ++sequence;
          const finish = () => {
            const item = pending.get(id);
            if (!item) return;
            pending.delete(id);
            clearTimeout(item.timer);
            resolve(error("HBR_PANEL_TIMEOUT", "Panel request expired; refresh state"));
          };
          const timer = setTimeout(finish, 30000);
          const item = { message, resolve, timer };
          pending.set(id, item);
          request.signal.addEventListener("abort", finish, { once: true });
          if (channel !== null) send(id, item);
        });
      } catch {
        return error();
      }
    },
  });
})();
