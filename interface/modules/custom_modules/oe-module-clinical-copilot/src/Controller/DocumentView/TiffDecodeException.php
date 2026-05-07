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

use RuntimeException;

/**
 * Domain exception for TIFF decode failures. The responder catches
 * this and returns a structured 500 error envelope; an unhandled
 * `\ImagickException` from the production decoder would leak
 * ImageMagick internals into the response body.
 */
final class TiffDecodeException extends RuntimeException
{
}
