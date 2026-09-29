export { createDb } from "./client";
export { migrate } from "./migrate";
import * as schema from "./schema";
export * from "./schema";
// One combined schema object — passed to drizzle(), drizzleAdapter(), drizzle-kit.
export { schema };
