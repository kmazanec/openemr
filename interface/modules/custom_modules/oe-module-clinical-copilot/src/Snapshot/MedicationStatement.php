<?php

/**
 * Patient-reported medication line — what the patient says they're
 * actually taking, including OTC, supplements, and prescriptions
 * written elsewhere (FHIR `MedicationStatement`).
 *
 * Sourced from OpenEMR's `lists` table joined to `lists_medication`
 * filtered by `is_primary_record = 0`. Distinct from
 * {@see Prescription} (clinic Rx, FHIR `MedicationRequest`); the two
 * surfaces ride side-by-side in the snapshot so the briefing can
 * mention both:
 *
 *   - Prescriptions: "What this clinic has written"
 *   - Medications:  "What the patient says they're taking"
 *
 * The verifier rule for `medication_statement` claims is intentionally
 * looser than the prescription rule: statement rows often lack the
 * structure (no formal prescriber, no clinic-side indication) so the
 * rule asks only that the claim text contain the medication name.
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
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type MedicationStatementArray array{
 *     name: string,
 *     dose: ?string,
 *     usageCategory: ?string,
 *     informationSource: ?string,
 *     startDate: ?string,
 *     stopDate: ?string,
 *     listId: ?int,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class MedicationStatement
{
    public function __construct(
        public string $name,
        // Free-text dosage instructions from
        // `lists_medication.drug_dosage_instructions`. Often missing for
        // OTC entries — patients say "I take Tylenol" without specifying
        // strength.
        public ?string $dose,
        // Resolved title of `lists_medication.usage_category` —
        // typically "OTC", "Supplement", or "Prescribed elsewhere".
        // Helps the briefing distinguish "patient bought this on their
        // own" from "another clinic prescribed this."
        public ?string $usageCategory,
        // Resolved title of
        // `lists_medication.medication_adherence_information_source` —
        // e.g. "Patient", "Family", "External system." Surfaces in
        // briefings as "Patient reports..." vs "Caregiver reports..."
        public ?string $informationSource,
        public ?DateTimeImmutable $startDate,
        public ?DateTimeImmutable $stopDate,
        // Same value the SourceReference carries as `recordId`,
        // surfaced as a top-level int so §4.6.6's
        // medication-statement-detail branch can address one row
        // without spelunking through the citation. Mirrors the
        // `prescriptionId` / `reminderId` pattern.
        public ?int $listId,
        public SourceReference $source,
    ) {
    }

    /**
     * @return MedicationStatementArray
     */
    public function toArray(): array
    {
        return [
            'name' => $this->name,
            'dose' => $this->dose,
            'usageCategory' => $this->usageCategory,
            'informationSource' => $this->informationSource,
            'startDate' => $this->startDate?->format('Y-m-d'),
            'stopDate' => $this->stopDate?->format('Y-m-d'),
            'listId' => $this->listId,
            'source' => $this->source->toArray(),
        ];
    }
}
