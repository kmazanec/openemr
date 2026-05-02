<?php

/**
 * Active or recently-discontinued medication line.
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
 * @phpstan-type MedicationArray array{
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
final readonly class Medication
{
    public function __construct(
        public string $name,
        public ?string $dose,
        public ?string $route,
        public ?string $frequency,
        public ?DateTimeImmutable $startDate,
        public ?DateTimeImmutable $stopDate,
        public ?string $prescriber,
        public ?string $indication,
        // Same value the SourceReference carries as `recordId` (a string),
        // surfaced here as a top-level int so the §4.3 medication-change
        // branch and its narrow tool can address a single prescription
        // without spelunking through the citation.
        public ?int $prescriptionId,
        public SourceReference $source,
    ) {
    }

    /**
     * @return MedicationArray
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
