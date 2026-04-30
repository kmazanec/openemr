<?php

/**
 * LabSeries is the structured payload LabResultGenerator emits — one panel
 * (e.g. "Lipid Panel") with a list of LabDraws representing each point in
 * the longitudinal series for a patient. The seed command iterates the
 * draws and writes one procedure_order + procedure_report + procedure_result
 * set per draw.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

final readonly class LabSeries
{
    /**
     * @param list<LabDraw> $draws
     */
    public function __construct(
        public string $panelCode,
        public string $panelName,
        public string $specimenType,
        public array $draws,
    ) {
    }
}
