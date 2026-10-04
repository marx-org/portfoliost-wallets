ALTER TABLE "portfolios"."transactions" DROP CONSTRAINT "ck_ptx_type";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "linked_transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "transfer_group_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "source_transaction_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_ptx_transfer_group" ON "portfolios"."transactions" USING btree ("transfer_group_id");--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "ck_ptx_transfer_out_source" CHECK ("portfolios"."transactions"."type" <> 'TRANSFER_OUT' or "portfolios"."transactions"."source_transaction_id" is not null);--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "ck_ptx_transfer_in_linked" CHECK ("portfolios"."transactions"."type" <> 'TRANSFER_IN' or "portfolios"."transactions"."linked_transfer_id" is not null);--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "ck_ptx_type" CHECK ("portfolios"."transactions"."type" in ('BUY','SELL','DIVIDEND','EXPIRATION','TRANSFER_OUT','TRANSFER_IN'));