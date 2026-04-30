<?php

/**
 * Doctrine DBAL recorder for {@see AgentDisclosure} → `agent_request_log` table.
 *
 * One row per request. Schema lives in the `agent_request_log` table created
 * by `db/Migrations/Version20260430000001.php`. The column list is pinned in
 * {@see self::COLUMN_NAMES} so a structural test catches drive-by additions —
 * notably, the contract forbids prompt/completion-shaped columns (the row is
 * a fact-of-disclosure record, not a body store).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

use Doctrine\DBAL\Connection;

final readonly class DbalAgentRequestLogRecorder implements AgentRequestLogRecorder
{
    public const TABLE_NAME = 'agent_request_log';

    /**
     * Pinned column list. Order does not matter for the insert; the
     * structural test asserts the *set* matches the migration's columns.
     *
     * @var list<string>
     */
    public const COLUMN_NAMES = [
        'disclosed_at',
        'actor_user_id',
        'actor_fhir_user',
        'site_id',
        'patient_pid',
        'patient_uuid',
        'conversation_id',
        'action',
        'request_id',
        'categories',
        'destination',
    ];

    public function __construct(private Connection $connection)
    {
    }

    public function record(AgentDisclosure $disclosure): void
    {
        $this->connection->insert(self::TABLE_NAME, [
            'disclosed_at' => $disclosure->disclosedAt->format('Y-m-d H:i:s'),
            'actor_user_id' => $disclosure->actorUserId,
            'actor_fhir_user' => $disclosure->actorFhirUser,
            'site_id' => $disclosure->siteId,
            'patient_pid' => $disclosure->patientPid,
            'patient_uuid' => $disclosure->patientUuid,
            'conversation_id' => $disclosure->conversationId,
            'action' => $disclosure->action,
            'request_id' => $disclosure->requestId,
            'categories' => json_encode($disclosure->categories, JSON_THROW_ON_ERROR),
            'destination' => $disclosure->destination,
        ]);
    }
}
