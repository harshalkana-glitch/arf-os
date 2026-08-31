/**
 * Strategy registry: the immutable core of the system.
 *
 * CLAUDE.md 3.1 and spec 3.2: a tested strategy version is never mutated.
 * Any change to Pine source, definition, parameters, symbol, timeframe,
 * session, costs, sizing, leverage, execution settings, dataset, runner or
 * segment assignment creates a *new* row here, with lineage back to its
 * parent.
 *
 * That rule is enforced in three places, deliberately overlapping:
 *   1. the application, via the workflow engine,
 *   2. a database trigger that rejects UPDATE on a tested version
 *      (see migrations/0001_immutability.sql),
 *   3. the hashes below, which make an undetected substitution impossible.
 */
import { index, jsonb, pgTable, text, unique, integer, char } from 'drizzle-orm/pg-core';
import { campaigns } from './research';
import { organisations, users } from './identity';
import { createdAt, dataProtectionEnum, fk, id, ts, workflowStateEnum } from './columns';

/** The conceptual strategy. Holds no testable content itself. */
export const strategies = pgTable(
  'strategies',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    campaignId: fk('campaign_id').references(() => campaigns.id),
    name: text('name').notNull(),
    family: text('family').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('strategies_org_idx').on(t.organisationId, t.createdAt)],
);

/**
 * One immutable, testable revision.
 *
 * Every backtest, verification, validation report and decision points at a
 * row here. A result is evidence about exactly this version and no other.
 */
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyId: fk('strategy_id')
      .notNull()
      .references(() => strategies.id),
    parentVersionId: fk('parent_version_id'),
    versionNumber: integer('version_number').notNull(),
    state: workflowStateEnum('state').notNull(),

    /**
     * Identity hashes (spec 3.5). `definitionHash` covers the SDL,
     * `manifestHash` the frozen parameter manifest, `pineSourceHash` the
     * exact source text. A run whose hashes do not match these is not
     * evidence about this version.
     */
    definitionHash: char('definition_hash', { length: 64 }),
    manifestHash: char('manifest_hash', { length: 64 }),
    pineSourceHash: char('pine_source_hash', { length: 64 }),

    /** Why this version exists, when it descends from another. */
    changeReason: text('change_reason'),

    /**
     * Datasets that can no longer be treated as unseen for this version,
     * because a protected result influenced its design (leader prompt 10).
     * Spec 26: never mark reused data as unseen.
     */
    contaminatedDatasetIds: jsonb('contaminated_dataset_ids')
      .$type<string[]>()
      .notNull()
      .default([]),

    /**
     * Set the first time any run executes against this version. Once it is
     * non-null the immutability trigger refuses UPDATEs: the version has
     * been tested, and results are attached to exactly these bytes.
     */
    firstTestedAt: ts('first_tested_at'),

    createdByUserId: fk('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    // Version numbers are dense and unique per strategy, so lineage reads
    // unambiguously in the UI and in an evidence pack.
    unique('strategy_versions_number_key').on(t.strategyId, t.versionNumber),
    index('strategy_versions_strategy_idx').on(t.strategyId, t.versionNumber),
    index('strategy_versions_state_idx').on(t.organisationId, t.state),
  ],
);

/**
 * Explicit lineage edges.
 *
 * `strategy_versions.parent_version_id` records the parent; this table
 * records *why*, in the structured form spec 5.2 requires: the change
 * category, which fields changed, and which evidence motivated it.
 */
export const strategyLineage = pgTable(
  'strategy_lineage',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    parentVersionId: fk('parent_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    childVersionId: fk('child_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    /** e.g. PARAMETER, LOGIC, COST_MODEL, SYMBOL, EXECUTION, SEGMENT. */
    changeCategory: text('change_category').notNull(),
    changedFields: jsonb('changed_fields').$type<string[]>().notNull().default([]),
    motivatingEvidenceIds: jsonb('motivating_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Protection class newly assigned to the child's holdout. */
    newHoldoutClass: dataProtectionEnum('new_holdout_class'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('strategy_lineage_edge_key').on(t.parentVersionId, t.childVersionId),
    index('strategy_lineage_child_idx').on(t.childVersionId),
  ],
);

/**
 * The Strategy Definition Language document for a version.
 *
 * Stored as validated JSONB plus its canonical hash. The hash is what the
 * workflow engine compares to decide whether an edit is a new version.
 */
export const strategyDefinitions = pgTable(
  'strategy_definitions',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    schemaVersion: text('schema_version').notNull(),
    document: jsonb('document').notNull(),
    definitionHash: char('definition_hash', { length: 64 }).notNull(),
    parameterManifest: jsonb('parameter_manifest').notNull(),
    manifestHash: char('manifest_hash', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // One definition per version: a second row would make it ambiguous which
    // document a run was executed against.
    unique('strategy_definitions_version_key').on(t.strategyVersionId),
  ],
);

/**
 * An immutable Pine Script revision.
 *
 * The source text itself lives in object storage (spec 14.6); this row holds
 * identity, the manifest, and the compile/lint outcome. `sourceHash` is the
 * join key between a stored file, a backtest run, and a TradingView
 * verification.
 */
export const pineRevisions = pgTable(
  'pine_revisions',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    pineVersion: integer('pine_version').notNull().default(6),
    sourceHash: char('source_hash', { length: 64 }).notNull(),
    /** Object-store key of the source bundle. */
    sourceObjectKey: text('source_object_key').notNull(),
    manifest: jsonb('manifest').notNull(),
    manifestHash: char('manifest_hash', { length: 64 }).notNull(),
    /** Static-check findings, preserved verbatim (CLAUDE.md 13). */
    lintFindings: jsonb('lint_findings').$type<unknown[]>().notNull().default([]),
    compileReport: jsonb('compile_report'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('pine_revisions_version_key').on(t.strategyVersionId),
    index('pine_revisions_source_hash_idx').on(t.sourceHash),
  ],
);
