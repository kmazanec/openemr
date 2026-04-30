<?php

/**
 * Symfony event published before chart data leaves OpenEMR for the agent service.
 *
 * One listener subscribes by default ({@see AgentDisclosureListener}) and
 * dispatches the event to two recorders:
 *
 *   - The regulatory recorder writes one row per (user, patient, day) into
 *     OpenEMR's `extended_log` so the disclosure surfaces in the patient's
 *     HIPAA Accounting of Disclosures (§164.528). The TPO classification
 *     and supporting analysis is documented in the module's help panel.
 *   - The engineering recorder writes a per-request row into
 *     `agent_request_log` via {@see DbalAgentRequestLogRecorder} for cost
 *     analysis, eval reproducibility, and forensic debugging.
 *
 * The event itself carries no PHI body content — only the
 * {@see AgentDisclosure} fact-of-disclosure.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

use Symfony\Contracts\EventDispatcher\Event;

final class AgentDisclosedEvent extends Event
{
    public const EVENT_HANDLE = 'agent.phi.disclosed';

    public function __construct(private readonly AgentDisclosure $disclosure)
    {
    }

    public function getDisclosure(): AgentDisclosure
    {
        return $this->disclosure;
    }
}
