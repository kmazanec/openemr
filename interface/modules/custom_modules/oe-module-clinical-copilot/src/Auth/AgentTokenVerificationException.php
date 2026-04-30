<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * Thrown when an agent-callback JWT fails verification.
 *
 * The message is intentionally low-detail. Callers translate this to a
 * 401 with an opaque error code; specific reject reasons are logged
 * server-side, never returned in the response.
 */
final class AgentTokenVerificationException extends \RuntimeException
{
}
