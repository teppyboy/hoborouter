// Shared SSR test fixture: radix modules (pulled in by billing and other
// pages) capture `document` availability when they first load. SSR tests
// import those pages before any document exists, which silently breaks Radix
// event wiring for every later jsdom file sharing the bun process. A faithful
// jsdom document is installed here — deliberately not a partial method stub,
// so any load-time DOM use beyond stylesheet injection also works — and the
// previous globalThis value is returned for restoration in afterAll.
import { JSDOM } from "jsdom";

export function installSsrDom(): () => void {
  const g = globalThis as { document?: unknown };
  if (g.document) {
    // Another fixture already provided a document; nothing to install or undo.
    return () => {};
  }
  const win = new JSDOM("", { url: "http://localhost:5173" }).window;
  const previous = Object.getOwnPropertyDescriptor(g, "document");
  g.document = win.document;
  return () => {
    if (previous) Object.defineProperty(g, "document", previous);
    else delete g.document;
  };
}
