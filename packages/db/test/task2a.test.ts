import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { createDb } from "../src/client";
import { migrate } from "../src/migrate";
import { MAX_SAFE_INTEGER_MONEY, billingReservations, modelPrices } from "../src/schema";

const dbs: Database[] = [];
function fixture(): Database {
  const db = createDb(":memory:");
  dbs.push(db);
  migrate(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** Positive-control base: identity + wallet + model + price + canonical request (model_id only, no legacy binding). */
function canonicalFixture(db: Database): void {
  db.exec(`
    INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0);
    INSERT INTO workspaces(id,name,created_at) VALUES ('w','w',0);
    INSERT INTO wallets(id,workspace_id,balance,reserved,created_at) VALUES ('wallet','w',1000000,0,0);
    INSERT INTO models(id,public_id,slug,display_name,provider,created_at,updated_at) VALUES ('m','m','m','m','p',0,0);
    INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('price','m',1,1,1,1,1000000,0);
    INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r','w','m','/v1/responses','non-stream','ok',0);
    INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br','wallet','r','m','price',26000,1000000,50,'held',0);
    INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,charged_vnd,created_at) VALUES ('ul','idem','r','w','p','m','up',1,0,0,0,'ok',40,0);
  `);
}

function run(db: Database, sql: string, ...params: (string | number | null)[]): void {
  db.prepare(sql).run(...params);
}

function expectThrow(db: Database, sql: string, ...params: (string | number | null)[]): void {
  expect(() => db.prepare(sql).run(...params)).toThrow();
}

test("settlements.usage_log_id is a real FK: dangling id rejected on insert, valid id accepted", () => {
  const db = fixture();
  canonicalFixture(db);
  // positive control
  expect(() =>
    run(
      db,
      "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id) VALUES ('s','br',1,0,1,0,40,'ul')",
    ),
  ).not.toThrow();
  expectThrow(
    db,
    "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id) VALUES ('badfk','br',1,0,1,0,2,'missing')",
  );
});

test("settlements cap guard enforced on UPDATE of charged_vnd and billing_reservation_id", () => {
  const db = fixture();
  canonicalFixture(db);
  run(
    db,
    "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd) VALUES ('s','br',1,0,1,0,40)",
  );
  // UPDATE above cap rejected
  expectThrow(db, "UPDATE settlements SET charged_vnd = 51 WHERE id = 's'");
  // re-pointing to a reservation whose cap is exceeded rejected
  run(
    db,
    "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r2','w','m','/v1/responses','non-stream','ok',0)",
  );
  run(
    db,
    "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br2','wallet','r2','m','price',26000,1000000,10,'held',0)",
  );
  expectThrow(db, "UPDATE settlements SET billing_reservation_id = 'br2' WHERE id = 's'");
  // update within cap accepted
  expect(() => run(db, "UPDATE settlements SET charged_vnd = 50 WHERE id = 's'")).not.toThrow();
});

test("model_prices MAX_SAFE accepted (read back via Drizzle), MAX+1 and 1.5 rejected", () => {
  const db = fixture();
  canonicalFixture(db);
  run(
    db,
    "INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('maxp','m',?,0,0,0,0,0)",
    MAX_SAFE_INTEGER_MONEY,
  );
  const d = drizzle(db);
  const row = d
    .select({ v: modelPrices.input_usd_micro_per_1m })
    .from(modelPrices)
    .where(eq(modelPrices.id, "maxp"))
    .all();
  expect(row[0]!.v).toBe(9007199254740991);
  expectThrow(
    db,
    "INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('over','m',?,0,0,0,0,0)",
    MAX_SAFE_INTEGER_MONEY + 1,
  );
  expectThrow(
    db,
    "INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('frac','m',1.5,0,0,0,0,0)",
  );
});

test("billing_reservations money bounds + status CHECK", () => {
  const db = fixture();
  canonicalFixture(db);
  for (const rid of ["r2", "r3", "r4", "r5"]) {
    run(
      db,
      "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES (?,'w','m','/v1/responses','non-stream','ok',0)",
      rid,
    );
  }
  // MAX accepted
  expect(() =>
    run(
      db,
      "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('brmax','wallet','r2','m','price',?,?,?,'held',0)",
      MAX_SAFE_INTEGER_MONEY,
      MAX_SAFE_INTEGER_MONEY,
      MAX_SAFE_INTEGER_MONEY,
    ),
  ).not.toThrow();
  // cap MAX+1 rejected
  expectThrow(
    db,
    "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br2','wallet','r3','m','price',26000,1000000,?,'held',0)",
    MAX_SAFE_INTEGER_MONEY + 1,
  );
  // fractional fx rejected
  expectThrow(
    db,
    "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br3','wallet','r4','m','price',1.5,1000000,50,'held',0)",
  );
  // invalid status rejected
  expectThrow(
    db,
    "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br4','wallet','r5','m','price',26000,1000000,50,'exploded',0)",
  );
});

test("usage_logs token subset + money bounds", () => {
  const db = fixture();
  canonicalFixture(db);
  for (const rid of ["r2", "r3", "r4", "r5", "r6"]) {
    run(
      db,
      "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES (?,'w','m','/v1/responses','non-stream','ok',0)",
      rid,
    );
  }
  // cached > input rejected
  expectThrow(
    db,
    "INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,created_at) VALUES ('ul2','i2','r2','w','p','m','up',1,0,2,0,'ok',0)",
  );
  // reasoning > output rejected
  expectThrow(
    db,
    "INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,created_at) VALUES ('ul3','i3','r3','w','p','m','up',1,2,0,3,'ok',0)",
  );
  // fractional token rejected
  expectThrow(
    db,
    "INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,created_at) VALUES ('ul4','i4','r4','w','p','m','up',1.5,0,0,0,'ok',0)",
  );
  // charged_vnd MAX accepted, MAX+1 rejected
  expect(() =>
    run(
      db,
      "INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,charged_vnd,created_at) VALUES ('ul5','i5','r5','w','p','m','up',1,0,0,0,'ok',?,0)",
      MAX_SAFE_INTEGER_MONEY,
    ),
  ).not.toThrow();
  expectThrow(
    db,
    "INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,charged_vnd,created_at) VALUES ('ul6','i6','r6','w','p','m','up',1,0,0,0,'ok',?,0)",
    MAX_SAFE_INTEGER_MONEY + 1,
  );
});

test("settlements charged_vnd MAX accepted at MAX cap, MAX+1 and fractional rejected", () => {
  const db = fixture();
  canonicalFixture(db);
  run(
    db,
    "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r9','w','m','/v1/responses','non-stream','ok',0)",
  );
  run(
    db,
    "INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('brmax','wallet','r9','m','price',26000,1000000,?,'held',0)",
    MAX_SAFE_INTEGER_MONEY,
  );
  expect(() =>
    run(
      db,
      "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd) VALUES ('smax','brmax',1,0,1,0,?)",
      MAX_SAFE_INTEGER_MONEY,
    ),
  ).not.toThrow();
  expectThrow(
    db,
    "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd) VALUES ('sover','brmax',1,0,1,0,?)",
    MAX_SAFE_INTEGER_MONEY + 1,
  );
  expectThrow(
    db,
    "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd) VALUES ('sfrac','brmax',1,0,1,0,1.5)",
  );
});

test("canonical request without legacy binding: full chain + ledger debit linked to billing reservation", () => {
  const db = fixture();
  canonicalFixture(db);
  // No model_bindings rows exist at all; canonical chain inserts succeed.
  const nBindings = (db.prepare("SELECT count(*) AS n FROM model_bindings").get() as { n: number })
    .n;
  expect(nBindings).toBe(0);
  expect(() =>
    run(
      db,
      "INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id) VALUES ('s','br',1,0,1,0,40,'ul')",
    ),
  ).not.toThrow();
  expect(() =>
    run(db, "UPDATE billing_reservations SET status='settled' WHERE id='br'"),
  ).not.toThrow();
  // Ledger debit linked to the canonical reservation.
  expect(() =>
    run(
      db,
      "INSERT INTO ledger_entries(id,wallet_id,direction,amount,kind,billing_reservation_id,balance_after,created_at) VALUES ('le','wallet','debit',40,'settle','br',999960,0)",
    ),
  ).not.toThrow();
  // Dangling billing_reservation_id on ledger rejected.
  expectThrow(
    db,
    "INSERT INTO ledger_entries(id,wallet_id,direction,amount,kind,billing_reservation_id,balance_after,created_at) VALUES ('le2','wallet','debit',40,'settle','ghost',999960,0)",
  );
  // Legacy request path (with binding) still works.
  run(
    db,
    "INSERT INTO model_bindings(id,public_model,cpa_alias,status,price_input_per_1m,price_output_per_1m,effective_at) VALUES ('legacy','old','old','published',0,0,0)",
  );
  expect(() =>
    run(
      db,
      "INSERT INTO requests(id,workspace_id,model_binding_id,endpoint,mode,status,created_at) VALUES ('rleg','w','legacy','/v1/chat/completions','stream','ok',0)",
    ),
  ).not.toThrow();
  // Request with neither binding nor model rejected.
  expectThrow(
    db,
    "INSERT INTO requests(id,workspace_id,endpoint,mode,status,created_at) VALUES ('rn','w','/v1/chat/completions','stream','ok',0)",
  );
});

test("drizzle typed insert of MAX_SAFE money reads back exactly", () => {
  const db = fixture();
  canonicalFixture(db);
  run(
    db,
    "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r9','w','m','/v1/responses','non-stream','ok',0)",
  );
  const d = drizzle(db);
  d.insert(billingReservations)
    .values({
      id: "br9",
      wallet_id: "wallet",
      request_id: "r9",
      model_id: "m",
      model_price_id: "price",
      usd_vnd_exchange_rate: MAX_SAFE_INTEGER_MONEY,
      markup_ppm: 1000000,
      cap_vnd: MAX_SAFE_INTEGER_MONEY,
      status: "held",
      created_at: 0,
    })
    .run();
  const row = d
    .select({ cap: billingReservations.cap_vnd })
    .from(billingReservations)
    .where(eq(billingReservations.id, "br9"))
    .all();
  expect(row[0]!.cap).toBe(9007199254740991);
});
