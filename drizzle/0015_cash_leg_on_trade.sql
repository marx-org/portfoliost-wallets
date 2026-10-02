-- §87.5 — the UI-only "generate a cash transaction on buy/sell" switch.
--
-- One boolean per portfolio. Its ONLY job is to pre-tick the transaction form's
-- "also create a cash transaction" checkbox, so the box reflects what will
-- actually happen instead of the user guessing.
--
-- It deliberately does NOT govern the sheet import. That path uses its own
-- hardcoded kontо list in portfoliost-sheets-sync (`ALWAYS_CASH_LEG`) and keeps
-- obeying the spreadsheet's col 47 (`AU`) for every account not on it. Two
-- independent mechanisms, so the sheet never lies about an account it governs and
-- a UI toggle can never silently change what an import produces.
--
-- NOT NULL DEFAULT false so no existing account changes behaviour on deploy.
ALTER TABLE "portfolios"."portfolios" ADD COLUMN "cash_leg_on_trade" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Seed the EXISTING rows, not just the default: the ten PROD portfolios predate
-- this column, so the column default alone would leave all of them saying "no cash
-- transaction" in the UI while the importer funds the seven listed ones anyway —
-- the exact disagreement §87.5 introduces the flag to prevent.
--
-- §7b data migration in the same file as its DDL (explicitly allowed), guarded on
-- the column still being false so it is idempotent, and touching only the owning
-- module's table. The names are PORTFOLIO names, which are 1:1 with the sheet's
-- Konto per §62; the same seven live in portfoliost-sheets-sync as
-- ALWAYS_CASH_LEG — see the note on CASH_LEG_DEFAULT_PORTFOLIOS in
-- src/routes/portfolios.ts for why that is a copy and not a shared export.
UPDATE portfolios.portfolios
   SET cash_leg_on_trade = true
 WHERE cash_leg_on_trade = false
   AND name = ANY (ARRAY[
     'Equate+', 'Crypto', 'NN TFI PPK', 'NN TFI PPO', 'Obligacje PKO SA Beata',
     'Rach. rejestrowy PKO BP', 'XTB'
   ]);