ALTER TABLE "portfolios"."transactions" DROP COLUMN "sector";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "industry";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "display_currency";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "is_gift";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "synthesized_opening_lot";--> statement-breakpoint
COMMENT ON TABLE "portfolios"."transactions" IS 'Ledger-first portfolio transactions (D54/D56): source of truth for position quantities, cost basis, realized P/L and (via cashLedger.tradeCashEffects) the portfolio cash history. Display currency, sector, industry and country are not stored here: they come from the owning portfolio base currency and the joined position (#116).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."id" IS 'Transaction primary key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."user_id" IS 'Owner of the transaction; the direct authorization boundary (D24).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."portfolio_id" IS 'Owning portfolio; cascades on portfolio delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."position_id" IS 'Position this row built or drew from; null for portfolio-level rows.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."type" IS 'Transaction type; one of the POSITION_TX_TYPES set.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."linked_transfer_id" IS 'Pairs a TRANSFER_OUT with its derived TRANSFER_IN.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."transfer_group_id" IS 'Ties every row of one in-kind transfer together as one atomic unit.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."source_transaction_id" IS 'The BUY a TRANSFER_OUT drew its quantity and price from.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."instrument_symbol" IS 'Instrument ticker symbol, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."instrument_name" IS 'Instrument display name, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."quantity" IS 'Quantity transacted, in instrument units.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."price" IS 'Execution price per unit, in the transaction currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."original_quantity" IS 'Quantity before a split restatement; frozen so apply-split stays idempotent.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."original_price" IS 'Price before a split restatement; frozen so apply-split stays idempotent.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."currency" IS 'Execution currency (ISO 4217).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."instrument_currency" IS 'Instrument quote currency (ISO 4217), when it differs from the execution currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."asset_type" IS 'Instrument class; defaults to STOCK.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fees" IS 'Fee charged on the transaction, in the fee currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fees_type" IS 'How fees are expressed: fixed amount or percentage.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fee_currency" IS 'Currency the fee is denominated in, when it differs from the trade currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."taxes" IS 'Taxes withheld on the transaction.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."notes" IS 'Free-form user notes.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fees_settled" IS 'Fees already settled to cash, used to avoid double-counting on later edits.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."total_amount" IS 'Total consideration: quantity x price plus fees, signed by transaction type.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."realized_gain_loss" IS 'Realized profit or loss booked on the transaction, when applicable.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."exchange_rate" IS 'Rate from the transaction currency to the owning portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."rate_source" IS 'Whether the exchange rate is resolved automatically or supplied manually.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fee_rate_source" IS 'Whether the fee exchange rate is resolved automatically or supplied manually.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."fee_exchange_rate" IS 'Rate from the fee currency to the transaction currency, when they differ.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."converted_total_amount" IS 'total_amount converted into the owning portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."converted_price" IS 'price converted into the owning portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."converted_fees" IS 'fees converted into the owning portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."converted_realized_gain_loss" IS 'realized_gain_loss converted into the owning portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."external_source" IS 'Import provenance tag; null for manually-created rows.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."external_id" IS 'Importer-supplied dedup key; unique per external_source when not null.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."executed_at" IS 'When the transaction was executed.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."created_at" IS 'Row creation timestamp.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."transactions"."updated_at" IS 'Row last-update timestamp.';