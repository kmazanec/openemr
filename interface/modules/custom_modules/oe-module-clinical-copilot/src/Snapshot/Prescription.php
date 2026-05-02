<?php

/**
 * Clinic-written prescription line.
 *
 * Sourced from OpenEMR's `prescriptions` table — represents what *this
 * clinic* has prescribed (FHIR `MedicationRequest`). Distinct from
 * `MedicationStatement` (Phase 4.6.4) which captures what the patient
 * reports they're taking (OTC, supplements, prescriptions from
 * elsewhere).
 *
 * The default snapshot includes both active rows AND inactive rows
 * modified within the last lookback window so the briefing surfaces
 * recent discontinuations (a med stopped two weeks ago is clinically
 * relevant). The narrow §4.3 prescription-change endpoint never filters
 * `active` — it always answers the question UC3 asked.
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
 * @phpstan-type PrescriptionArray array{
 *     name: string,
 *     dose: ?string,
 *     route: ?string,
 *     frequency: ?string,
 *     startDate: ?string,
 *     stopDate: ?string,
 *     prescriber: ?string,
 *     indication: ?string,
 *     prescriptionId: ?int,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Prescription
{
    public function __construct(
        public string $name,
        public ?string $dose,
        public ?string $route,
        public ?string $frequency,
        public ?DateTimeImmutable $startDate,
        // stopDate populates from `prescriptions.date_modified` only
        // when `active = 0`. For active rows we leave it null —
        // date_modified moves on any edit (typo, route correction), so
        // using it as a stopDate would falsely "stop" the med on a
        // benign edit. The adapter enforces this rule at the source.
        public ?DateTimeImmutable $stopDate,
        public ?string $prescriber,
        public ?string $indication,
        // Same value the SourceReference carries as `recordId` (a
        // string), surfaced here as a top-level int so the §4.3
        // prescription-change branch and its narrow tool can address a
        // single prescription without spelunking through the citation.
        public ?int $prescriptionId,
        public SourceReference $source,
    ) {
    }

    /**
     * @return PrescriptionArray
     */
    public function toArray(): array
    {
        return [
            'name' => $this->name,
            'dose' => $this->dose,
            'route' => $this->route,
            'frequency' => $this->frequency,
            'startDate' => $this->startDate?->format('Y-m-d'),
            'stopDate' => $this->stopDate?->format('Y-m-d'),
            'prescriber' => $this->prescriber,
            'indication' => $this->indication,
            'prescriptionId' => $this->prescriptionId,
            'source' => $this->source->toArray(),
        ];
    }
}
