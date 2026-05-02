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

use RuntimeException;

/**
 * Thrown by {@see BriefingHttpClient::postBriefing()} when the agent
 * returns a non-2xx, drops the connection, or terminates with an
 * `error` SSE event. Carries the upstream HTTP status (or 0 when no
 * response was received) and a short error code for log filtering.
 */
final class BriefingHttpException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status,
        public readonly string $errorCode,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}
