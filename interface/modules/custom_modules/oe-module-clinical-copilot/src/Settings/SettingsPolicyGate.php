<?php

/**
 * Pure policy gate for session-flow settings writes.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Settings;

use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDecision;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason;

/**
 * Self-only authorisation check for the `morning-prep-settings:write`
 * action.
 *
 * Distinct from {@see \OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate}: that
 * gate runs on agent-token requests (browser → proxy → agent). The settings
 * page is a session-authenticated module page and never goes through the
 * proxy, so the inputs are different — here we just need to verify that the
 * acting practitioner is writing their own settings row.
 *
 * The shape mirrors PolicyGate: pure (no DB, no superglobals), returns a
 * typed Allow / Deny so callers can branch on a real decision rather than a
 * bool.
 */
final readonly class SettingsPolicyGate
{
    public const ACTION_WRITE = 'morning-prep-settings:write';

    public function evaluateWrite(string $actingUuid, string $targetUuid): PolicyDecision
    {
        if ($actingUuid === '') {
            return PolicyDecision::deny(
                PolicyDenyReason::MissingSession,
                'No authenticated practitioner uuid in session',
            );
        }

        if ($actingUuid !== $targetUuid) {
            return PolicyDecision::deny(
                PolicyDenyReason::NotOwnRow,
                'Practitioner may only write their own settings row',
            );
        }

        return PolicyDecision::allow();
    }
}
