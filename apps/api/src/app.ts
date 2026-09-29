import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { healthRoutes } from "./routes/health";
import { staticSpa } from "./static-spa";

const defaultWebDist = new URL("../../web/dist", import.meta.url).pathname;

export const buildApp = () => {
  const webDist = process.env.HBR_WEB_DIST || defaultWebDist;

  return new Elysia({ name: "hoborouter-api" })
    .use(healthRoutes)
    .use(openapi({ path: "/docs", specPath: "/openapi.json" }))
    .get(
      "/api/*",
      () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    )
    .use(staticSpa(webDist));
};
