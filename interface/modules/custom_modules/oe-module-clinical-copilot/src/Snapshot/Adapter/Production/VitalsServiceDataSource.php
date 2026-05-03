<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsDataSource;

/**
 * Production-wired {@see VitalsDataSource} reading rows from
 * `form_vitals`. `form_vitals` carries no encounter id directly —
 * encounter linkage flows through the `forms` table — but the agent
 * tools only need observation timestamps, so the read joins are
 * deliberately minimal.
 *
 * `activity = 1` filters out vitals rows that have been "deleted" via
 * the OpenEMR UI (which sets `activity = 0` rather than removing the
 * row). The agent must not surface citations to soft-deleted data.
 */
final readonly class VitalsServiceDataSource implements VitalsDataSource
{
    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $cutoff = (new \DateTimeImmutable('today'))
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT id,
                    DATE(`date`) AS observed_at,
                    bps, bpd, pulse, respiration, temperature,
                    weight, height, BMI, oxygen_saturation
               FROM form_vitals
              WHERE pid = ?
                AND activity = 1
                AND DATE(`date`) >= ?
              ORDER BY `date` DESC, id DESC",
            [$pid, $cutoff],
        ));
    }

    public function findHistoryByVitalTypeForPid(
        int $pid,
        string $vitalType,
        int $lookbackDays,
    ): array {
        // Defense in depth: the controller is the trust boundary, but
        // we also enforce the allowlist here so a hypothetical future
        // caller that bypasses the controller can't inject a column.
        $column = VitalsAdapter::VITAL_TYPES[$vitalType] ?? null;
        if ($column === null) {
            return [];
        }

        $cutoff = (new \DateTimeImmutable('today'))
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d');

        // Filter out rows where this specific vital wasn't recorded —
        // form_vitals zero-fills missing numerics, and a trend is
        // misleading if it includes filler zeros.
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            'SELECT id,
                    DATE(`date`) AS observed_at,
                    bps, bpd, pulse, respiration, temperature,
                    weight, height, BMI, oxygen_saturation
               FROM form_vitals
              WHERE pid = ?
                AND activity = 1
                AND DATE(`date`) >= ?
                AND `' . $column . '` IS NOT NULL
                AND `' . $column . '` <> 0
              ORDER BY `date` ASC, id ASC',
            [$pid, $cutoff],
        ));
    }
}
