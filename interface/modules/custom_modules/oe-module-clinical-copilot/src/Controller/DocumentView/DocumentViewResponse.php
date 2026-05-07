<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView;

/**
 * Typed result object for `DocumentViewResponder::respond(...)`.
 *
 * The session-side `public/document_view.php` shim emits this — sets
 * `http_response_code($statusCode)`, writes `Content-Type: $contentType`,
 * echoes `$body`. Errors carry a stable string code in `$body` (a
 * JSON-encoded `{error: <code>}` envelope) and an empty `$contentType`
 * is treated as `application/json`.
 *
 * Why a typed object: the endpoint's response path used to be inline
 * `header()` + `echo` calls, which was hard to PHPUnit. Returning a
 * pure value object makes the responder a unit-testable application
 * service — see `tests/Tests/Isolated/Modules/ClinicalCopilot/Controller/DocumentView/`.
 */
final readonly class DocumentViewResponse
{
    public function __construct(
        public int $statusCode,
        public string $contentType,
        public string $body,
        public ?string $errorCode = null,
    ) {
    }

    public static function ok(string $contentType, string $body): self
    {
        return new self(200, $contentType, $body);
    }

    public static function error(int $statusCode, string $errorCode): self
    {
        $body = (string) json_encode(['error' => $errorCode]);
        return new self($statusCode, 'application/json', $body, $errorCode);
    }
}
