-- ── Settings (key/value) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Defaults live in the app (DEFAULT_SETTINGS in src/server/index.ts): a
-- deploy applies DDL only, so a seed row here fails the whole build.

-- ── Properties (buildings) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single_family',  -- 'single_family' | 'multi_family' | 'condo' | 'townhouse' | 'commercial'
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  year_built INTEGER,
  notes TEXT,
  color TEXT NOT NULL DEFAULT 'sky',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Units (rentable spaces inside a property) ────────────────────
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                          -- e.g. 'Unit 1A', '308', 'Main house'
  bedrooms REAL NOT NULL DEFAULT 1,            -- studio = 0, allows half-beds (rare)
  bathrooms REAL NOT NULL DEFAULT 1,           -- allows half-baths (1.5)
  sqft INTEGER,
  market_rent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'vacant',       -- 'vacant' | 'occupied' | 'turnover' | 'unavailable'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);

-- ── Tenants ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  date_of_birth TEXT,
  emergency_contact TEXT,
  employer TEXT,
  monthly_income REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenants_name ON tenants(last_name, first_name);

-- ── Leases ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  primary_tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  start_date TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  end_date TEXT NOT NULL,
  monthly_rent REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  rent_due_day INTEGER NOT NULL DEFAULT 1,
  late_fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',       -- 'upcoming' | 'active' | 'ended' | 'cancelled'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leases_unit ON leases(unit_id);
CREATE INDEX IF NOT EXISTS idx_leases_tenant ON leases(primary_tenant_id);
CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);

-- Multi-tenant leases (occupants beyond the primary).
CREATE TABLE IF NOT EXISTS lease_tenants (
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (lease_id, tenant_id)
);

-- ── Rent charges (one per period per lease) ──────────────────────
CREATE TABLE IF NOT EXISTS rent_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                        -- 'YYYY-MM' (e.g. '2026-04')
  due_date TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  amount REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'partial' | 'paid' | 'overdue' | 'waived'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_lease_period ON rent_charges(lease_id, period);
CREATE INDEX IF NOT EXISTS idx_charges_due ON rent_charges(due_date);
CREATE INDEX IF NOT EXISTS idx_charges_status ON rent_charges(status);

-- ── Payments (applied to a charge) ───────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id INTEGER NOT NULL REFERENCES rent_charges(id) ON DELETE CASCADE,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  amount REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'cash',         -- 'cash' | 'check' | 'ach' | 'credit' | 'other'
  reference TEXT,                              -- check number, transaction ID, etc.
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);

-- ── Vendors ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',    -- 'plumber' | 'electrician' | 'hvac' | 'handyman' | 'cleaning' | 'landscaping' | 'general'
  phone TEXT,
  email TEXT,
  notes TEXT,
  color TEXT NOT NULL DEFAULT 'slate',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Work orders (maintenance) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,  -- who reported it
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',     -- 'low' | 'normal' | 'high' | 'urgent'
  status TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
  scheduled_at TEXT,
  completed_at TEXT,
  cost REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_wo_property ON work_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_wo_unit ON work_orders(unit_id);

-- ── Applications (manual record only — no public submission) ─────
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  monthly_income REAL,
  employer TEXT,
  desired_move_in TEXT,
  status TEXT NOT NULL DEFAULT 'new',          -- 'new' | 'screening' | 'approved' | 'declined' | 'withdrawn'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);


-- ── Small Property Manager OS: AI operations layer ───────────────
-- Incoming information is captured before the system decides whether it can
-- be handled automatically or needs a manager decision.
CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,                   -- 'email' | 'photo' | 'document' | 'manual' | 'integration'
  source_ref TEXT,                             -- external message/file/transaction identifier
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL DEFAULT 'unknown',   -- 'payment' | 'maintenance' | 'document' | 'message' | 'unknown'
  subject TEXT,
  raw_text TEXT,
  extracted_json TEXT,                        -- JSON proposed by AI/rules engine
  confidence REAL,                             -- 0.0–1.0
  status TEXT NOT NULL DEFAULT 'new',          -- 'new' | 'classified' | 'needs_review' | 'handled' | 'dismissed'
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status);
CREATE INDEX IF NOT EXISTS idx_inbox_unit ON inbox_items(unit_id);
CREATE INDEX IF NOT EXISTS idx_inbox_source_ref ON inbox_items(source_ref);

-- The manager works from this queue instead of hunting through every record.
CREATE TABLE IF NOT EXISTS review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_item_id INTEGER REFERENCES inbox_items(id) ON DELETE SET NULL,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  review_type TEXT NOT NULL,                   -- 'payment' | 'maintenance' | 'document' | 'deadline' | 'other'
  title TEXT NOT NULL,
  reason TEXT,
  proposed_action TEXT,
  proposed_json TEXT,
  confidence REAL,
  risk_level TEXT NOT NULL DEFAULT 'normal',   -- 'low' | 'normal' | 'high'
  status TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'approved' | 'edited' | 'dismissed'
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status);
CREATE INDEX IF NOT EXISTS idx_review_unit ON review_items(unit_id);

-- Append-only operational history: the audit trail behind each unit/tenant.
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,                    -- payment, maintenance, document, asset, review, note
  entity_type TEXT,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'system',       -- 'system' | 'ai' | 'manager' | 'integration'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_unit ON activity_events(unit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_events(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  storage_ref TEXT,                            -- provider/file key; actual binary is stored outside D1
  source_inbox_item_id INTEGER REFERENCES inbox_items(id) ON DELETE SET NULL,
  document_date TEXT,
  deadline_at TEXT,
  ai_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_unit ON documents(unit_id);
CREATE INDEX IF NOT EXISTS idx_documents_deadline ON documents(deadline_at);

CREATE TABLE IF NOT EXISTS unit_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,                    -- fridge, stove, flooring, window, etc.
  description TEXT,
  make TEXT,
  model TEXT,
  serial_number TEXT,
  installed_at TEXT,
  expected_life_years INTEGER,
  replacement_cost REAL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_unit ON unit_assets(unit_id);

-- Reconciliation sits beside the existing payment record. It records what the
-- automation believed, why it believed it, and whether a human had to decide.
CREATE TABLE IF NOT EXISTS payment_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_item_id INTEGER REFERENCES inbox_items(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  charge_id INTEGER REFERENCES rent_charges(id) ON DELETE SET NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  received_amount REAL NOT NULL,
  expected_amount REAL,
  received_at TEXT,
  reference TEXT,
  match_type TEXT NOT NULL DEFAULT 'unmatched', -- exact, short, over, split, late, special_rule, unmatched
  difference REAL,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, auto_matched, needs_review, resolved
  decision TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recon_status ON payment_reconciliations(status);
CREATE INDEX IF NOT EXISTS idx_recon_unit ON payment_reconciliations(unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_reference ON payment_reconciliations(reference) WHERE reference IS NOT NULL;

-- Demo data is seeded by the app on first read (ensureSeeded in
-- src/server/index.ts), never here: this file is applied as DDL only.
