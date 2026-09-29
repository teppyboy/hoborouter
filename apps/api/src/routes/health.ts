import { Elysia, t } from "elysia";

export const healthRoutes = new Elysia({ name: "health" }).get(
  "/healthz",
  { response: t.Object({ status: t.Literal("ok") }) },
  () => ({ status: "ok" as const }),
);
