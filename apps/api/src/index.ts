import { buildApp } from "./app";

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: (req) => app.handle(req),
});

console.log(`hoborouter api listening on :${port}`);
