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
use Doctrine\DBAL\Schema\Table;
use Doctrine\DBAL\Types\Types;
use Doctrine\Migrations\AbstractMigration;

/**
 * Clinical Co-Pilot — per-practitioner morning-prep settings (§5.2).
 *
 * Stores opt-in state for the UC5 morning-prep precompute job. The job
 * (added in §5.3) selects rows where `morning_prep_enabled = TRUE` and
 * fans out one UC1 briefing per appointment for that practitioner. Default
 * is FALSE — opt-in — so a fresh deploy spends zero LLM tokens until a
 * clinician explicitly turns the feature on.
 *
 * Schema columns map 1:1 to
 * {@see \OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository::COLUMN_NAMES};
 * the contract test pins them so SQL and PHP can't drift.
 */
final class Version20260502000001 extends AbstractMigration
{
    use CreateTableTrait;

    public function getDescription(): string
    {
        return 'Create agent_practitioner_settings table for morning-prep opt-in';
    }

    public function up(Schema $schema): void
    {
        $table = new Table('agent_practitioner_settings');
        $table->addColumn('practitioner_uuid', Types::STRING, ['length' => 36]);
        $table->addColumn('morning_prep_enabled', Types::BOOLEAN, ['default' => false]);
        $table->addColumn('morning_prep_time_local', Types::TIME_MUTABLE, ['default' => '07:50:00']);
        $table->addColumn('timezone', Types::STRING, ['length' => 64, 'default' => 'America/Chicago']);
        $table->addColumn('updated_at', Types::DATETIME_IMMUTABLE);
        $this->addPrimaryKey($table, 'practitioner_uuid');
        $table->addIndex(['morning_prep_enabled'], 'idx_agent_practitioner_settings_enabled');

        $this->createTable($table);
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE agent_practitioner_settings');
    }
}
