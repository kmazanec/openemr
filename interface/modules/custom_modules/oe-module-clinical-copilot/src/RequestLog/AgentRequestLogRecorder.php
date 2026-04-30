<?php

/**
 * Persists a per-request engineering row for an {@see AgentDisclosure}.
 *
 * Distinct from the regulatory `extended_log` write (handled by
 * {@see ExtendedLogDisclosureRecorder}). This recorder backs the
 * `agent_request_log` table — every request gets a row with structured
 * categories for cost analysis, eval reproducibility, and forensic debugging.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

interface AgentRequestLogRecorder
{
    public function record(AgentDisclosure $disclosure): void;
}
