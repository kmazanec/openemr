<?php

/**
 * Data-source seam for EncounterAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface EncounterDataSource
{
    /**
     * @return list<array<string, mixed>>
     */
    public function findRecentForPid(int $pid, int $lookbackDays): array;
}
