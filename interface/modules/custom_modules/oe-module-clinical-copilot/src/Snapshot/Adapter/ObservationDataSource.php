<?php

/**
 * Data-source seam for ObservationAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface ObservationDataSource
{
    /**
     * @return list<array<string, mixed>>
     */
    public function findRecentForPid(int $pid, int $lookbackDays): array;

    /**
     * History rows for a single analyte. Reads the same row shape as
     * {@see findRecentForPid} but filters by analyte name and supports
     * a longer lookback window so the agent's UC2 lab-trend tool can
     * answer "is A1c trending up over the last two years?" without
     * pulling the patient's entire labs panel.
     *
     * Filter is case-insensitive substring match against the analyte
     * column. The agent caller passes the canonical name from the
     * suggested-follow-up params (e.g. "Hemoglobin A1c"), and the
     * data source resolves whichever stored variants the lab system
     * used.
     *
     * @return list<array<string, mixed>>
     */
    public function findHistoryByAnalyteForPid(
        int $pid,
        string $analyte,
        int $lookbackDays,
    ): array;
}
