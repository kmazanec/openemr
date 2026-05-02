<?php

/**
 * Data-source seam for {@see MedicationStatementAdapter}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface MedicationStatementDataSource
{
    /**
     * Patient-reported medication entries (`lists` rows where
     * `type='medication'` joined to `lists_medication` where
     * `is_primary_record=0`). Active rows only — ended OTC entries are
     * not surfaced.
     *
     * @return list<array<string, mixed>>
     */
    public function findActiveForPid(int $pid): array;
}
