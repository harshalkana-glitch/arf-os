CREATE TYPE "public"."actor_type" AS ENUM('HUMAN', 'AGENT', 'SERVICE');--> statement-breakpoint
CREATE TYPE "public"."agent_role" AS ENUM('CHIEF_RESEARCH_ORCHESTRATOR', 'IDEA_SCOUT', 'INDICATOR_RESEARCHER', 'STRATEGY_ARCHITECT', 'PINE_ENGINEER', 'BACKTEST_ENGINEER', 'ROBUSTNESS_VALIDATOR', 'FORWARD_TEST_OPERATOR', 'STRATEGY_JUDGE', 'DATA_INTEGRITY_ANALYST', 'PORTFOLIO_RESEARCHER');--> statement-breakpoint
CREATE TYPE "public"."committee_decision_type" AS ENUM('REJECT', 'REWORK_WITH_NEW_VERSION', 'PAPER_APPROVED', 'RESEARCH_APPROVED', 'LIVE_CANDIDATE_FOR_HUMAN_REVIEW', 'INSUFFICIENT_EVIDENCE');--> statement-breakpoint
CREATE TYPE "public"."data_protection_class" AS ENUM('DEVELOPMENT', 'VALIDATION', 'FINAL_HOLDOUT', 'FORWARD', 'CONTAMINATED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."metric_scope" AS ENUM('RUN', 'SEGMENT', 'STRATEGY_VERSION', 'SYMBOL', 'PARAMETER_SET', 'FORWARD_DEPLOYMENT', 'PORTFOLIO');--> statement-breakpoint
CREATE TYPE "public"."metric_source" AS ENUM('ARF_CALCULATED', 'TRADINGVIEW_REPORTED');--> statement-breakpoint
CREATE TYPE "public"."metric_unit" AS ENUM('CURRENCY', 'PERCENT', 'RATIO', 'COUNT', 'DAYS', 'HOURS', 'BARS', 'SECONDS');--> statement-breakpoint
CREATE TYPE "public"."parity_status" AS ENUM('PASS', 'WARN', 'FAIL', 'INSUFFICIENT_DATA');--> statement-breakpoint
CREATE TYPE "public"."rbac_role" AS ENUM('VIEWER', 'RESEARCHER', 'DEVELOPER', 'VALIDATOR', 'OPERATOR', 'COMMITTEE_MEMBER', 'ADMIN', 'SERVICE_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('PERFORMANCE_SUMMARY', 'LIST_OF_TRADES', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."runner_type" AS ENUM('LOCAL_RESEARCH_RUNNER', 'TRADINGVIEW');--> statement-breakpoint
CREATE TYPE "public"."trade_direction" AS ENUM('LONG', 'SHORT');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('PRESIGNED', 'UPLOADED', 'PARSED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'AWAITING_UPLOAD', 'PARSING', 'PARSED', 'PARITY_COMPUTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('CAMPAIGN_BACKLOG', 'IDEA_RESEARCH', 'INDICATOR_RESEARCH', 'HYPOTHESIS_DRAFT', 'PINE_DEVELOPMENT', 'COMPILE_CHECK', 'BASIC_BACKTEST', 'SEGMENTED_BACKTEST', 'ROBUSTNESS_VALIDATION', 'TRADINGVIEW_VERIFICATION', 'PAPER_APPROVAL_REVIEW', 'FORWARD_TESTING', 'FINAL_REVIEW', 'RESEARCH_APPROVED', 'PAPER_APPROVED', 'LIVE_CANDIDATE', 'REJECTED', 'ARCHIVED', 'BLOCKED');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "rbac_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp(6) with time zone,
	CONSTRAINT "memberships_org_user_key" UNIQUE("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"state" "workflow_state" DEFAULT 'CAMPAIGN_BACKLOG' NOT NULL,
	"plan" jsonb,
	"budget_usd" numeric(28, 10),
	"model_spend_usd" numeric(28, 10) DEFAULT '0' NOT NULL,
	"budget_runs" integer,
	"runs_used" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"role" "agent_role" NOT NULL,
	"objective" text NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"strategy_id" uuid,
	"strategy_version_id" uuid,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "pine_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"pine_version" integer DEFAULT 6 NOT NULL,
	"source_hash" char(64) NOT NULL,
	"source_object_key" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" char(64) NOT NULL,
	"lint_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compile_report" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pine_revisions_version_key" UNIQUE("strategy_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"document" jsonb NOT NULL,
	"definition_hash" char(64) NOT NULL,
	"parameter_manifest" jsonb NOT NULL,
	"manifest_hash" char(64) NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_definitions_version_key" UNIQUE("strategy_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_lineage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"child_version_id" uuid NOT NULL,
	"change_category" text NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"motivating_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"new_holdout_class" "data_protection_class",
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_lineage_edge_key" UNIQUE("parent_version_id","child_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"parent_version_id" uuid,
	"version_number" integer NOT NULL,
	"state" "workflow_state" NOT NULL,
	"definition_hash" char(64),
	"manifest_hash" char(64),
	"pine_source_hash" char(64),
	"change_reason" text,
	"contaminated_dataset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_tested_at" timestamp(6) with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_versions_number_key" UNIQUE("strategy_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "artefacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artefacts_object_key_key" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"verification_id" uuid,
	"runner_type" "runner_type" NOT NULL,
	"runner_version" text NOT NULL,
	"source_hash" char(64) NOT NULL,
	"manifest_hash" char(64),
	"dataset_version_id" uuid,
	"environment_hash" char(64),
	"random_seed" integer,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"segment_id" text,
	"parameter_set_id" uuid,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_model" jsonb NOT NULL,
	"execution_model" jsonb NOT NULL,
	"initial_capital" numeric(28, 10) NOT NULL,
	"currency" text NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_detail" text,
	"artefact_prefix" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "equity_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"trade_number" integer NOT NULL,
	"at" timestamp(6) with time zone NOT NULL,
	"equity" numeric(28, 10) NOT NULL,
	"peak" numeric(28, 10) NOT NULL,
	"drawdown" numeric(28, 10) NOT NULL,
	"drawdown_percent" double precision NOT NULL,
	"calculation_version" text NOT NULL,
	CONSTRAINT "equity_points_run_trade_key" UNIQUE("backtest_run_id","trade_number")
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"metric_name" text NOT NULL,
	"value" numeric(28, 10),
	"null_reason" text,
	"unit" "metric_unit" NOT NULL,
	"calculation_version" text NOT NULL,
	"scope_type" "metric_scope" NOT NULL,
	"scope_id" uuid NOT NULL,
	"source" "metric_source" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_snapshots_identity_key" UNIQUE("scope_type","scope_id","metric_name","source","calculation_version")
);
--> statement-breakpoint
CREATE TABLE "parity_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"verification_id" uuid,
	"arf_run_id" uuid,
	"tradingview_run_id" uuid,
	"status" "parity_status" NOT NULL,
	"tolerance_policy_version" text NOT NULL,
	"identity_matches" jsonb NOT NULL,
	"identity_mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparisons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_divergent_trade_number" integer,
	"first_divergence_detail" text,
	"insufficient_data_reason" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"verification_id" uuid NOT NULL,
	"artefact_id" uuid,
	"report_kind" "report_kind" DEFAULT 'UNKNOWN' NOT NULL,
	"status" "upload_status" DEFAULT 'PRESIGNED' NOT NULL,
	"original_filename" text,
	"declared_sha256" char(64),
	"parser_version" text,
	"parser_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reason" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"trade_number" integer NOT NULL,
	"direction" "trade_direction" NOT NULL,
	"entry_time" timestamp(6) with time zone NOT NULL,
	"exit_time" timestamp(6) with time zone NOT NULL,
	"entry_price" numeric(28, 10) NOT NULL,
	"exit_price" numeric(28, 10) NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"gross_pnl" numeric(28, 10) NOT NULL,
	"fees" numeric(28, 10) NOT NULL,
	"net_pnl" numeric(28, 10) NOT NULL,
	"mae" numeric(28, 10),
	"mfe" numeric(28, 10),
	"entry_reason" text,
	"exit_reason" text,
	"segment_id" text,
	CONSTRAINT "trades_run_number_key" UNIQUE("backtest_run_id","trade_number")
);
--> statement-breakpoint
CREATE TABLE "tradingview_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"expected_source_hash" char(64) NOT NULL,
	"expected_symbol" text NOT NULL,
	"expected_timeframe" text NOT NULL,
	"expected_settings" jsonb NOT NULL,
	"expected_range_start" timestamp(6) with time zone,
	"expected_range_end" timestamp(6) with time zone,
	"requested_by_user_id" uuid,
	"completed_at" timestamp(6) with time zone,
	"failure_reason" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"prior_state" jsonb,
	"new_state" jsonb,
	"reason" text,
	"trace_id" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"decision" "committee_decision_type" NOT NULL,
	"from_state" "workflow_state" NOT NULL,
	"to_state" "workflow_state" NOT NULL,
	"policy_version" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"positive_case" text NOT NULL,
	"rejection_case" text NOT NULL,
	"supporting_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradicting_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"falsification_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_date" timestamp(6) with time zone,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"decided_by_user_id" uuid,
	"human_override" jsonb DEFAULT 'false'::jsonb NOT NULL,
	"override_reason" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response_status" integer,
	"resource_type" text,
	"resource_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(6) with time zone,
	CONSTRAINT "idempotency_key_unique" UNIQUE("organisation_id","endpoint","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"trace_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp(6) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pine_revisions" ADD CONSTRAINT "pine_revisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pine_revisions" ADD CONSTRAINT "pine_revisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_definitions" ADD CONSTRAINT "strategy_definitions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_definitions" ADD CONSTRAINT "strategy_definitions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_parent_version_id_strategy_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_child_version_id_strategy_versions_id_fk" FOREIGN KEY ("child_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_arf_run_id_backtest_runs_id_fk" FOREIGN KEY ("arf_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_tradingview_run_id_backtest_runs_id_fk" FOREIGN KEY ("tradingview_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_artefact_id_artefacts_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "public"."artefacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisations_external_id_key" ON "organisations" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_key" ON "users" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "campaigns_org_state_idx" ON "campaigns" USING btree ("organisation_id","state","created_at");--> statement-breakpoint
CREATE INDEX "research_tasks_campaign_idx" ON "research_tasks" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "research_tasks_version_idx" ON "research_tasks" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "pine_revisions_source_hash_idx" ON "pine_revisions" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "strategies_org_idx" ON "strategies" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "strategy_lineage_child_idx" ON "strategy_lineage" USING btree ("child_version_id");--> statement-breakpoint
CREATE INDEX "strategy_versions_strategy_idx" ON "strategy_versions" USING btree ("strategy_id","version_number");--> statement-breakpoint
CREATE INDEX "strategy_versions_state_idx" ON "strategy_versions" USING btree ("organisation_id","state");--> statement-breakpoint
CREATE INDEX "artefacts_sha_idx" ON "artefacts" USING btree ("organisation_id","content_sha256");--> statement-breakpoint
CREATE INDEX "backtest_runs_version_idx" ON "backtest_runs" USING btree ("strategy_version_id","created_at");--> statement-breakpoint
CREATE INDEX "backtest_runs_status_idx" ON "backtest_runs" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "backtest_runs_source_hash_idx" ON "backtest_runs" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "equity_points_run_idx" ON "equity_points" USING btree ("backtest_run_id","at");--> statement-breakpoint
CREATE INDEX "metric_snapshots_scope_idx" ON "metric_snapshots" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "parity_reports_version_idx" ON "parity_reports" USING btree ("strategy_version_id","created_at");--> statement-breakpoint
CREATE INDEX "report_uploads_verification_idx" ON "report_uploads" USING btree ("verification_id","report_kind");--> statement-breakpoint
CREATE INDEX "trades_run_exit_idx" ON "trades" USING btree ("backtest_run_id","exit_time");--> statement-breakpoint
CREATE INDEX "tv_verifications_version_idx" ON "tradingview_verifications" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "tv_verifications_status_idx" ON "tradingview_verifications" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "audit_events_aggregate_idx" ON "audit_events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_idx" ON "audit_events" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "committee_decisions_version_idx" ON "committee_decisions" USING btree ("strategy_version_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");