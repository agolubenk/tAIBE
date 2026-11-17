CREATE TABLE "form_template" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"template" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "form_template_workspace_slug_version_unique" UNIQUE("workspace_id","slug","version")
);
--> statement-breakpoint
CREATE TABLE "task_form" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"template_id" text NOT NULL,
	"answers" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp,
	"submitted_by" text,
	"updated_by" text,
	"attached_by" text,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "task_form_task_template_unique" UNIQUE("task_id","template_id")
);
--> statement-breakpoint
ALTER TABLE "form_template" ADD CONSTRAINT "form_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_form" ADD CONSTRAINT "task_form_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
-- TB-173 hand line: DEFERRABLE INITIALLY DEFERRED (drizzle-kit does not keep it). A workspace delete reaches
-- form_template and task_form by two cascades; an immediate check fails first. Guard: tests/api-integration/form-delete.test.ts.
ALTER TABLE "task_form" ADD CONSTRAINT "task_form_template_id_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_template"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
