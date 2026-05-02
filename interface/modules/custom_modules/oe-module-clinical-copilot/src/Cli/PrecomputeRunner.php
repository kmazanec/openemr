<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Cli;

use DateTimeImmutable;

/**
 * Console-side seam for the orchestrator. Lets {@see \OpenEMR\Common\Command\AgentPrecomputeDayCommand}
 * be unit-tested against a fake without dragging the full
 * orchestrator dependency graph into a CLI test.
 */
interface PrecomputeRunner
{
    public function runForWindow(DateTimeImmutable $now, RunOptions $options): RunSummary;
}
