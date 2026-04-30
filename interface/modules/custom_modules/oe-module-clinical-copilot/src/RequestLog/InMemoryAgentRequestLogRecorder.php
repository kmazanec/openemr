<?php

/**
 * Test double for {@see AgentRequestLogRecorder} that retains rows in memory.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

final class InMemoryAgentRequestLogRecorder implements AgentRequestLogRecorder
{
    /** @var list<AgentDisclosure> */
    private array $rows = [];

    public function record(AgentDisclosure $disclosure): void
    {
        $this->rows[] = $disclosure;
    }

    /**
     * @return list<AgentDisclosure>
     */
    public function all(): array
    {
        return $this->rows;
    }
}
