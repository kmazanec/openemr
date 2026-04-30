<?php

/**
 * Production JtiGenerator that emits 16 random hex bytes.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

final class RandomJtiGenerator implements JtiGenerator
{
    public function generate(): string
    {
        return bin2hex(random_bytes(16));
    }
}
