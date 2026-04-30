<?php

/**
 * Immutable description of a single PHI disclosure from OpenEMR to the agent service.
 *
 * Pinned shape: actor (user id + SMART URI), site, patient (pid + uuid),
 * conversation, request (action + jti), data categories disclosed, destination
 * (agent client identifier), and the moment of disclosure. By construction the
 * record carries no prompt or completion content — the disclosure is the *fact
 * that data left*, not the data itself.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

use DateTimeImmutable;
use DomainException;

final readonly class AgentDisclosure
{
    /** @var list<string> */
    public array $categories;

    /**
     * @param list<string> $categories Data-category values disclosed in this request.
     *                                 Re-sorted alphabetically at construction so two
     *                                 requests with the same shape produce identical rows.
     */
    public function __construct(
        public DateTimeImmutable $disclosedAt,
        public int $actorUserId,
        public string $actorFhirUser,
        public string $siteId,
        public int $patientPid,
        public ?string $patientUuid,
        public ?string $conversationId,
        public string $action,
        public string $requestId,
        array $categories,
        public string $destination,
    ) {
        if ($action === '') {
            throw new DomainException('AgentDisclosure requires a non-empty action');
        }
        if ($requestId === '') {
            throw new DomainException('AgentDisclosure requires a non-empty requestId');
        }
        if ($actorFhirUser === '') {
            throw new DomainException('AgentDisclosure requires a non-empty actorFhirUser');
        }
        if ($siteId === '') {
            throw new DomainException('AgentDisclosure requires a non-empty siteId');
        }
        if ($destination === '') {
            throw new DomainException('AgentDisclosure requires a non-empty destination');
        }

        $sorted = $categories;
        sort($sorted);
        $this->categories = $sorted;
    }
}
