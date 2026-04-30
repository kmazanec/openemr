<?php

/**
 * Production UuidLookup backed by OpenEMR's `users` table.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;

/**
 * Triggers `UuidRegistry::createMissingUuidForRow` so freshly-imported
 * staff (who may not yet have a uuid) get one minted on first agent
 * request. The same pattern is used in `AuthorizationController::getUserUuid`.
 */
final class SqlUuidLookup implements UuidLookup
{
    public function uuidForUserId(int $userId): ?string
    {
        UuidRegistry::createMissingUuidForRow('users', 'id', $userId);
        $row = QueryUtils::querySingleRow('SELECT `uuid` FROM `users` WHERE `id` = ?', [$userId]);
        if ($row === false) {
            return null;
        }
        $uuidBinary = $row['uuid'] ?? null;
        if (!is_string($uuidBinary) || $uuidBinary === '') {
            return null;
        }
        $uuidString = UuidRegistry::uuidToString($uuidBinary);
        return $uuidString === '' ? null : $uuidString;
    }
}
