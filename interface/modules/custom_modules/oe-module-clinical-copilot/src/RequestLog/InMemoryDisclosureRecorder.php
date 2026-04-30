<?php

/**
 * Test double for {@see DisclosureRecorder} that retains rows in memory and
 * applies the same per-(actor, patient, day) dedup as the production
 * {@see ExtendedLogDisclosureRecorder} so listener tests can verify the
 * regulatory contract end-to-end.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

final class InMemoryDisclosureRecorder implements DisclosureRecorder
{
    /** @var list<AgentDisclosure> */
    private array $rows = [];

    /** @var array<string, true> */
    private array $seen = [];

    public function record(AgentDisclosure $disclosure): void
    {
        $key = self::dedupKey($disclosure);
        if (isset($this->seen[$key])) {
            return;
        }
        $this->seen[$key] = true;
        $this->rows[] = $disclosure;
    }

    /**
     * @return list<AgentDisclosure>
     */
    public function all(): array
    {
        return $this->rows;
    }

    private static function dedupKey(AgentDisclosure $d): string
    {
        return $d->actorUserId . '|' . $d->patientPid . '|' . $d->disclosedAt->format('Y-m-d');
    }
}
