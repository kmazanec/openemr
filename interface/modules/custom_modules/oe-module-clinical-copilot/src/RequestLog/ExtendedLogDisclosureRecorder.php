<?php

/**
 * Production {@see DisclosureRecorder} that writes to OpenEMR's `extended_log`
 * table — the patient-facing HIPAA Accounting of Disclosures (§164.528) trail.
 *
 * Per-(actor, patient, day) dedup: a clinician opening the same patient's
 * chart 30 times on the same day produces *one* `extended_log` row, not 30.
 * The patient's accounting report stays legible without losing the fact that
 * an AI tool was used in the encounter.
 *
 * Schema match with `EventAuditLogger::recordDisclosure()`:
 *   date, event, user, recipient, patient_id, description.
 *
 * The `event` column is a `list_options.option_id` value from the
 * `disclosure_type` list. Migration Version20260430000001 seeds
 * `disclosure-ai-treatment` so disclosure rows from this recorder render
 * with a distinct, scannable type in the patient summary's Disclosures view.
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

final readonly class ExtendedLogDisclosureRecorder implements DisclosureRecorder
{
    public const TABLE_NAME = 'extended_log';

    /** Disclosure type seeded by the migration; matches `list_options.option_id`. */
    public const DISCLOSURE_TYPE = 'disclosure-ai-treatment';

    public function __construct(
        private Connection $connection,
        /** Static recipient label shown in the disclosures UI. */
        private string $recipient = 'Clinical Co-Pilot Agent',
    ) {
    }

    public function record(AgentDisclosure $disclosure): void
    {
        if ($this->alreadyRecordedToday($disclosure)) {
            return;
        }

        $this->connection->insert(self::TABLE_NAME, [
            'date' => $disclosure->disclosedAt->format('Y-m-d H:i:s'),
            'event' => self::DISCLOSURE_TYPE,
            'user' => (string) $disclosure->actorUserId,
            'recipient' => $this->recipient,
            'patient_id' => $disclosure->patientPid,
            'description' => $this->describe($disclosure),
        ]);
    }

    private function alreadyRecordedToday(AgentDisclosure $disclosure): bool
    {
        $day = $disclosure->disclosedAt->format('Y-m-d');
        $count = $this->connection->fetchOne(
            'SELECT COUNT(*) FROM ' . self::TABLE_NAME
            . ' WHERE event = ? AND user = ? AND patient_id = ? AND DATE(date) = ?',
            [self::DISCLOSURE_TYPE, (string) $disclosure->actorUserId, $disclosure->patientPid, $day],
        );
        return is_numeric($count) && (int) $count > 0;
    }

    private function describe(AgentDisclosure $disclosure): string
    {
        if ($disclosure->categories === []) {
            return 'AI-assisted briefing (no chart categories accessed)';
        }
        return 'AI-assisted briefing accessed chart categories: '
            . implode(', ', $disclosure->categories);
    }
}
