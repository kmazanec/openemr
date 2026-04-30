<?php

/**
 * Clock seam for deterministic minter tests.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use DateTimeImmutable;

/**
 * Production wraps `new DateTimeImmutable()`. Tests pin a known instant
 * so `iat` / `nbf` / `exp` claim values are deterministic.
 *
 * Mirrors the spirit of PSR-20 without dragging the package in for one
 * 3-line interface.
 */
interface ClockInterface
{
    public function now(): DateTimeImmutable;
}
