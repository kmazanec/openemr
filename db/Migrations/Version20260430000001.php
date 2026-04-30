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
 * Clinical Co-Pilot — engineering request log + AI disclosure type seed.
 *
 * Two changes:
 *
 *  1. Create `agent_request_log` — engineering instrumentation for the agent
 *     proxy. One row per agent request with structured categories, indexed
 *     by patient and actor for cost analysis, eval reproducibility, and
 *     forensic debugging. NOT an audit table; the regulatory trail lives
 *     in OpenEMR's existing `extended_log` (see point 2). Schema columns
 *     map 1:1 to {@see \OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure}.
 *
 *  2. Seed `list_options.disclosure_type` with `disclosure-ai-treatment`
 *     so disclosure rows from {@see \OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder}
 *     render with a distinct, scannable type in the patient summary's
 *     Disclosures view, alongside the upstream-shipped Treatment / Payment /
 *     Health Care Operations entries. Compliance officers can filter on it.
 *
 * The disclosure-vs-instrumentation split, and the rationale for surfacing
 * the AI use in the patient HIPAA accounting log, is documented in the
 * module's help panel (Modules → Manage Modules → ? icon).
 */
final class Version20260430000001 extends AbstractMigration
{
    use CreateTableTrait;

    public function getDescription(): string
    {
        return 'Create agent_request_log table and seed disclosure-ai-treatment list option';
    }

    public function up(Schema $schema): void
    {
        $table = new Table('agent_request_log');
        $table->addColumn('id', Types::BIGINT, ['unsigned' => true, 'autoincrement' => true]);
        $table->addColumn('disclosed_at', Types::DATETIME_IMMUTABLE);
        $table->addColumn('actor_user_id', Types::INTEGER, ['unsigned' => true]);
        $table->addColumn('actor_fhir_user', Types::STRING, ['length' => 512]);
        $table->addColumn('site_id', Types::STRING, ['length' => 64]);
        $table->addColumn('patient_pid', Types::INTEGER, ['unsigned' => true]);
        $table->addColumn('patient_uuid', Types::STRING, ['length' => 36, 'notnull' => false]);
        $table->addColumn('conversation_id', Types::STRING, ['length' => 64, 'notnull' => false]);
        $table->addColumn('action', Types::STRING, ['length' => 64]);
        $table->addColumn('request_id', Types::STRING, ['length' => 64]);
        $table->addColumn('categories', Types::JSON);
        $table->addColumn('destination', Types::STRING, ['length' => 128]);
        $this->addPrimaryKey($table, 'id');
        $table->addIndex(['patient_pid', 'disclosed_at'], 'idx_agent_request_log_patient_time');
        $table->addIndex(['actor_user_id', 'disclosed_at'], 'idx_agent_request_log_actor_time');
        $table->addUniqueIndex(['request_id'], 'uniq_agent_request_log_request');

        $this->createTable($table);

        // Seed disclosure type. Idempotent INSERT…ON DUPLICATE so a reapply
        // on a DB that already has the row (e.g. after a partial down/up) is
        // a no-op. Sequence 40 places it after the upstream Treatment/Payment/
        // Health Care Operations options (10/20/30).
        $this->addSql(<<<'SQL'
            INSERT INTO list_options (list_id, option_id, title, seq, is_default, activity)
            VALUES ('disclosure_type', 'disclosure-ai-treatment', 'AI-assisted treatment', 40, 0, 1)
            ON DUPLICATE KEY UPDATE title = VALUES(title), seq = VALUES(seq), activity = VALUES(activity)
        SQL);
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE agent_request_log');
        $this->addSql(
            "DELETE FROM list_options "
            . "WHERE list_id = 'disclosure_type' AND option_id = 'disclosure-ai-treatment'",
        );
    }
}
