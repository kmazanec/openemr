<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Core\Migrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Clinical Co-Pilot — Tier-3 promotion source link.
 *
 * Adds a nullable `source_document_uuid VARCHAR(36)` column to the OpenEMR
 * tables that receive Tier-3 chart writes from the agent's Promote flow.
 * The column links a chart record back to the Tier-1 DocumentReference the
 * fact was extracted from. Existing rows (W1 carry-forward + any rows
 * predating Tier-3 promotion) carry NULL.
 *
 * Tables touched:
 *
 *  - `lists` — allergies, medical_problem, family_history records all live
 *    here keyed on `type`. The architecture spec mentions `family_history`
 *    as a separate table, but OpenEMR core stores family history in `lists`
 *    with `type='family_history'`; there is no standalone `family_history`
 *    table in stock OpenEMR. The single column on `lists` therefore covers
 *    all three Tier-3 list-shaped fact families. (Flagged in the F.1 MR
 *    description for spec follow-up — the architecture text at line 47/495
 *    of W2_ARCHITECTURE.md should be amended to reflect this.)
 *  - `procedure_report` — lab DiagnosticReport rows written by
 *    ObservationLabWriteService (F.2). Idempotency key for that service is
 *    `(source_document_uuid, panel_code, collection_date)` so the column
 *    is load-bearing for re-promotion safety.
 *
 * Idempotency: each ALTER is gated on INFORMATION_SCHEMA via a prepared
 * statement so re-running the migration on a DB that already has the
 * column is a no-op. This guards the "partial run / restored backup /
 * manual hotfix" cases where the column was already added out of band;
 * the Doctrine migrations table tracks "did this migration run", but
 * production deploys don't always preserve that table 1:1 with schema
 * state.
 *
 * Down: drops the columns. Same INFORMATION_SCHEMA gate keeps it idempotent
 * if the column is already gone.
 *
 * Implementation note. We use `ALTER TABLE` with INFORMATION_SCHEMA gating
 * rather than Doctrine's diff-based `Schema` API: column-add against a
 * legacy production table is safer as a literal ALTER, since a Schema diff
 * can produce surprising side effects when the in-code Schema doesn't
 * model every quirk of the target table. INFORMATION_SCHEMA is preferred
 * over `ADD COLUMN IF NOT EXISTS` because the latter is MariaDB-only.
 */
final class Version20260506000001 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add source_document_uuid VARCHAR(36) to lists and procedure_report for Tier-3 promotion';
    }

    public function up(Schema $schema): void
    {
        $this->addColumnIfMissing('lists', 'source_document_uuid');
        $this->addColumnIfMissing('procedure_report', 'source_document_uuid');
    }

    public function down(Schema $schema): void
    {
        $this->dropColumnIfPresent('lists', 'source_document_uuid');
        $this->dropColumnIfPresent('procedure_report', 'source_document_uuid');
    }

    private function addColumnIfMissing(string $table, string $column): void
    {
        $tableLit = $this->connection->quote($table);
        $columnLit = $this->connection->quote($column);

        $this->addSql(<<<SQL
            SET @ddl := IF(
                (
                    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = {$tableLit}
                      AND COLUMN_NAME = {$columnLit}
                ) = 0,
                'ALTER TABLE `{$table}` ADD COLUMN `{$column}` VARCHAR(36) DEFAULT NULL',
                'DO 0'
            )
        SQL);
        $this->addSql('PREPARE stmt FROM @ddl');
        $this->addSql('EXECUTE stmt');
        $this->addSql('DEALLOCATE PREPARE stmt');
    }

    private function dropColumnIfPresent(string $table, string $column): void
    {
        $tableLit = $this->connection->quote($table);
        $columnLit = $this->connection->quote($column);

        $this->addSql(<<<SQL
            SET @ddl := IF(
                (
                    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = {$tableLit}
                      AND COLUMN_NAME = {$columnLit}
                ) = 1,
                'ALTER TABLE `{$table}` DROP COLUMN `{$column}`',
                'DO 0'
            )
        SQL);
        $this->addSql('PREPARE stmt FROM @ddl');
        $this->addSql('EXECUTE stmt');
        $this->addSql('DEALLOCATE PREPARE stmt');
    }
}
