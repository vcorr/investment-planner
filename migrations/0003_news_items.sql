CREATE TABLE "news_items" (
	"disclosure_id" bigint PRIMARY KEY NOT NULL,
	"company" text,
	"market" text NOT NULL,
	"category" text,
	"category_id" integer,
	"headline" text NOT NULL,
	"language" text,
	"languages" text[],
	"message_url" text,
	"released_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_hash" char(64) NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "news_items_released_at_idx" ON "news_items" USING btree ("released_at");