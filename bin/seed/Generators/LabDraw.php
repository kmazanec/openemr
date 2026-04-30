<?php

/**
 * LabDraw represents a single point in a LabSeries — a date plus the list
 * of LOINC-coded results delivered for that draw. One LabDraw corresponds
 * to one procedure_order / procedure_report row.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

final readonly class LabDraw
{
    /**
     * @param list<array{loinc: string, name: string, units: string, range: string, value: string, abnormal: string}> $results
     */
    public function __construct(
        public \DateTimeImmutable $date,
        public array $results,
    ) {
    }
}
