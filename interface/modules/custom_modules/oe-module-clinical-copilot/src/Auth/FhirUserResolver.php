<?php

/**
 * Resolves a session's authUserID to its fhirUser identity.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use OpenEMR\Common\Auth\OpenIDConnect\FhirUserClaim;
use OpenEMR\Common\Auth\UuidUserAccount;

/**
 * Maps `users.id` (the integer in `$_SESSION['authUserID']`) onto the bare
 * `users.uuid` string and the SMART `fhirUser` URI (`Practitioner/{uuid}`).
 *
 * `agent.php` reads `authUserID` from the session — that is the only stable
 * identity OpenEMR puts in the session. The previous attempt to read a
 * non-existent `fhirUserUuid` session key always resolved to null, which
 * caused the minter to fall back to the integer `authUserId` for the JWT's
 * `sub` claim. Downstream code that trusts `sub` to be a Practitioner UUID
 * was therefore trusting a value that had never been validated.
 *
 * This service is the boundary that turns the session integer into the
 * Practitioner UUID + URI exactly once per request, before the minter runs.
 * If resolution fails (no row, missing role, mismatched type) the proxy
 * fails closed — no token is minted and the agent never sees the request.
 */
final readonly class FhirUserResolver
{
    private UuidLookup $lookup;

    public function __construct(?UuidLookup $lookup = null)
    {
        $this->lookup = $lookup ?? new SqlUuidLookup();
    }

    /**
     * @throws FhirUserResolutionException when the user cannot be resolved
     *         to a Practitioner (or system) fhirUser. Patients hitting this
     *         endpoint are also rejected — the agent is staff-only.
     */
    public function resolve(string $authUserId, string $fhirBaseUrl): ResolvedFhirUser
    {
        if ($authUserId === '' || !ctype_digit($authUserId)) {
            throw new FhirUserResolutionException('authUserId is empty or non-numeric');
        }

        $uuid = $this->lookup->uuidForUserId((int) $authUserId);
        if ($uuid === null) {
            throw new FhirUserResolutionException('No users row for authUserId');
        }

        $role = (new UuidUserAccount($uuid))->getUserRole();
        if (
            $role !== UuidUserAccount::USER_ROLE_USERS
            && $role !== UuidUserAccount::USER_ROLE_SYSTEM
        ) {
            // Patients should never reach the agent — they have no proxy
            // entry point — but defense in depth: the agent service mints
            // tokens scoped to the Practitioner FHIR resource set, so a
            // patient identity here would silently grant the wrong scope.
            throw new FhirUserResolutionException('authUserId is not a staff user');
        }

        $claim = new FhirUserClaim();
        $claim->setFhirBaseUrl(rtrim($fhirBaseUrl, '/'));
        $fhirUserUri = $claim->getFhirUser($uuid);

        return new ResolvedFhirUser($uuid, $fhirUserUri);
    }
}
