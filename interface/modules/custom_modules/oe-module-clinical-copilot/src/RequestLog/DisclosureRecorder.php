<?php

/**
 * Records an {@see AgentDisclosure} to the regulatory disclosure log.
 *
 * Distinct from {@see AgentRequestLogRecorder}, which writes the per-request
 * engineering row. Implementations of this interface are responsible for the
 * patient-facing HIPAA Accounting of Disclosures (§164.528) trail —
 * production wires this to OpenEMR's `extended_log` via
 * {@see ExtendedLogDisclosureRecorder}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

interface DisclosureRecorder
{
    public function record(AgentDisclosure $disclosure): void;
}
