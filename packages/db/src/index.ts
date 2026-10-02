export { createDb } from "./client";
export { orm, runChanges } from "./orm";
export { migrate } from "./migrate";
import * as schema from "./schema";
export * from "./schema";
// One combined schema object — passed to drizzle(), drizzleAdapter(), drizzle-kit.
export { schema };
