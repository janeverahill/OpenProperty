# Small Property Manager OS — MVP Handoff

Branch: `small-pm-os-v2`

## What the MVP is

An exception-first operating layer for small property managers. Routine work should flow through the system without demanding constant data entry. Ambiguous, risky, or unusual items go to **Needs Attention** for a manager decision.

Core principle:

> If everything is normal, do not make the property manager touch it.

## Working MVP flows

### Dashboard
- Shows what needs a decision first.
- Links directly to Inbox or Needs Attention when work is waiting.
- Keeps rent, work orders, occupancy, and lease-expiration context visible.

### AI Inbox / Operations Intake
- Accepts manual notes and paper/photo-reference intake.
- Classifies routine text conservatively.
- Routes maintenance items toward work orders.
- Routes invoices/documents toward filing and review.
- Does not pretend a selected photo has been uploaded or read.

### Needs Attention
- Shows only exceptions and manager decisions.
- Displays the proposed action before approval.
- Lets the manager confirm the correct unit for maintenance/document items.
- Prevents invoice-created unit history from being approved without a unit.
- Keeps corrected unit assignment synchronized with the original Inbox item.

### Rent / Payment Reconciliation
- Exact on-time matches can reconcile automatically.
- Late, short, over, special-rule, and unexplained payments stay visible for review.
- Intentional split-payment handling is supported.
- Review decisions apply to the exact reconciliation record.

### Maintenance
- Routine assigned requests can become work orders.
- Urgent, uncertain, or unassigned requests stay in Needs Attention.
- Approved maintenance reviews preserve the proposed work-order details.

### Documents & Deadlines
- Filed documents appear in one place.
- Deadlines create visible high-priority follow-up.
- Approved document reviews create the actual document record.
- Dates are displayed in readable form.

### Unit History & Upgrades
- Property pages show practical unit history such as:
  - New Whirlpool stove — Jan 12, 2027 — $849
  - Replaced toilet — Mar 4, 2026 — $425
- Manual entry is intentionally simple: what happened, date, cost, notes.
- Older detailed asset records remain compatible.

### Invoice-to-History Pipeline
For typed invoice details, the MVP can:
1. Recognize invoice/receipt language.
2. Extract a unit hint such as Unit 204.
3. Extract a full written date when present.
4. Extract the first dollar amount.
5. Extract a concise history label such as “New Whirlpool stove”.
6. Match the unit automatically when the hint resolves uniquely.
7. File the document and add unit history when confident.
8. Send ambiguity to Needs Attention instead of guessing.

Invoice extraction has built-in self-check cases.

## Honest MVP boundaries

Not connected yet:
- real photo upload/storage
- OCR or image/vision extraction
- Gmail ingestion into the app
- production authentication and authorization
- production privacy/security hardening
- deployment
- billing/subscriptions

The current text classifier and invoice fact extractor are conservative rule-based automation. They are intentionally not presented as a hidden AI/model call.

## Recommended first step

Use the **local MVP test drive first**, before any hosted preview. It is faster, free, keeps test data isolated, and separates product debugging from cloud setup. Follow [`LOCAL_MVP_TEST_DRIVE.md`](LOCAL_MVP_TEST_DRIVE.md). The repo now includes `pnpm demo` to start the local test and `pnpm mvp:verify` to run the typecheck + production build.

## Recommended first click-through test

1. Open Dashboard.
2. Confirm the operations card reads naturally and points to the correct queue.
3. Open AI Inbox.
4. Add a manual/document intake with:
   `Invoice for Unit 204. New Whirlpool stove, January 12 2027. $849.00`
5. Confirm it routes as a document/invoice rather than maintenance.
6. If the unit exists uniquely, confirm it can proceed to filing/history.
7. Try the same intake with an unclear or nonexistent unit.
8. Confirm it lands in Needs Attention.
9. Choose the correct unit and approve.
10. Open the property page and confirm the history line appears.
11. Open Documents & Deadlines and confirm the document record appears.
12. Test a maintenance note and verify the work-order/review path.
13. Test an exact payment and then a short or late payment in the reconciliation flow.

## MVP acceptance standard

Before the user test, CI now also runs a runtime smoke check (`pnpm mvp:smoke`) that starts the local Worker, verifies the operations rule checks, confirms the demo portfolio seeded, and confirms exact/short/late payment scenarios are available.

The MVP is ready for a first real user test when:
- routine workflows are understandable without explanation,
- ambiguous items do not silently guess,
- approvals create the expected downstream record,
- the dashboard tells the manager what actually needs attention,
- no screen implies a capability that is not connected,
- CI typecheck and production build remain green.

## Preview / deployment readiness

The codebase is ready for a local/dev click-through, but it is **not wired to a remote database yet**. `wrangler.toml` still uses `database_id = "local"`, which is correct for development but means a hosted Cloudflare preview needs a real D1 database to be created and its ID configured first.

That is the next genuine setup point that needs an account/resource decision. Do not replace the local ID or deploy until the preview host/account is chosen.

## Next production phase

Priority order:
1. Real file/photo upload and durable storage.
2. OCR/vision extraction into the existing invoice/document pipeline.
3. Gmail/e-transfer ingestion.
4. Real tenant/property import and onboarding.
5. Authentication, authorization, audit/privacy hardening.
6. Hosted preview / deployment.
7. Billing and packaging.
