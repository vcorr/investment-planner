CREATE TYPE "public"."market" AS ENUM('HEL', 'STO', 'CPH');--> statement-breakpoint
CREATE TYPE "public"."segment" AS ENUM('MAIN_MARKET', 'FIRST_NORTH');--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"units_per_eur" numeric(18, 6) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_currency_rate_date_pk" PRIMARY KEY("currency","rate_date")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"isin" char(12) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sector" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"orderbook_id" text PRIMARY KEY NOT NULL,
	"isin" char(12) NOT NULL,
	"market" "market" NOT NULL,
	"segment" "segment" NOT NULL,
	"symbol" text NOT NULL,
	"currency" char(3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices_eod" (
	"orderbook_id" text NOT NULL,
	"trade_date" date NOT NULL,
	"open" numeric(18, 6),
	"high" numeric(18, 6),
	"low" numeric(18, 6),
	"close" numeric(18, 6),
	"average" numeric(18, 6),
	"bid" numeric(18, 6),
	"ask" numeric(18, 6),
	"volume" bigint,
	"turnover" numeric(20, 2),
	"trades" integer,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_eod_orderbook_id_trade_date_pk" PRIMARY KEY("orderbook_id","trade_date")
);
--> statement-breakpoint
CREATE TABLE "settings_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"hash" char(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_versions_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "verification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"finding" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_isin_instruments_isin_fk" FOREIGN KEY ("isin") REFERENCES "public"."instruments"("isin") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_eod" ADD CONSTRAINT "prices_eod_orderbook_id_listings_orderbook_id_fk" FOREIGN KEY ("orderbook_id") REFERENCES "public"."listings"("orderbook_id") ON DELETE no action ON UPDATE no action;