<?php

/**
 * Data-source seam for PatientAdapter.
 *
 * Production wiring (Phase 2.5) returns the row that
 * `OpenEMR\Services\PatientService::findByPid()` produces, narrowed to
 * the columns the adapter actually consumes.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface PatientDataSource
{
    /**
     * @return ?array<string, mixed> the patient row, or null if not found
     */
    public function findByPid(int $pid): ?array;
}
