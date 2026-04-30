<?php

/**
 * Session-derived context for an Agent proxy request.
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
 * Snapshot of the OpenEMR session fields the Agent proxy cares about.
 *
 * The proxy controller builds one of these from the active OpenEMR session
 * and hands it to PolicyGate. Keeping the value object pure (no superglobals,
 * no DB) is what makes the gate testable without bootstrapping OpenEMR.
 */
final readonly class SessionContext
{
    public function __construct(
        public string $authUserId,
        public string $authUser,
        public string $siteId,
        public ?string $patientPid,
        public ?string $fhirUserUuid,
    ) {
    }
}
