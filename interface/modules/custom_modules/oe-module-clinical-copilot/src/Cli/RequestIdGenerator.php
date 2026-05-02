<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Cli;

/**
 * Per-slot request identifier seam. Production uses
 * {@see RandomRequestIdGenerator}; tests pass a deterministic
 * implementation so log assertions are stable.
 */
interface RequestIdGenerator
{
    public function generate(): string;
}
