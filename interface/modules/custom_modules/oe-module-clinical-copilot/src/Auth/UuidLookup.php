<?php

/**
 * Seam for resolving an authUserID to its `users.uuid`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * Indirection that lets isolated tests stub the DB read without standing up
 * OpenEMR's autoloader and connection. Production wiring uses
 * `SqlUuidLookup`.
 */
interface UuidLookup
{
    /** @return string|null bare uuid string, or null when no row exists */
    public function uuidForUserId(int $userId): ?string;
}
