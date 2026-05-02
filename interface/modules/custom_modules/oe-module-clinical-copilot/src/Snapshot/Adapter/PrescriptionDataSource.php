<?php

/**
 * Data-source seam for {@see PrescriptionAdapter}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface PrescriptionDataSource
{
    /**
     * Active prescriptions plus inactive rows modified within the last
     * `$lookbackDays` days. Surfacing recent discontinuations is the
     * point — a med stopped two weeks ago is clinically relevant for
     * the next visit, even though it's `active = 0`.
     *
     * @return list<array<string, mixed>>
     */
    public function findRecentForPid(int $pid, int $lookbackDays): array;
}
