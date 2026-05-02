<?php

/**
 * Provenance for a single prescription — the documented fields that
 * back UC3's medication-change drill-down (§4.3 of the implementation
 * plan; USERS.md UC3): when, by whom, and for what indication a med
 * was started, plus its dose.
 *
 * **doseAdjustments carries the current single dose only.** OpenEMR's
 * `prescriptions` table has no historical dose-change column — only
 * `date_added` and `date_modified` on a single row, and `date_modified`
 * moves on any edit (typo, route correction), not just dose changes.
 * The model **must not** infer a history of dose changes from this
 * shape; if dose has changed over time, that information is not in the
 * snapshot. This contract is pinned in the agent-side tool description
 * and in the verifier rule.
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
 * @phpstan-type DoseAdjustmentArray array{
 *     dose: ?string,
 *     date: ?string,
 * }
 *
 * @phpstan-type MedicationProvenanceArray array{
 *     prescriptionId: int,
 *     drugName: string,
 *     prescriber: ?string,
 *     prescribingDate: ?string,
 *     indication: ?string,
 *     doseAdjustments: list<DoseAdjustmentArray>,
 * }
 */
final readonly class MedicationProvenance
{
    /**
     * @param list<array{dose: ?string, date: ?string}> $doseAdjustments
     */
    public function __construct(
        public int $prescriptionId,
        public string $drugName,
        public ?string $prescriber,
        public ?DateTimeImmutable $prescribingDate,
        public ?string $indication,
        public array $doseAdjustments,
    ) {
    }

    /**
     * @return MedicationProvenanceArray
     */
    public function toArray(): array
    {
        return [
            'prescriptionId' => $this->prescriptionId,
            'drugName' => $this->drugName,
            'prescriber' => $this->prescriber,
            'prescribingDate' => $this->prescribingDate?->format('Y-m-d'),
            'indication' => $this->indication,
            'doseAdjustments' => $this->doseAdjustments,
        ];
    }
}
