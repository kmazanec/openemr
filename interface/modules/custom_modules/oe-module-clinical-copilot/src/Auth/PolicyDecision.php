<?php

/**
 * Result of evaluating an Agent proxy request against PolicyGate.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

final readonly class PolicyDecision
{
    private function __construct(
        public bool $allowed,
        public ?PolicyDenyReason $reason,
        public ?string $detail,
    ) {
    }

    public static function allow(): self
    {
        return new self(true, null, null);
    }

    public static function deny(PolicyDenyReason $reason, string $detail): self
    {
        return new self(false, $reason, $detail);
    }
}
