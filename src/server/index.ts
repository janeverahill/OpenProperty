import { Hono, type Context } from "hono";
import { z } from "zod";
import { initDB, query, get, run } from "./db";

type Env = { Bindings: { DB: D1Database } };

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  initDB(c.env);
  await ensureSeeded();
  await next();
});

// ── First-run data ─────────────────────────────────────────────────
// A deploy applies `schema.sql` as DDL only — a seed INSERT there fails the
// whole build — so the defaults and the sample portfolio are written here,
// once, when their tables are still empty. A re-deploy never resurrects a
// row the user deleted, because the table is no longer empty.

const DEFAULT_SETTINGS: Record<string, string> = {
  default_rent_due_day: "1",
  late_fee_amount: "50",
  late_fee_grace_days: "5",
  currency: "USD",
};

const DEMO_PROPERTIES: Array<[string, string, string, string, string, string, string]> = [
  ["Oakwood Estate", "single_family", "210 Oakwood Ln", "Austin", "TX", "78704", "emerald"],
  ["Honeybee Hideaway", "single_family", "88 Bramble Ct", "Austin", "TX", "78704", "amber"],
  ["308 Mission Apartments", "multi_family", "308 Mission St", "Austin", "TX", "78702", "sky"],
];

/** property index (into DEMO_PROPERTIES), name, beds, baths, sqft, rent, status */
const DEMO_UNITS: Array<[number, string, number, number, number, number, string]> = [
  [0, "Main house", 3, 2, 1450, 2300, "occupied"],
  [1, "Main house", 2, 1, 980, 1700, "occupied"],
  [2, "Unit 1", 1, 1, 620, 1450, "occupied"],
  [2, "Unit 2", 1, 1, 620, 1450, "vacant"],
  [2, "Unit 3", 2, 1, 850, 1850, "occupied"],
];

const DEMO_VENDORS: Array<[string, string, string, string]> = [
  ["Emerald Pool Service", "general", "512-555-0144", "emerald"],
  ["Hill Country Plumbing", "plumber", "512-555-0188", "sky"],
  ["Bright Spark Electric", "electrician", "512-555-0102", "amber"],
];

let seeded = false; // per-isolate fast path; the COUNT re-checks are cheap

async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    }

    const props = await get<{ n: number }>("SELECT COUNT(*) AS n FROM properties");
    if ((props?.n ?? 0) === 0) {
      const ids: number[] = [];
      for (const p of DEMO_PROPERTIES) {
        await run(
          "INSERT INTO properties (name, type, address, city, state, zip, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p,
        );
        const row = await get<{ id: number }>("SELECT id FROM properties ORDER BY id DESC LIMIT 1");
        ids.push(row?.id ?? 0);
      }
      const units = await get<{ n: number }>("SELECT COUNT(*) AS n FROM units");
      if ((units?.n ?? 0) === 0) {
        for (const [pi, name, beds, baths, sqft, rent, status] of DEMO_UNITS) {
          if (!ids[pi]) continue;
          await run(
            "INSERT INTO units (property_id, name, bedrooms, bathrooms, sqft, market_rent, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [ids[pi], name, beds, baths, sqft, rent, status],
          );
        }
      }
    }

    const vendors = await get<{ n: number }>("SELECT COUNT(*) AS n FROM vendors");
    if ((vendors?.n ?? 0) === 0) {
      for (const v of DEMO_VENDORS) {
        await run("INSERT INTO vendors (name, category, phone, color) VALUES (?, ?, ?, ?)", v);
      }
    }
  } catch {
    // A cold database mid-migration, or a table this build has not created
    // yet: the next request retries. Never fail a request over sample data.
    seeded = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const intParam = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, data: parsed.data };
}

function buildUpdate(fields: Record<string, unknown>): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  return { sets, params };
}

// ── Properties ─────────────────────────────────────────────────────

const PropertyInput = z.object({
  name: z.string().min(1),
  type: z.enum(["single_family", "multi_family", "condo", "townhouse", "commercial"]).optional(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  year_built: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
  color: z.string().optional(),
});

app.get("/api/properties", async (c) => {
  const rows = await query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) as unit_count,
       (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status = 'occupied') as occupied_count
     FROM properties p ORDER BY p.name`,
  );
  return c.json({ properties: rows });
});

app.get("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ property: row });
});

app.post("/api/properties", async (c) => {
  const parsed = await parseJson(c, PropertyInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO properties (name, type, address, city, state, zip, year_built, notes, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.name, d.type ?? "single_family", d.address ?? null, d.city ?? null, d.state ?? null, d.zip ?? null, d.year_built ?? null, d.notes ?? null, d.color ?? "sky"],
  );
  const row = await get("SELECT * FROM properties WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ property: row }, 201);
});

app.put("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PropertyInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE properties SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM properties WHERE id = ?", [id]);
  return c.json({ property: row });
});

app.delete("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM properties WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Units ──────────────────────────────────────────────────────────

const UnitInput = z.object({
  property_id: z.number().int(),
  name: z.string().min(1),
  bedrooms: z.number().min(0).optional(),
  bathrooms: z.number().min(0).optional(),
  sqft: z.number().int().optional().nullable(),
  market_rent: z.number().min(0).optional(),
  status: z.enum(["vacant", "occupied", "turnover", "unavailable"]).optional(),
  notes: z.string().optional().nullable(),
});

const UNIT_SELECT = `
  SELECT u.*,
    p.name as property_name,
    p.color as property_color,
    p.address as property_address,
    p.city as property_city,
    (SELECT l.id FROM leases l WHERE l.unit_id = u.id AND l.status = 'active' ORDER BY l.start_date DESC LIMIT 1) as active_lease_id,
    (SELECT t.first_name || ' ' || t.last_name FROM leases l LEFT JOIN tenants t ON t.id = l.primary_tenant_id WHERE l.unit_id = u.id AND l.status = 'active' ORDER BY l.start_date DESC LIMIT 1) as active_tenant_name
  FROM units u
  LEFT JOIN properties p ON p.id = u.property_id
`;

app.get("/api/units", async (c) => {
  const propertyId = intParam(c.req.query("property_id"));
  const status = c.req.query("status");
  const where: string[] = [];
  const params: unknown[] = [];
  if (propertyId) { where.push("u.property_id = ?"); params.push(propertyId); }
  if (status) { where.push("u.status = ?"); params.push(status); }
  const sql = `${UNIT_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY p.name, u.name`;
  const rows = await query(sql, params);
  return c.json({ units: rows });
});

app.get("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ unit: row });
});

app.post("/api/units", async (c) => {
  const parsed = await parseJson(c, UnitInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO units (property_id, name, bedrooms, bathrooms, sqft, market_rent, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.property_id, d.name, d.bedrooms ?? 1, d.bathrooms ?? 1, d.sqft ?? null, d.market_rent ?? 0, d.status ?? "vacant", d.notes ?? null],
  );
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [result.lastInsertRowid]);
  return c.json({ unit: row }, 201);
});

app.put("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, UnitInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE units SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [id]);
  return c.json({ unit: row });
});

app.delete("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM units WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Tenants ────────────────────────────────────────────────────────

const TenantInput = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  emergency_contact: z.string().optional().nullable(),
  employer: z.string().optional().nullable(),
  monthly_income: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

app.get("/api/tenants", async (c) => {
  const search = c.req.query("q")?.trim();
  if (search) {
    const like = `%${search}%`;
    const rows = await query(
      `SELECT t.*,
         (SELECT u.id FROM leases l LEFT JOIN units u ON u.id = l.unit_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_id,
         (SELECT u.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_name,
         (SELECT p.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_property_name
       FROM tenants t
       WHERE t.last_name LIKE ? OR t.first_name LIKE ? OR t.email LIKE ? OR t.phone LIKE ?
       ORDER BY t.last_name, t.first_name LIMIT 200`,
      [like, like, like, like],
    );
    return c.json({ tenants: rows });
  }
  const rows = await query(
    `SELECT t.*,
       (SELECT u.id FROM leases l LEFT JOIN units u ON u.id = l.unit_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_id,
       (SELECT u.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_name,
       (SELECT p.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_property_name
     FROM tenants t ORDER BY t.last_name, t.first_name LIMIT 500`,
  );
  return c.json({ tenants: rows });
});

app.get("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get("SELECT * FROM tenants WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ tenant: row });
});

app.post("/api/tenants", async (c) => {
  const parsed = await parseJson(c, TenantInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO tenants (first_name, last_name, email, phone, date_of_birth, emergency_contact, employer, monthly_income, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.first_name, d.last_name, d.email ?? null, d.phone ?? null, d.date_of_birth ?? null, d.emergency_contact ?? null, d.employer ?? null, d.monthly_income ?? null, d.notes ?? null],
  );
  const row = await get("SELECT * FROM tenants WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ tenant: row }, 201);
});

app.put("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, TenantInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM tenants WHERE id = ?", [id]);
  return c.json({ tenant: row });
});

app.delete("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM tenants WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Leases ─────────────────────────────────────────────────────────

const LeaseInput = z.object({
  unit_id: z.number().int(),
  primary_tenant_id: z.number().int().nullable().optional(),
  start_date: z.string(),
  end_date: z.string(),
  monthly_rent: z.number().min(0).optional(),
  deposit: z.number().min(0).optional(),
  rent_due_day: z.number().int().min(1).max(31).optional(),
  late_fee: z.number().min(0).optional(),
  status: z.enum(["upcoming", "active", "ended", "cancelled"]).optional(),
  notes: z.string().optional().nullable(),
});

const LEASE_SELECT = `
  SELECT l.*,
    u.name as unit_name,
    p.id as property_id, p.name as property_name, p.color as property_color,
    t.first_name as tenant_first_name, t.last_name as tenant_last_name,
    t.email as tenant_email, t.phone as tenant_phone
  FROM leases l
  LEFT JOIN units u ON u.id = l.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
  LEFT JOIN tenants t ON t.id = l.primary_tenant_id
`;

app.get("/api/leases", async (c) => {
  const status = c.req.query("status");
  const tenantId = intParam(c.req.query("tenant_id"));
  const unitId = intParam(c.req.query("unit_id"));
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { where.push("l.status = ?"); params.push(status); }
  if (tenantId) { where.push("l.primary_tenant_id = ?"); params.push(tenantId); }
  if (unitId) { where.push("l.unit_id = ?"); params.push(unitId); }
  const sql = `${LEASE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY l.start_date DESC`;
  const rows = await query(sql, params);
  return c.json({ leases: rows });
});

app.get("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ lease: row });
});

app.post("/api/leases", async (c) => {
  const parsed = await parseJson(c, LeaseInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO leases (unit_id, primary_tenant_id, start_date, end_date, monthly_rent, deposit, rent_due_day, late_fee, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.unit_id, d.primary_tenant_id ?? null, d.start_date, d.end_date, d.monthly_rent ?? 0, d.deposit ?? 0, d.rent_due_day ?? 1, d.late_fee ?? 0, d.status ?? "active", d.notes ?? null],
  );
  // Mark the unit as occupied if the new lease is active.
  if ((d.status ?? "active") === "active") {
    await run("UPDATE units SET status = 'occupied' WHERE id = ?", [d.unit_id]);
  }
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [result.lastInsertRowid]);
  return c.json({ lease: row }, 201);
});

app.put("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, LeaseInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE leases SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [id]);
  return c.json({ lease: row });
});

app.delete("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM leases WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Rent charges & payments ────────────────────────────────────────

const ChargeInput = z.object({
  lease_id: z.number().int(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  due_date: z.string(),
  amount: z.number().min(0).optional(),
  notes: z.string().optional().nullable(),
});

const CHARGE_SELECT = `
  SELECT c.*,
    l.unit_id, l.monthly_rent as lease_rent, l.rent_due_day,
    u.name as unit_name,
    p.id as property_id, p.name as property_name, p.color as property_color,
    t.id as tenant_id, t.first_name as tenant_first_name, t.last_name as tenant_last_name
  FROM rent_charges c
  LEFT JOIN leases l ON l.id = c.lease_id
  LEFT JOIN units u ON u.id = l.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
  LEFT JOIN tenants t ON t.id = l.primary_tenant_id
`;

app.get("/api/rent-charges", async (c) => {
  const period = c.req.query("period");
  const status = c.req.query("status");
  const where: string[] = [];
  const params: unknown[] = [];
  if (period) { where.push("c.period = ?"); params.push(period); }
  if (status) { where.push("c.status = ?"); params.push(status); }
  const sql = `${CHARGE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY c.due_date, p.name, u.name`;
  const rows = await query(sql, params).catch(() => []);
  return c.json({ charges: rows });
});

app.post("/api/rent-charges", async (c) => {
  const parsed = await parseJson(c, ChargeInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO rent_charges (lease_id, period, due_date, amount, notes) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lease_id, period) DO NOTHING`,
    [d.lease_id, d.period, d.due_date, d.amount ?? 0, d.notes ?? null],
  );
  if (!result.changes) {
    const existing = await get(`${CHARGE_SELECT} WHERE c.lease_id = ? AND c.period = ?`, [d.lease_id, d.period]);
    return c.json({ charge: existing });
  }
  const row = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [result.lastInsertRowid]);
  return c.json({ charge: row }, 201);
});

// Generate (idempotent) charges for a given period across all active leases.
app.post("/api/rent-charges/generate", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { period?: string };
  const period = body.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return c.json({ error: "period (YYYY-MM) required" }, 400);
  const leases = await query<{ id: number; monthly_rent: number; rent_due_day: number; start_date: string; end_date: string }>(
    "SELECT id, monthly_rent, rent_due_day, start_date, end_date FROM leases WHERE status = 'active'",
  );
  let created = 0;
  for (const l of leases) {
    // Skip if the lease doesn't cover this period at all.
    const periodStart = `${period}-01`;
    if (l.end_date < periodStart) continue;
    const day = String(Math.min(28, Math.max(1, l.rent_due_day))).padStart(2, "0");
    const dueDate = `${period}-${day}`;
    const r = await run(
      `INSERT INTO rent_charges (lease_id, period, due_date, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT(lease_id, period) DO NOTHING`,
      [l.id, period, dueDate, l.monthly_rent],
    );
    if (r.changes) created++;
  }
  // Re-mark anything past due as 'overdue'.
  await run(
    `UPDATE rent_charges SET status = 'overdue'
     WHERE status IN ('open', 'partial') AND amount_paid < amount AND due_date < date('now')`,
  );
  return c.json({ created, period });
});

app.put("/api/rent-charges/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const Patch = z.object({
    amount: z.number().min(0).optional(),
    due_date: z.string().optional(),
    status: z.enum(["open", "partial", "paid", "overdue", "waived"]).optional(),
    notes: z.string().optional().nullable(),
  });
  const parsed = await parseJson(c, Patch);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE rent_charges SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [id]);
  return c.json({ charge: row });
});

app.delete("/api/rent-charges/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM rent_charges WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

const PaymentInput = z.object({
  charge_id: z.number().int(),
  paid_at: z.string().optional(),
  amount: z.number().min(0),
  method: z.enum(["cash", "check", "ach", "credit", "other"]).optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

app.get("/api/rent-charges/:id/payments", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query("SELECT * FROM payments WHERE charge_id = ? ORDER BY paid_at DESC", [id]);
  return c.json({ payments: rows });
});

app.post("/api/payments", async (c) => {
  const parsed = await parseJson(c, PaymentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  await run(
    `INSERT INTO payments (charge_id, paid_at, amount, method, reference, notes)
     VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`,
    [d.charge_id, d.paid_at ?? null, d.amount, d.method ?? "cash", d.reference ?? null, d.notes ?? null],
  );
  // Recompute the charge's amount_paid + status.
  const charge = await get<{ amount: number }>("SELECT amount FROM rent_charges WHERE id = ?", [d.charge_id]);
  if (!charge) return c.json({ error: "Charge not found" }, 404);
  const sumRow = await get<{ total: number }>("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE charge_id = ?", [d.charge_id]);
  const paid = Number(sumRow?.total ?? 0);
  const status = paid >= charge.amount ? "paid" : paid > 0 ? "partial" : "open";
  await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [paid, status, d.charge_id]);
  const updated = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [d.charge_id]);
  return c.json({ charge: updated }, 201);
});

app.delete("/api/payments/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get<{ charge_id: number }>("SELECT charge_id FROM payments WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  await run("DELETE FROM payments WHERE id = ?", [id]);
  // Recompute the charge.
  const sumRow = await get<{ total: number }>("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE charge_id = ?", [row.charge_id]);
  const charge = await get<{ amount: number }>("SELECT amount FROM rent_charges WHERE id = ?", [row.charge_id]);
  const paid = Number(sumRow?.total ?? 0);
  const status = !charge ? "open" : paid >= charge.amount ? "paid" : paid > 0 ? "partial" : "open";
  await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [paid, status, row.charge_id]);
  return c.json({ ok: true });
});

// ── Payment reconciliation ─────────────────────────────────────────

const ReconcilePaymentInput = z.object({
  inbox_item_id: z.number().int().optional().nullable(),
  charge_id: z.number().int(),
  received_amount: z.number().positive(),
  received_at: z.string(),
  reference: z.string().min(1),
  allow_partial: z.boolean().optional(),
  force_review: z.boolean().optional(),
  review_reason: z.string().optional().nullable(),
});

app.post("/api/payment-reconciliations/evaluate", async (c) => {
  const parsed = await parseJson(c, ReconcilePaymentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;

  const duplicate = await get("SELECT * FROM payment_reconciliations WHERE reference = ?", [d.reference]);
  if (duplicate) return c.json({ reconciliation: duplicate, duplicate: true });

  const charge = await get<any>(
    `SELECT c.*, l.unit_id, l.primary_tenant_id, u.property_id, u.name as unit_name,
       t.first_name || ' ' || t.last_name as tenant_name
     FROM rent_charges c
     JOIN leases l ON l.id = c.lease_id
     JOIN units u ON u.id = l.unit_id
     LEFT JOIN tenants t ON t.id = l.primary_tenant_id
     WHERE c.id = ?`,
    [d.charge_id],
  );
  if (!charge) return c.json({ error: "Charge not found" }, 404);

  const expectedRemaining = Math.max(0, Number(charge.amount) - Number(charge.amount_paid));
  const received = Number(d.received_amount);
  const difference = received - expectedRemaining;
  const paidDate = d.received_at.slice(0, 10);
  const late = paidDate > String(charge.due_date).slice(0, 10);

  const classified = classifyPaymentCase({
    expected: expectedRemaining,
    received,
    late,
    force_review: d.force_review,
    allow_partial: d.allow_partial,
  });
  const matchType = classified.match_type;
  const status = classified.status;
  const confidence = matchType === "split" ? 0.98 : 1;
  const reason = matchType === "special_rule"
    ? (d.review_reason || "This account is configured for manual review.")
    : matchType === "late"
      ? `Payment was received after the due date (${charge.due_date}).`
      : matchType === "short"
        ? `Payment is ${Math.abs(difference).toFixed(2)} short of the remaining charge.`
        : matchType === "over"
          ? `Payment is ${difference.toFixed(2)} above the remaining charge.`
          : matchType === "split"
            ? "Partial payment accepted; the remaining balance stays open for a later payment."
            : "";

  const rr = await run(
    `INSERT INTO payment_reconciliations
      (inbox_item_id, charge_id, unit_id, received_amount, expected_amount, received_at, reference, match_type, difference, confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.inbox_item_id ?? null, d.charge_id, charge.unit_id, received, expectedRemaining, d.received_at,
     d.reference, matchType, difference, confidence, status],
  );
  const reconciliationId = rr.lastInsertRowid;

  if (status === "auto_matched") {
    const payment = await run(
      `INSERT INTO payments (charge_id, paid_at, amount, method, reference, notes)
       VALUES (?, ?, ?, 'ach', ?, 'Auto-matched by payment reconciliation')`,
      [d.charge_id, d.received_at, received, d.reference],
    );
    await run("UPDATE payment_reconciliations SET payment_id = ?, decision = 'auto_matched', reviewed_at = datetime('now') WHERE id = ?",
      [payment.lastInsertRowid, reconciliationId]);
    const sum = await get<{ total: number }>("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE charge_id = ?", [d.charge_id]);
    const totalPaid = Number(sum?.total ?? 0);
    const chargeStatus = totalPaid >= Number(charge.amount) ? "paid" : totalPaid > 0 ? "partial" : "open";
    await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [totalPaid, chargeStatus, d.charge_id]);
    await run(
      `INSERT INTO activity_events
        (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source)
       VALUES (?, ?, ?, 'payment', 'payment_reconciliation', ?, ?, ?, 'system')`,
      [charge.property_id, charge.unit_id, charge.primary_tenant_id, reconciliationId,
       `Payment automatically reconciled: ${received.toFixed(2)}`,
       matchType === "split"
         ? `Reference ${d.reference}; partial payment applied with ${Math.abs(difference).toFixed(2)} remaining.`
         : `Reference ${d.reference}; exact match to remaining charge.`],
    );
    if (d.inbox_item_id) await run("UPDATE inbox_items SET status = 'handled', handled_at = datetime('now') WHERE id = ?", [d.inbox_item_id]);
  } else {
    const title = `Payment needs review — ${charge.unit_name || "unit"}`;
    const proposed = matchType === "late" ? "Confirm the payment and review whether late-payment follow-up is required."
      : matchType === "short" ? "Review the short payment before applying it."
      : matchType === "over" ? "Review the overpayment and choose how the excess should be handled."
      : "Review this payment manually before applying it.";
    await run(
      `INSERT INTO review_items
        (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, confidence, risk_level)
       VALUES (?, ?, ?, ?, 'payment', ?, ?, ?, ?, 'normal')`,
      [d.inbox_item_id ?? null, charge.property_id, charge.unit_id, charge.primary_tenant_id,
       title, reason, proposed, confidence],
    );
    if (d.inbox_item_id) await run("UPDATE inbox_items SET status = 'needs_review' WHERE id = ?", [d.inbox_item_id]);
  }

  const row = await get("SELECT * FROM payment_reconciliations WHERE id = ?", [reconciliationId]);
  return c.json({ reconciliation: row, auto_matched: status === "auto_matched" }, 201);
});

app.get("/api/payment-reconciliations", async (c) => {
  const status = c.req.query("status");
  const params: unknown[] = [];
  const where = status ? " WHERE pr.status = ?" : "";
  if (status) params.push(status);
  const rows = await query(
    `SELECT pr.*, u.name as unit_name, p.name as property_name
     FROM payment_reconciliations pr
     LEFT JOIN units u ON u.id = pr.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     ${where} ORDER BY pr.created_at DESC LIMIT 250`, params,
  ).catch(() => []);
  return c.json({ payment_reconciliations: rows });
});

// ── Documents and deadlines ───────────────────────────────────────

const DocumentInput = z.object({
  property_id: z.number().int().optional().nullable(),
  unit_id: z.number().int().optional().nullable(),
  tenant_id: z.number().int().optional().nullable(),
  category: z.string().min(1).default("other"),
  title: z.string().min(1),
  storage_ref: z.string().optional().nullable(),
  source_inbox_item_id: z.number().int().optional().nullable(),
  document_date: z.string().optional().nullable(),
  deadline_at: z.string().optional().nullable(),
  ai_summary: z.string().optional().nullable(),
});

app.get("/api/documents", async (c) => {
  const rows = await query(
    `SELECT d.*, p.name property_name, u.name unit_name,
       t.first_name || ' ' || t.last_name tenant_name
     FROM documents d
     LEFT JOIN properties p ON p.id = d.property_id
     LEFT JOIN units u ON u.id = d.unit_id
     LEFT JOIN tenants t ON t.id = d.tenant_id
     ORDER BY COALESCE(d.deadline_at, d.document_date, d.created_at) DESC, d.id DESC
     LIMIT 500`,
  ).catch(() => []);
  return c.json({ documents: rows });
});

app.post("/api/documents", async (c) => {
  const parsed = await parseJson(c, DocumentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO documents
      (property_id, unit_id, tenant_id, category, title, storage_ref, source_inbox_item_id, document_date, deadline_at, ai_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null, d.category, d.title,
     d.storage_ref ?? null, d.source_inbox_item_id ?? null, d.document_date ?? null,
     d.deadline_at ?? null, d.ai_summary ?? null],
  );
  const documentId = result.lastInsertRowid;
  await run(
    `INSERT INTO activity_events
      (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source)
     VALUES (?, ?, ?, 'document', 'document', ?, ?, ?, 'manager')`,
    [d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null, documentId,
     "Document filed: " + d.title, d.ai_summary ?? null],
  );
  if (d.source_inbox_item_id) {
    await run("UPDATE inbox_items SET item_type = 'document', status = 'handled', handled_at = datetime('now') WHERE id = ?", [d.source_inbox_item_id]);
  }
  if (d.deadline_at) {
    await run(
      `INSERT INTO review_items
        (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, confidence, risk_level)
       VALUES (?, ?, ?, ?, 'deadline', ?, ?, ?, 1, 'high')`,
      [d.source_inbox_item_id ?? null, d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null,
       "Deadline — " + d.title, "This document contains a tracked deadline: " + d.deadline_at,
       "Review the document and confirm the required follow-up before the deadline."],
    );
  }
  const row = await get("SELECT * FROM documents WHERE id = ?", [documentId]);
  return c.json({ document: row }, 201);
});

// ── Operations self-check ─────────────────────────────────────────
// Pure decision-table tests for the automation rules. This endpoint never
// writes portfolio data; it is safe to run repeatedly while hardening flows.

function classifyPaymentCase(input: {
  expected: number;
  received: number;
  late?: boolean;
  force_review?: boolean;
  allow_partial?: boolean;
}) {
  const difference = input.received - input.expected;
  if (input.force_review) return { match_type: "special_rule", status: "needs_review" };
  if (input.late) return { match_type: "late", status: "needs_review" };
  if (difference < 0 && input.allow_partial) return { match_type: "split", status: "auto_matched" };
  if (difference < 0) return { match_type: "short", status: "needs_review" };
  if (difference > 0) return { match_type: "over", status: "needs_review" };
  return { match_type: "exact", status: "auto_matched" };
}

app.get("/api/operations/self-check", (c) => {
  const cases = [
    { name: "exact on-time", input: { expected: 645, received: 645 }, want: ["exact", "auto_matched"] },
    { name: "short unexplained", input: { expected: 919, received: 905 }, want: ["short", "needs_review"] },
    { name: "overpayment", input: { expected: 645, received: 650 }, want: ["over", "needs_review"] },
    { name: "exact but late", input: { expected: 942, received: 942, late: true }, want: ["late", "needs_review"] },
    { name: "intentional split", input: { expected: 1144, received: 600, allow_partial: true }, want: ["split", "auto_matched"] },\n    { name: "late split stays visible", input: { expected: 1144, received: 600, allow_partial: true, late: true }, want: ["late", "needs_review"] },
    { name: "special account", input: { expected: 1144, received: 1144, force_review: true }, want: ["special_rule", "needs_review"] },
  ].map(test => {
    const got = classifyPaymentCase(test.input);
    return {
      name: test.name,
      passed: got.match_type === test.want[0] && got.status === test.want[1],
      expected: { match_type: test.want[0], status: test.want[1] },
      actual: got,
    };
  });
  return c.json({
    passed: cases.every(test => test.passed),
    passed_count: cases.filter(test => test.passed).length,
    total: cases.length,
    cases,
  });
});

// ── Vendors ────────────────────────────────────────────────────────

const VendorInput = z.object({
  name: z.string().min(1),
  category: z.enum(["plumber", "electrician", "hvac", "handyman", "cleaning", "landscaping", "general"]).optional(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  color: z.string().optional(),
});

app.get("/api/vendors", async (c) => {
  const rows = await query("SELECT * FROM vendors ORDER BY name");
  return c.json({ vendors: rows });
});

app.post("/api/vendors", async (c) => {
  const parsed = await parseJson(c, VendorInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO vendors (name, category, phone, email, notes, color) VALUES (?, ?, ?, ?, ?, ?)",
    [d.name, d.category ?? "general", d.phone ?? null, d.email ?? null, d.notes ?? null, d.color ?? "slate"],
  );
  const row = await get("SELECT * FROM vendors WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ vendor: row }, 201);
});

app.put("/api/vendors/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, VendorInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE vendors SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM vendors WHERE id = ?", [id]);
  return c.json({ vendor: row });
});

app.delete("/api/vendors/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM vendors WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Work orders ────────────────────────────────────────────────────

const WorkOrderInput = z.object({
  property_id: z.number().int().nullable().optional(),
  unit_id: z.number().int().nullable().optional(),
  tenant_id: z.number().int().nullable().optional(),
  vendor_id: z.number().int().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  status: z.enum(["open", "assigned", "in_progress", "completed", "cancelled"]).optional(),
  scheduled_at: z.string().optional().nullable(),
  completed_at: z.string().optional().nullable(),
  cost: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
});

const WO_SELECT = `
  SELECT w.*,
    p.name as property_name, p.color as property_color,
    u.name as unit_name,
    t.first_name as tenant_first_name, t.last_name as tenant_last_name,
    v.name as vendor_name, v.color as vendor_color
  FROM work_orders w
  LEFT JOIN properties p ON p.id = w.property_id
  LEFT JOIN units u ON u.id = w.unit_id
  LEFT JOIN tenants t ON t.id = w.tenant_id
  LEFT JOIN vendors v ON v.id = w.vendor_id
`;

app.get("/api/work-orders", async (c) => {
  const status = c.req.query("status");
  const propertyId = intParam(c.req.query("property_id"));
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { where.push("w.status = ?"); params.push(status); }
  if (propertyId) { where.push("w.property_id = ?"); params.push(propertyId); }
  const sql = `${WO_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY
    CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    w.created_at DESC`;
  const rows = await query(sql, params).catch(() => []);
  return c.json({ work_orders: rows });
});

app.post("/api/work-orders", async (c) => {
  const parsed = await parseJson(c, WorkOrderInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO work_orders (property_id, unit_id, tenant_id, vendor_id, title, description, priority, status, scheduled_at, completed_at, cost, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null, d.vendor_id ?? null,
      d.title, d.description ?? null,
      d.priority ?? "normal", d.status ?? "open",
      d.scheduled_at ?? null, d.completed_at ?? null,
      d.cost ?? null, d.notes ?? null,
    ],
  );
  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [result.lastInsertRowid]);
  return c.json({ work_order: row }, 201);
});

app.put("/api/work-orders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, WorkOrderInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE work_orders SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [id]);
  return c.json({ work_order: row });
});

app.delete("/api/work-orders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM work_orders WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Applications ───────────────────────────────────────────────────

const ApplicationInput = z.object({
  unit_id: z.number().int().nullable().optional(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  monthly_income: z.number().optional().nullable(),
  employer: z.string().optional().nullable(),
  desired_move_in: z.string().optional().nullable(),
  status: z.enum(["new", "screening", "approved", "declined", "withdrawn"]).optional(),
  notes: z.string().optional().nullable(),
});

app.get("/api/applications", async (c) => {
  const rows = await query(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a
     LEFT JOIN units u ON u.id = a.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY a.created_at DESC`,
  ).catch(() => []);
  return c.json({ applications: rows });
});

app.post("/api/applications", async (c) => {
  const parsed = await parseJson(c, ApplicationInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO applications (unit_id, first_name, last_name, email, phone, monthly_income, employer, desired_move_in, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.unit_id ?? null, d.first_name, d.last_name,
      d.email ?? null, d.phone ?? null, d.monthly_income ?? null, d.employer ?? null,
      d.desired_move_in ?? null, d.status ?? "new", d.notes ?? null,
    ],
  );
  const row = await get(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE a.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ application: row }, 201);
});

app.put("/api/applications/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ApplicationInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE applications SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE a.id = ?`,
    [id],
  );
  return c.json({ application: row });
});

app.delete("/api/applications/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM applications WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── AI operations layer ────────────────────────────────────────────

const InboxInput = z.object({
  source_type: z.enum(["email", "photo", "document", "manual", "integration"]),
  source_ref: z.string().optional().nullable(),
  property_id: z.number().int().optional().nullable(),
  unit_id: z.number().int().optional().nullable(),
  tenant_id: z.number().int().optional().nullable(),
  item_type: z.enum(["payment", "maintenance", "document", "message", "unknown"]).optional(),
  subject: z.string().optional().nullable(),
  raw_text: z.string().optional().nullable(),
  extracted_json: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
  status: z.enum(["new", "classified", "needs_review", "handled", "dismissed"]).optional(),
  received_at: z.string().optional(),
});

app.get("/api/inbox", async (c) => {
  const status = c.req.query("status");
  const params: unknown[] = [];
  let where = "";
  if (status) { where = " WHERE i.status = ?"; params.push(status); }
  const rows = await query(
    `SELECT i.*, p.name as property_name, u.name as unit_name,
       t.first_name || ' ' || t.last_name as tenant_name
     FROM inbox_items i
     LEFT JOIN properties p ON p.id = i.property_id
     LEFT JOIN units u ON u.id = i.unit_id
     LEFT JOIN tenants t ON t.id = i.tenant_id
     ${where} ORDER BY i.received_at DESC, i.id DESC LIMIT 250`,
    params,
  ).catch(() => []);
  return c.json({ inbox_items: rows });
});

app.post("/api/inbox", async (c) => {
  const parsed = await parseJson(c, InboxInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO inbox_items
      (source_type, source_ref, property_id, unit_id, tenant_id, item_type, subject, raw_text, extracted_json, confidence, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    [d.source_type, d.source_ref ?? null, d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null,
     d.item_type ?? "unknown", d.subject ?? null, d.raw_text ?? null, d.extracted_json ?? null,
     d.confidence ?? null, d.status ?? "new", d.received_at ?? null],
  );
  const row = await get("SELECT * FROM inbox_items WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ inbox_item: row }, 201);
});

function classifyInboxText(item: { source_type?: string; subject?: string | null; raw_text?: string | null }) {
  const text = ((item.subject ?? "") + " " + (item.raw_text ?? "")).toLowerCase();
  const maintenanceTerms = ["leak", "leaking", "toilet", "sink", "faucet", "tap", "plumbing", "heat", "heating", "furnace",
    "air conditioner", "a/c", "electrical", "outlet", "light", "broken", "repair", "maintenance", "dryer", "washer",
    "appliance", "door", "window", "smoke detector", "alarm"];
  const documentTerms = ["notice", "letter", "invoice", "inspection", "agreement", "lease", "form", "statement", "certificate",
    "insurance", "contract", "quote", "estimate", "deadline", "due date", "renewal"];
  const maintenanceHits = maintenanceTerms.filter(term => text.includes(term)).length;
  const documentHits = documentTerms.filter(term => text.includes(term)).length;
  if (maintenanceHits > documentHits && maintenanceHits > 0) {
    return { item_type: "maintenance", confidence: Math.min(0.98, 0.82 + maintenanceHits * 0.05), reason: "Maintenance language detected." };
  }
  if (documentHits > maintenanceHits && documentHits > 0) {
    return { item_type: "document", confidence: Math.min(0.98, 0.82 + documentHits * 0.05), reason: "Document language detected." };
  }
  if (item.source_type === "document") return { item_type: "document", confidence: 0.86, reason: "Document source type detected." };
  return { item_type: "unknown", confidence: 0.5, reason: "Not enough evidence to classify automatically." };
}

app.post("/api/inbox/:id/classify", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const item = await get<any>("SELECT * FROM inbox_items WHERE id = ?", [id]);
  if (!item) return c.json({ error: "Inbox item not found" }, 404);
  if (item.status === "handled" || item.status === "dismissed") return c.json({ error: "Inbox item has already been resolved" }, 409);
  const classification = classifyInboxText(item);
  const status = classification.item_type === "unknown" ? "needs_review" : "classified";
  await run("UPDATE inbox_items SET item_type = ?, confidence = ?, status = ? WHERE id = ?",
    [classification.item_type, classification.confidence, status, id]);
  if (classification.item_type === "unknown") {
    const prior = await get<any>("SELECT id FROM review_items WHERE inbox_item_id = ? AND review_type = 'other' AND status = 'open' LIMIT 1", [id]);
    if (!prior) await run(
      `INSERT INTO review_items
       (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, confidence, risk_level)
       VALUES (?, ?, ?, ?, 'other', 'Inbox item needs classification', ?, 'Choose the correct workflow before processing.', ?, 'normal')`,
      [id, item.property_id, item.unit_id, item.tenant_id, classification.reason, classification.confidence],
    );
  }
  return c.json({ classification: { ...classification, status } });
});

const ProcessInboxMaintenanceInput = z.object({
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  force_review: z.boolean().optional(),
});

app.post("/api/inbox/:id/process-maintenance", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ProcessInboxMaintenanceInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const item = await get<any>("SELECT * FROM inbox_items WHERE id = ?", [id]);
  if (!item) return c.json({ error: "Inbox item not found" }, 404);
  if (item.status === "handled" || item.status === "dismissed") {
    return c.json({ error: "Inbox item has already been resolved" }, 409);
  }

  const title = item.subject || "Maintenance request";
  const priority = parsed.data.priority ?? "normal";
  const missingAssignment = !item.property_id || !item.unit_id;
  const highRisk = priority === "urgent";
  const shouldReview = parsed.data.force_review || missingAssignment || highRisk || (item.confidence != null && Number(item.confidence) < 0.9);

  await run("UPDATE inbox_items SET item_type = 'maintenance', status = ? WHERE id = ?",
    [shouldReview ? "needs_review" : "classified", id]);

  if (shouldReview) {
    const reasons = [
      missingAssignment ? "Property or unit could not be confirmed." : null,
      highRisk ? "Urgent maintenance requires manager review before routing." : null,
      item.confidence != null && Number(item.confidence) < 0.9 ? "AI confidence is below the automatic-processing threshold." : null,
      parsed.data.force_review ? "Manual review was requested." : null,
    ].filter(Boolean).join(" ");
    const existingReview = await get<any>(
      "SELECT id FROM review_items WHERE inbox_item_id = ? AND review_type = 'maintenance' AND status = 'open' LIMIT 1",
      [id],
    );
    if (!existingReview) {
      await run(
        `INSERT INTO review_items
          (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, confidence, risk_level)
         VALUES (?, ?, ?, ?, 'maintenance', ?, ?, ?, ?, ?)`,
        [id, item.property_id, item.unit_id, item.tenant_id,
         `Maintenance needs review — ${item.unit_id ? "assigned unit" : "unassigned"}`,
         reasons || "Review this maintenance request before creating a work order.",
         "Confirm the unit, urgency and work-order details.", item.confidence ?? null, highRisk ? "high" : "normal"],
      );
    }
    return c.json({ needs_review: true, reason: reasons }, 202);
  }

  const wo = await run(
    `INSERT INTO work_orders
      (property_id, unit_id, tenant_id, title, description, priority, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [item.property_id, item.unit_id, item.tenant_id, title, item.raw_text ?? null, priority,
     `Created from AI Inbox item #${id} (${item.source_type})`],
  );
  await run("UPDATE inbox_items SET status = 'handled', handled_at = datetime('now') WHERE id = ?", [id]);
  await run(
    `INSERT INTO activity_events
      (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source)
     VALUES (?, ?, ?, 'maintenance', 'work_order', ?, ?, ?, 'ai')`,
    [item.property_id, item.unit_id, item.tenant_id, wo.lastInsertRowid,
     `Maintenance request converted to work order: ${title}`,
     `AI Inbox item #${id}; priority ${priority}; source ${item.source_type}.`],
  );
  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [wo.lastInsertRowid]);
  return c.json({ needs_review: false, work_order: row }, 201);
});

const ProcessInboxDocumentInput = z.object({
  category: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  document_date: z.string().optional().nullable(),
  deadline_at: z.string().optional().nullable(),
  ai_summary: z.string().optional().nullable(),
  storage_ref: z.string().optional().nullable(),
  force_review: z.boolean().optional(),
});

app.post("/api/inbox/:id/process-document", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ProcessInboxDocumentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const item = await get<any>("SELECT * FROM inbox_items WHERE id = ?", [id]);
  if (!item) return c.json({ error: "Inbox item not found" }, 404);
  if (item.status === "handled" || item.status === "dismissed") return c.json({ error: "Inbox item has already been resolved" }, 409);

  const d = parsed.data;
  const title = d.title || item.subject || "Incoming document";
  const category = d.category || "other";
  const lowConfidence = item.confidence != null && Number(item.confidence) < 0.9;
  const missingAssignment = !item.property_id && !item.unit_id && !item.tenant_id;
  const shouldReview = Boolean(d.force_review || lowConfidence || missingAssignment);

  await run("UPDATE inbox_items SET item_type = 'document', status = ? WHERE id = ?",
    [shouldReview ? "needs_review" : "classified", id]);

  if (shouldReview) {
    const reasons = [
      missingAssignment ? "Property, unit or tenant could not be confirmed." : null,
      lowConfidence ? "AI confidence is below the automatic-processing threshold." : null,
      d.force_review ? "Manual review was requested." : null,
    ].filter(Boolean).join(" ");
    const existingReview = await get<any>(
      "SELECT id FROM review_items WHERE inbox_item_id = ? AND review_type = 'document' AND status = 'open' LIMIT 1", [id]);
    if (!existingReview) {
      await run(
        `INSERT INTO review_items
          (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, proposed_json, confidence, risk_level)
         VALUES (?, ?, ?, ?, 'document', ?, ?, ?, ?, ?, 'normal')`,
        [id, item.property_id, item.unit_id, item.tenant_id, "Document needs review — " + title,
         reasons || "Review this document before filing it.",
         "Confirm the document details, assignment and any deadline before filing.",
         JSON.stringify({ category, title, document_date: d.document_date ?? null, deadline_at: d.deadline_at ?? null,
           ai_summary: d.ai_summary ?? item.raw_text ?? null, storage_ref: d.storage_ref ?? item.source_ref ?? null }),
         item.confidence ?? null],
      );
    }
    return c.json({ needs_review: true, reason: reasons }, 202);
  }

  const doc = await run(
    `INSERT INTO documents
      (property_id, unit_id, tenant_id, category, title, storage_ref, source_inbox_item_id, document_date, deadline_at, ai_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.property_id, item.unit_id, item.tenant_id, category, title, d.storage_ref ?? item.source_ref ?? null,
     id, d.document_date ?? null, d.deadline_at ?? null, d.ai_summary ?? item.raw_text ?? null],
  );
  await run("UPDATE inbox_items SET status = 'handled', handled_at = datetime('now') WHERE id = ?", [id]);
  await run(
    "INSERT INTO activity_events (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source) VALUES (?, ?, ?, 'document', 'document', ?, ?, ?, 'ai')",
    [item.property_id, item.unit_id, item.tenant_id, doc.lastInsertRowid, "Document automatically filed: " + title, d.ai_summary ?? item.raw_text ?? null],
  );
  if (d.deadline_at) {
    await run(
      `INSERT INTO review_items
        (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, confidence, risk_level)
       VALUES (?, ?, ?, ?, 'deadline', ?, ?, ?, 1, 'high')`,
      [id, item.property_id, item.unit_id, item.tenant_id, "Deadline — " + title,
       "This document contains a tracked deadline: " + d.deadline_at,
       "Review the document and confirm the required follow-up before the deadline."],
    );
  }
  const row = await get("SELECT * FROM documents WHERE id = ?", [doc.lastInsertRowid]);
  return c.json({ needs_review: false, document: row }, 201);
});

const ReviewInput = z.object({
  inbox_item_id: z.number().int().optional().nullable(),
  property_id: z.number().int().optional().nullable(),
  unit_id: z.number().int().optional().nullable(),
  tenant_id: z.number().int().optional().nullable(),
  review_type: z.enum(["payment", "maintenance", "document", "deadline", "other"]),
  title: z.string().min(1),
  reason: z.string().optional().nullable(),
  proposed_action: z.string().optional().nullable(),
  proposed_json: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
  risk_level: z.enum(["low", "normal", "high"]).optional(),
});

app.get("/api/review-items", async (c) => {
  const status = c.req.query("status") ?? "open";
  const rows = await query(
    `SELECT r.*, p.name as property_name, u.name as unit_name,
       t.first_name || ' ' || t.last_name as tenant_name
     FROM review_items r
     LEFT JOIN properties p ON p.id = r.property_id
     LEFT JOIN units u ON u.id = r.unit_id
     LEFT JOIN tenants t ON t.id = r.tenant_id
     WHERE r.status = ?
     ORDER BY CASE r.risk_level WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, r.created_at ASC`,
    [status],
  ).catch(() => []);
  return c.json({ review_items: rows });
});

app.post("/api/review-items", async (c) => {
  const parsed = await parseJson(c, ReviewInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO review_items
      (inbox_item_id, property_id, unit_id, tenant_id, review_type, title, reason, proposed_action, proposed_json, confidence, risk_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.inbox_item_id ?? null, d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null,
     d.review_type, d.title, d.reason ?? null, d.proposed_action ?? null, d.proposed_json ?? null,
     d.confidence ?? null, d.risk_level ?? "normal"],
  );
  if (d.inbox_item_id) await run("UPDATE inbox_items SET status = 'needs_review' WHERE id = ?", [d.inbox_item_id]);
  const row = await get("SELECT * FROM review_items WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ review_item: row }, 201);
});

const ResolveReviewInput = z.object({
  status: z.enum(["approved", "edited", "dismissed"]),
  resolution: z.string().min(1),
});

app.post("/api/review-items/:id/resolve", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ResolveReviewInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const existing = await get<any>("SELECT * FROM review_items WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  await run(
    "UPDATE review_items SET status = ?, resolution = ?, resolved_at = datetime('now') WHERE id = ?",
    [parsed.data.status, parsed.data.resolution, id],
  );

  if (existing.review_type === "maintenance" && parsed.data.status === "approved" && existing.inbox_item_id) {
    const inbox = await get<any>("SELECT * FROM inbox_items WHERE id = ?", [existing.inbox_item_id]);
    if (inbox) {
      const sourceNote = "AI Inbox item #" + inbox.id;
      const prior = await get<any>("SELECT id FROM work_orders WHERE notes LIKE ? LIMIT 1", ["%" + sourceNote + "%"]);
      if (!prior) {
        const priority = existing.risk_level === "high" ? "urgent" : "normal";
        const work = await run(
          "INSERT INTO work_orders (property_id, unit_id, tenant_id, title, description, priority, status, notes) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
          [existing.property_id ?? inbox.property_id, existing.unit_id ?? inbox.unit_id,
           existing.tenant_id ?? inbox.tenant_id, inbox.subject || "Maintenance request",
           inbox.raw_text ?? null, priority, "Created after manager review of " + sourceNote],
        );
        await run(
          "INSERT INTO activity_events (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source) VALUES (?, ?, ?, 'maintenance', 'work_order', ?, ?, ?, 'manager')",
          [existing.property_id ?? inbox.property_id, existing.unit_id ?? inbox.unit_id,
           existing.tenant_id ?? inbox.tenant_id, work.lastInsertRowid,
           "Maintenance work order approved: " + (inbox.subject || "Maintenance request"),
           parsed.data.resolution],
        );
      }
    }
  }

  // A payment exception is not complete just because the review card was clicked.
  // Keep the reconciliation record in sync so dashboards and audit history reflect
  // the manager's actual decision.
  if (existing.review_type === "payment") {
    const recon = existing.inbox_item_id
      ? await get<any>(
          "SELECT * FROM payment_reconciliations WHERE inbox_item_id = ? AND status = 'needs_review' ORDER BY id DESC LIMIT 1",
          [existing.inbox_item_id],
        )
      : await get<any>(
          "SELECT * FROM payment_reconciliations WHERE unit_id = ? AND status = 'needs_review' ORDER BY id DESC LIMIT 1",
          [existing.unit_id],
        );

    if (recon) {
      if (parsed.data.status === "approved") {
        const payment = await run(
          `INSERT INTO payments (charge_id, paid_at, amount, method, reference, notes)
           VALUES (?, ?, ?, 'ach', ?, ?)`,
          [recon.charge_id, recon.received_at, recon.received_amount, recon.reference,
           "Applied after manager review: " + parsed.data.resolution],
        );
        await run(
          "UPDATE payment_reconciliations SET payment_id = ?, status = 'resolved', decision = ?, reviewed_at = datetime('now') WHERE id = ?",
          [payment.lastInsertRowid, parsed.data.resolution, recon.id],
        );
        const charge = await get<any>("SELECT amount FROM rent_charges WHERE id = ?", [recon.charge_id]);
        const sum = await get<{ total: number }>(
          "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE charge_id = ?",
          [recon.charge_id],
        );
        const totalPaid = Number(sum?.total ?? 0);
        const chargeStatus = charge && totalPaid >= Number(charge.amount) ? "paid" : totalPaid > 0 ? "partial" : "open";
        await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [totalPaid, chargeStatus, recon.charge_id]);
      } else if (parsed.data.status === "dismissed") {
        await run(
          "UPDATE payment_reconciliations SET status = 'resolved', decision = ?, reviewed_at = datetime('now') WHERE id = ?",
          ["dismissed: " + parsed.data.resolution, recon.id],
        );
      }
    }
  }

  if (existing.inbox_item_id) {
    const inboxStatus = parsed.data.status === "dismissed" ? "dismissed" : "handled";
    await run("UPDATE inbox_items SET status = ?, handled_at = datetime('now') WHERE id = ?", [inboxStatus, existing.inbox_item_id]);
  }
  await run(
    `INSERT INTO activity_events
      (property_id, unit_id, tenant_id, event_type, entity_type, entity_id, summary, detail, source)
     VALUES (?, ?, ?, 'review', 'review_item', ?, ?, ?, 'manager')`,
    [existing.property_id, existing.unit_id, existing.tenant_id, id,
     `${existing.title}: ${parsed.data.status}`, parsed.data.resolution],
  );
  const row = await get("SELECT * FROM review_items WHERE id = ?", [id]);
  return c.json({ review_item: row });
});

app.get("/api/activity", async (c) => {
  const unitId = intParam(c.req.query("unit_id"));
  const tenantId = intParam(c.req.query("tenant_id"));
  const where: string[] = [];
  const params: unknown[] = [];
  if (unitId) { where.push("a.unit_id = ?"); params.push(unitId); }
  if (tenantId) { where.push("a.tenant_id = ?"); params.push(tenantId); }
  const rows = await query(
    `SELECT a.*, p.name as property_name, u.name as unit_name,
       t.first_name || ' ' || t.last_name as tenant_name
     FROM activity_events a
     LEFT JOIN properties p ON p.id = a.property_id
     LEFT JOIN units u ON u.id = a.unit_id
     LEFT JOIN tenants t ON t.id = a.tenant_id
     ${where.length ? " WHERE " + where.join(" AND ") : ""}
     ORDER BY a.created_at DESC, a.id DESC LIMIT 500`,
    params,
  ).catch(() => []);
  return c.json({ activity: rows });
});

app.get("/api/operations/summary", async (c) => {
  const safeCount = (sql: string) => get<{ n: number }>(sql).catch(() => ({ n: 0 }));
  const [attention, inboxNew, handledToday, pendingRecon, openWork] = await Promise.all([
    safeCount("SELECT COUNT(*) n FROM review_items WHERE status = 'open'"),
    safeCount("SELECT COUNT(*) n FROM inbox_items WHERE status IN ('new','classified')"),
    safeCount("SELECT COUNT(*) n FROM inbox_items WHERE status = 'handled' AND date(handled_at) = date('now')"),
    safeCount("SELECT COUNT(*) n FROM payment_reconciliations WHERE status IN ('pending','needs_review')"),
    safeCount("SELECT COUNT(*) n FROM work_orders WHERE status NOT IN ('completed','cancelled')"),
  ]);
  return c.json({
    needs_attention: attention?.n ?? 0,
    inbox_unprocessed: inboxNew?.n ?? 0,
    handled_today: handledToday?.n ?? 0,
    payment_exceptions: pendingRecon?.n ?? 0,
    open_work_orders: openWork?.n ?? 0,
  });
});

// ── Dashboard summary ──────────────────────────────────────────────

app.get("/api/dashboard/summary", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const periodNow = today.slice(0, 7);

  const safeGet = <T,>(sql: string, params: unknown[] = [], fallback: T) =>
    get<T>(sql, params).catch(() => fallback as T | undefined).then((v) => v ?? fallback);
  const safeQuery = <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    query<T>(sql, params).catch(() => [] as T[]);

  const [
    propertyCount,
    unitCount,
    occupiedCount,
    vacantCount,
    activeLeases,
    upcomingMoveOuts,
    monthOutstanding,
    monthCollected,
    overdueRow,
    openWorkOrders,
    urgentWorkOrders,
    recentWorkOrders,
    upcomingExpirations,
  ] = await Promise.all([
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM properties", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units WHERE status = 'occupied'", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units WHERE status = 'vacant'", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM leases WHERE status = 'active'", [], { n: 0 }),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM leases WHERE status = 'active' AND end_date <= date('now', '+30 days')",
      [], { n: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(amount - amount_paid), 0) as total FROM rent_charges WHERE period = ? AND status != 'waived'",
      [periodNow], { total: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(amount_paid), 0) as total FROM rent_charges WHERE period = ?",
      [periodNow], { total: 0 },
    ),
    safeGet<{ total: number; n: number }>(
      "SELECT COALESCE(SUM(amount - amount_paid), 0) as total, COUNT(*) as n FROM rent_charges WHERE due_date < date('now') AND amount_paid < amount AND status != 'waived'",
      [], { total: 0, n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM work_orders WHERE status NOT IN ('completed', 'cancelled')",
      [], { n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM work_orders WHERE priority = 'urgent' AND status NOT IN ('completed', 'cancelled')",
      [], { n: 0 },
    ),
    safeQuery<{ id: number; title: string; priority: string; status: string; property_name: string | null; unit_name: string | null; created_at: string }>(
      `SELECT w.id, w.title, w.priority, w.status, p.name as property_name, u.name as unit_name, w.created_at
       FROM work_orders w
       LEFT JOIN properties p ON p.id = w.property_id
       LEFT JOIN units u ON u.id = w.unit_id
       WHERE w.status NOT IN ('completed', 'cancelled')
       ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.created_at DESC
       LIMIT 6`,
    ),
    safeQuery<{ id: number; end_date: string; tenant_first_name: string | null; tenant_last_name: string | null; unit_name: string | null; property_name: string | null }>(
      `SELECT l.id, l.end_date,
         t.first_name as tenant_first_name, t.last_name as tenant_last_name,
         u.name as unit_name, p.name as property_name
       FROM leases l
       LEFT JOIN tenants t ON t.id = l.primary_tenant_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE l.status = 'active' AND l.end_date <= date('now', '+60 days')
       ORDER BY l.end_date ASC LIMIT 6`,
    ),
  ]);

  return c.json({
    period: periodNow,
    properties: propertyCount.n,
    units: unitCount.n,
    occupied: occupiedCount.n,
    vacant: vacantCount.n,
    occupancy_rate: unitCount.n ? Math.round((occupiedCount.n / unitCount.n) * 100) : 0,
    active_leases: activeLeases.n,
    upcoming_move_outs: upcomingMoveOuts.n,
    month_outstanding: monthOutstanding.total,
    month_collected: monthCollected.total,
    overdue_total: overdueRow.total,
    overdue_count: overdueRow.n,
    open_work_orders: openWorkOrders.n,
    urgent_work_orders: urgentWorkOrders.n,
    recent_work_orders: recentWorkOrders,
    upcoming_expirations: upcomingExpirations,
  });
});

// ── Settings (key/value) ───────────────────────────────────────────

app.get("/api/settings", async (c) => {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  // Defaults first, so a caller always gets a currency and a due day even if
  // the seed has not run yet (a brand-new database, or a deleted row).
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

app.put("/api/settings", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Body must be an object" }, 400);
  const entries = Object.entries(body as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
  for (const [key, value] of entries) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, String(value)],
    );
  }
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

// ── Health ─────────────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
