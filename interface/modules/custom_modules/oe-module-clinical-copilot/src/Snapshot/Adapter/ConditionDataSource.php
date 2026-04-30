<?php

/**
 * Data-source seam for ConditionAdapter.
 *
 * Production wiring queries OpenEMR's `lists` table for active
 * problems (`type='medical_problem'`, `enddate IS NULL`).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface ConditionDataSource
{
    /**
     * @return list<array<string, mixed>>
     */
    public function findActiveForPid(int $pid): array;
}
