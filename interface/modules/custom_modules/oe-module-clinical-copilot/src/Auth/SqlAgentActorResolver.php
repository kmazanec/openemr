<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;

/**
 * Production-wired {@see AgentActorResolver}. Queries `users` for the
 * uuid → (id, username) mapping; ACL check goes through OpenEMR's
 * GACL ({@see \AclMain::aclCheckCore}).
 */
final readonly class SqlAgentActorResolver implements AgentActorResolver
{
    public function resolve(string $userUuid): ?ResolvedAgentActor
    {
        $row = QueryUtils::querySingleRow(
            'SELECT id, username FROM users WHERE uuid = ? LIMIT 1',
            [UuidRegistry::uuidToBytes($userUuid)],
        );
        if ($row === false) {
            return null;
        }
        $id = $row['id'] ?? null;
        $username = $row['username'] ?? null;
        if (!is_numeric($id) || !is_string($username) || $username === '') {
            return null;
        }
        return new ResolvedAgentActor(
            userId: (int) $id,
            username: $username,
            uuid: $userUuid,
        );
    }

    public function mayReadPatients(ResolvedAgentActor $actor): bool
    {
        return AclMain::aclCheckCore('patients', 'demo', $actor->username) === true;
    }
}
