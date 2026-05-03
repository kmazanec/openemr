<?php

/**
 * Data-source seam for VitalsAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface VitalsDataSource
{
    /**
     * Recent vital-sign rows (most recent first) within `$lookbackDays`.
     *
     * @return list<array<string, mixed>>
     */
    public function findRecentForPid(int $pid, int $lookbackDays): array;

    /**
     * History rows for a single vital type (e.g. "bps", "weight"),
     * ordered oldest-first so a trend reads naturally.
     *
     * The adapter passes the column-style key, not a free-form name —
     * the controller validates against {@see VitalsAdapter::VITAL_TYPES}
     * before reaching the data source.
     *
     * @return list<array<string, mixed>>
     */
    public function findHistoryByVitalTypeForPid(
        int $pid,
        string $vitalType,
        int $lookbackDays,
    ): array;
}
