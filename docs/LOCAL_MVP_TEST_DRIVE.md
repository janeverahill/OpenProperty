# Local MVP Test Drive

This is the recommended first test before setting up a hosted preview.

Why local first:
- no deployment account changes
- no cloud database setup
- no hosting cost
- fastest way to prove the workflow end to end
- keeps demo/test data separate from any future production environment

## 1. Requirements

Install Node.js 20 or newer. Then enable Corepack so `pnpm` is available:

```bash
corepack enable
```

## 2. Get the MVP branch

Clone the repository and switch to the MVP branch:

```bash
git clone https://github.com/janeverahill/OpenProperty.git
cd OpenProperty
git checkout small-pm-os-v2
```

If the repository is already on your computer, use:

```bash
git fetch
git checkout small-pm-os-v2
git pull
```

## 3. Fastest first run

For the very first local test, use one command:

```bash
pnpm demo:first-run
```

That installs dependencies, creates a clean demo database, and starts the app.

For later sessions, use:

```bash
pnpm demo
```

If you ever want to wipe the local test data and start fresh:

```bash
pnpm demo:reset
```

## 4. Optional verification

```bash
pnpm mvp:verify
```

This runs the TypeScript check and production build. GitHub CI also runs these checks automatically.

The first-run command installs dependencies, creates/updates the local D1 database, starts the API, and starts the web interface.

Open the Vite address shown in Terminal, normally:

`http://localhost:5173`

Keep the Terminal window open while testing.

## 6. Holy-shit test

Start with the Dashboard, then try these in order:

### A. Invoice to unit history — automatic path
Open **AI Inbox → Add intake → Manual note** and enter:

```text
Invoice for Unit 1. New Whirlpool stove, January 12 2027. $849.00
```

The demo portfolio includes one unique **Unit 1**, so this is the cleanest automatic-path test. Confirm the invoice routes as a document, files, and creates unit history. Then check:
- Documents & Deadlines
- Lakeside Apartments
- Unit history & upgrades

### B. Invoice to unit history — exception path
Now enter:

```text
Invoice for Unit 204. New Whirlpool stove, January 12 2027. $849.00
```

The demo portfolio does not include Unit 204. Confirm the system does **not** guess. It should reach **Needs Attention**, where you can assign an existing demo unit and approve it. Then confirm the document and history record land on the unit you chose.

### C. Maintenance
Enter a maintenance request such as:

```text
Unit 1 bathroom sink is leaking under the cabinet.
```

Confirm an unambiguous assigned request can become a work order, while anything unclear remains visible for review.

### D. Needs Attention
Confirm the screen explains:
- why the item stopped,
- what will happen if approved,
- which unit will receive the record.

### E. Payment reconciliation
Open **Rent ledger**. The fresh demo now seeds three visible reconciliation scenarios:
- **Unit 1** — exact payment, automatically reconciled
- **Unit 101** — $14 short, sent to Needs Attention
- **Unit 102** — exact amount but late, sent to Needs Attention

Confirm the routine exact match stays out of your way while the two exceptions remain visible for a decision.

## What not to test yet

The following are intentionally not connected in this MVP:
- actual photo upload
- OCR/vision
- Gmail ingestion
- real tenant imports
- production login/security
- billing
- hosted production data

A photo selected in Quick Intake is only a local UI reference. The system does not upload or read the image.

## After the local test

If the core workflow feels right, the next recommended step is a hosted preview with a real Cloudflare D1 database. Do that only after the local acceptance test so cloud setup is not mixed with product debugging.
