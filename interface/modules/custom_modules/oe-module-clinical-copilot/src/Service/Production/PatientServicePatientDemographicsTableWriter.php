<?php

/**
 * Production wiring for {@see PatientDemographicsTableWriter}: routes
 * demographics-delta promotions through OpenEMR's standard
 * {@see \OpenEMR\Services\PatientService::databaseUpdate()} surface
 * so the existing audit-log entry + `BeforePatientUpdatedEvent` /
 * `PatientUpdatedEvent` listeners fire as if a clinician edited the
 * demographics form.
 *
 * Idempotency check ({@see fetchSnapshot()}) reads the column directly
 * via {@see Connection::fetchAssociative()} since
 * `PatientService::getOne()` returns the whole patient record (heavy
 * shape; we only need one column + the UUID). Empty-string column
 * values (the OpenEMR `''` sentinel for "not set") are normalized to
 * `null` so the service's idempotency check is symmetric with "no
 * value yet."
 *
 * The actual write goes through `PatientService::databaseUpdate()`
 * (not a direct UPDATE) because that path is what fires the audit
 * log + the `PatientUpdatedEvent` listeners stock OpenEMR ships with.
 * F.6's contract — "the standard demographics-update path's audit log
 * captures the change as a normal user-initiated update, AND F.6's
 * `AgentDisclosedEvent` adds the agent-disclosure row" — depends on
 * that path firing both rows.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service\Production;

use Doctrine\DBAL\Connection;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsField;
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsSnapshot;
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsTableWriter;
use OpenEMR\Services\PatientService;

final readonly class PatientServicePatientDemographicsTableWriter implements
    PatientDemographicsTableWriter
{
    public function __construct(
        private Connection $connection,
        private PatientService $patientService,
    ) {
    }

    public function fetchSnapshot(
        int $pid,
        DemographicsField $field,
    ): ?PatientDemographicsSnapshot {
        $column = $field->patientDataColumn();
        // The column whitelist is the closed-set enum; quoting via
        // `quoteSingleIdentifier()` keeps the static-analysis check
        // honest even though every reachable value is already SQL-safe.
        $quoted = $this->connection->quoteSingleIdentifier($column);
        $sql = <<<SQL
            SELECT uuid, {$quoted} AS field_value
            FROM patient_data
            WHERE pid = ?
            LIMIT 1
        SQL;

        $row = $this->connection->fetchAssociative($sql, [$pid]);
        if ($row === false) {
            return null;
        }

        $uuidBin = $row['uuid'];
        if (!is_string($uuidBin) || strlen($uuidBin) !== 16) {
            throw new \RuntimeException('patient_data.uuid is not a 16-byte BINARY value');
        }
        $patientUuid = UuidRegistry::uuidToString($uuidBin);

        $rawValue = $row['field_value'] ?? null;
        $currentValue = is_string($rawValue) && $rawValue !== '' ? $rawValue : null;

        return new PatientDemographicsSnapshot(
            patientUuid: $patientUuid,
            currentValue: $currentValue,
        );
    }

    public function updateField(
        int $pid,
        DemographicsField $field,
        string $value,
        int $promotedByUserId,
        \DateTimeImmutable $updatedAt,
    ): string {
        $column = $field->patientDataColumn();
        $data = [
            'pid' => $pid,
            $column => $value,
        ];

        // PatientService::databaseUpdate() reads `authUserID` off the
        // active session for `updated_by`. The agent-bootstrap context
        // doesn't carry an OpenEMR session — the JWT actor's
        // `promotedByUserId` is the right value here. The standard
        // path doesn't expose a "supply updated_by directly" hook, so
        // we set it on the data array; databaseUpdate() will overwrite
        // with `$session->get('authUserID')` if present, which is
        // either the real session user (when the agent endpoint
        // happens to be called from a logged-in browser context) or
        // null (which falls back to the value we set).
        $data['updated_by'] = $promotedByUserId;

        $result = $this->patientService->databaseUpdate($data);
        if ($result === false) {
            throw new \RuntimeException(
                'PatientService::databaseUpdate returned false for pid ' . (string) $pid,
            );
        }

        // Read the UUID back. databaseUpdate() returns the data array
        // it persisted (which now carries the `date` + `updated_by`
        // fields it stamped) but not the UUID — we have to query.
        $sql = 'SELECT uuid FROM patient_data WHERE pid = ? LIMIT 1';
        $row = $this->connection->fetchAssociative($sql, [$pid]);
        if ($row === false) {
            throw new \RuntimeException(
                'patient_data row vanished after update for pid ' . (string) $pid,
            );
        }
        $uuidBin = $row['uuid'];
        if (!is_string($uuidBin) || strlen($uuidBin) !== 16) {
            throw new \RuntimeException('patient_data.uuid is not a 16-byte BINARY value');
        }
        return UuidRegistry::uuidToString($uuidBin);
    }
}
