<?php

/**
 * The bundle of adapter-shape rows produced by ArchetypeChartFactory.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype;

use OpenEMR\Seed\PatientArchetype;

final readonly class ArchetypeChart
{
    /**
     * @param array<string, mixed> $patientRow
     * @param list<array<string, mixed>> $conditionRows
     * @param list<array<string, mixed>> $prescriptionRows
     * @param list<array<string, mixed>> $allergyRows
     * @param list<array<string, mixed>> $encounterRows
     * @param list<array<string, mixed>> $externalEncounterRows
     * @param list<array<string, mixed>> $observationRows
     * @param list<array<string, mixed>> $reminderRows
     * @param list<array<string, mixed>> $medicationStatementRows
     * @param ?array<string, mixed> $appointmentRow
     */
    public function __construct(
        public PatientArchetype $archetype,
        public int $pid,
        public string $uuid,
        public array $patientRow,
        public array $conditionRows,
        public array $prescriptionRows,
        public array $allergyRows,
        public array $encounterRows,
        public array $observationRows,
        public ?array $appointmentRow,
        public ArchetypeGroundTruth $groundTruth,
        public array $externalEncounterRows = [],
        public array $reminderRows = [],
        public array $medicationStatementRows = [],
    ) {
    }
}
