<?php

/**
 * Provenance for a single patient-reported medication for the §4.6.6
 * medication-statement-detail drill-down. Returns the documented
 * fields the clinician actually wants when drilling into "what did
 * the patient say about this":
 *
 *   - dosage instructions (free text the patient gave),
 *   - usage category (OTC / Supplement / Prescribed elsewhere),
 *   - information source (Patient / Family / External system),
 *   - adherence-asserted date,
 *   - linkedPrescriptionId — when set, this self-reported entry is
 *     linked to a clinic-written Rx (`lists_medication.prescription_id`).
 *     Lets the briefing say "patient reports taking the metformin
 *     we prescribed" instead of treating the two as duplicates.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;

/**
 * @phpstan-type MedicationStatementProvenanceArray array{
 *     listId: int,
 *     name: string,
 *     dose: ?string,
 *     usageCategory: ?string,
 *     informationSource: ?string,
 *     adherenceAssertedAt: ?string,
 *     startDate: ?string,
 *     stopDate: ?string,
 *     linkedPrescriptionId: ?int,
 * }
 */
final readonly class MedicationStatementProvenance
{
    public function __construct(
        public int $listId,
        public string $name,
        public ?string $dose,
        public ?string $usageCategory,
        public ?string $informationSource,
        public ?DateTimeImmutable $adherenceAssertedAt,
        public ?DateTimeImmutable $startDate,
        public ?DateTimeImmutable $stopDate,
        // FK to `prescriptions.id` when this MedicationStatement is
        // linked to a clinic-written Rx. null for pure
        // patient-reported entries (OTC, supplements, prescribed
        // elsewhere).
        public ?int $linkedPrescriptionId,
    ) {
    }

    /**
     * @return MedicationStatementProvenanceArray
     */
    public function toArray(): array
    {
        return [
            'listId' => $this->listId,
            'name' => $this->name,
            'dose' => $this->dose,
            'usageCategory' => $this->usageCategory,
            'informationSource' => $this->informationSource,
            'adherenceAssertedAt' => $this->adherenceAssertedAt?->format('Y-m-d'),
            'startDate' => $this->startDate?->format('Y-m-d'),
            'stopDate' => $this->stopDate?->format('Y-m-d'),
            'linkedPrescriptionId' => $this->linkedPrescriptionId,
        ];
    }
}
