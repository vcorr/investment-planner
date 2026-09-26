CREATE TABLE "news_poll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"fetched" integer,
	"in_scope" integer,
	"inserted" integer,
	"pages" integer,
	"gap" boolean,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "news_poll_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "news_poll_runs_started_at_idx" ON "news_poll_runs" USING btree ("started_at");