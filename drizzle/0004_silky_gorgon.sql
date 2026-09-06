CREATE TABLE "portfolios"."labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios"."position_labels" (
	"position_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "position_labels_position_id_label_id_pk" PRIMARY KEY("position_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."transaction_labels" (
	"transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "transaction_labels_transaction_id_label_id_pk" PRIMARY KEY("transaction_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."wallet_transaction_labels" (
	"wallet_transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "wallet_transaction_labels_wallet_transaction_id_label_id_pk" PRIMARY KEY("wallet_transaction_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "portfolios"."position_labels" ADD CONSTRAINT "position_labels_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."position_labels" ADD CONSTRAINT "position_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transaction_labels" ADD CONSTRAINT "transaction_labels_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "portfolios"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transaction_labels" ADD CONSTRAINT "transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."wallet_transaction_labels" ADD CONSTRAINT "wallet_transaction_labels_wallet_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallets"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."wallet_transaction_labels" ADD CONSTRAINT "wallet_transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_labels_user_name" ON "portfolios"."labels" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "idx_labels_user" ON "portfolios"."labels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_position_labels_label" ON "portfolios"."position_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_labels_label" ON "portfolios"."transaction_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_wallet_transaction_labels_label" ON "portfolios"."wallet_transaction_labels" USING btree ("label_id");