<?php

/**
 * Result of resolving a session user to their fhirUser identity.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

final readonly class ResolvedFhirUser
{
    public function __construct(
        /** Bare `users.uuid` string — becomes the JWT's `sub` claim. */
        public string $uuid,
        /** SMART `fhirUser` URI (`{baseUrl}/Practitioner/{uuid}`). */
        public string $fhirUserUri,
    ) {
    }
}
