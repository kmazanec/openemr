<?php

/**
 * F.4b — integration-shaped test for {@see ImagickTiffDecoder}.
 *
 * Drives the production decoder against a real TIFF fixture from the
 * agent eval suite (`agent/evals/fixtures/document-extraction/source/tiffs/`)
 * and asserts:
 *
 *   - the decoded payload starts with the PNG magic header (`\x89PNG`),
 *   - the decoded PNG's pixel dimensions match the source TIFF's
 *     pixel dimensions (so a recorded bbox in source-pixel space maps
 *     onto the decoded PNG without rescale — pinning the F.4b plan's
 *     bbox-coordinate-verification checkbox).
 *
 * Skipped when `ext-imagick` is not loaded so the isolated suite stays
 * portable across CI machines that may or may not have ImageMagick.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Controller\DocumentView;

use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\ImagickTiffDecoder;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\TiffDecodeException;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/TiffDecoder.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/TiffDecodeException.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/ImagickTiffDecoder.php';

#[Group('isolated')]
final class ImagickTiffDecoderTest extends TestCase
{
    private const TIFF_FIXTURE = __DIR__
        . '/../../../../../../../agent/evals/fixtures/document-extraction/source/tiffs/p01-chen-fax-packet.tiff';

    protected function setUp(): void
    {
        if (!extension_loaded('imagick')) {
            self::markTestSkipped('ext-imagick is required for ImagickTiffDecoder integration coverage');
        }
        // ImageMagick is sometimes compiled without the TIFF delegate
        // (CI's php-isolated image is one example: ext-imagick loads
        // but `BlobToImage/481` fails with "no decode delegate for
        // this image format TIFF"). Skip gracefully when the delegate
        // is unavailable so the isolated suite stays portable.
        // Production runs on an image that includes the TIFF delegate.
        if (!in_array('TIFF', \Imagick::queryFormats('TIFF'), strict: true)) {
            self::markTestSkipped(
                'ImageMagick on this host has no TIFF decode delegate; '
                . 'install ImageMagick with libtiff support to exercise this test',
            );
        }
        if (!is_readable(self::TIFF_FIXTURE)) {
            self::markTestSkipped('TIFF fixture is not readable on this host');
        }
    }

    #[Test]
    public function decodesAGenuineTiffFixtureToPngBytesWithMatchingPixelDimensions(): void
    {
        $tiffBytes = file_get_contents(self::TIFF_FIXTURE);
        self::assertIsString($tiffBytes);
        self::assertNotEmpty($tiffBytes);

        $sourceProbe = new \Imagick();
        $sourceProbe->readImageBlob($tiffBytes);
        $sourceWidth = $sourceProbe->getImageWidth();
        $sourceHeight = $sourceProbe->getImageHeight();
        $sourceProbe->clear();

        $decoder = new ImagickTiffDecoder();
        $png = $decoder->decodeToPng($tiffBytes);

        self::assertNotEmpty($png);
        self::assertStringStartsWith("\x89PNG\r\n\x1a\n", $png, 'decoded payload must start with PNG magic header');

        $pngProbe = new \Imagick();
        $pngProbe->readImageBlob($png);
        try {
            self::assertSame('PNG', strtoupper($pngProbe->getImageFormat()));
            // Bbox coordinate verification: the pixel space the vision
            // pipeline recorded (TIFF's native dimensions) must equal
            // the pixel space we now serve to the panel (decoded PNG).
            // A future ImageMagick policy change that downsamples or
            // upscales TIFF inputs would silently break the bbox-overlay
            // alignment in the side-by-side viewer; this assertion
            // catches it before clinicians see misaligned overlays.
            self::assertSame($sourceWidth, $pngProbe->getImageWidth());
            self::assertSame($sourceHeight, $pngProbe->getImageHeight());
        } finally {
            $pngProbe->clear();
        }
    }

    #[Test]
    public function decoderThrowsTiffDecodeExceptionOnMalformedBytes(): void
    {
        $decoder = new ImagickTiffDecoder();

        $this->expectException(TiffDecodeException::class);
        $decoder->decodeToPng('not a real tiff');
    }
}
