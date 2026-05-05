<?php

/**
 * Isolated unit tests for the unified W2 `SourceReference` value
 * object. The cross-language contract (one example per
 * `source_type`, fixture round-trip) lives in
 * `SourceReferenceContractTest.php`; this file covers the
 * polymorphism rules and constructor edge cases on the PHP side
 * specifically.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use PHPUnit\Framework\TestCase;

final class SourceReferenceTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
    }

    public function testChartShapeMinimumFields(): void
    {
        $reference = new SourceReference(
            sourceType: 'chart',
            sourceId: 'Observation/lab-a1c-uuid',
            locator: ['field' => 'observation.value'],
            quote: '7.4 %',
        );

        $this->assertSame(
            [
                'source_type' => 'chart',
                'source_id' => 'Observation/lab-a1c-uuid',
                'locator' => ['field' => 'observation.value'],
                'quote' => '7.4 %',
            ],
            $reference->toArray(),
        );
    }

    public function testChartShapeWithMeta(): void
    {
        $reference = new SourceReference(
            sourceType: 'chart',
            sourceId: 'Observation/lab-a1c-uuid',
            locator: ['field' => 'observation.value'],
            quote: '7.4 %',
            meta: ['record_recorded_at' => '2026-04-12'],
        );

        $this->assertSame(
            [
                'source_type' => 'chart',
                'source_id' => 'Observation/lab-a1c-uuid',
                'locator' => ['field' => 'observation.value'],
                'quote' => '7.4 %',
                'meta' => ['record_recorded_at' => '2026-04-12'],
            ],
            $reference->toArray(),
        );
    }

    public function testExtractedDocumentShape(): void
    {
        $reference = new SourceReference(
            sourceType: 'extracted_document',
            sourceId: 'extraction-artifact-1',
            locator: [
                'page' => 2,
                'bbox' => [120.0, 412.0, 340.0, 14.5],
                'field' => 'results[3].value',
            ],
            quote: 'HbA1c 7.6 %',
            confidence: 0.92,
            meta: [
                'document_uuid' => 'doc-1',
                'extractor_version' => 'vlm-2026-04-01',
            ],
        );

        $array = $reference->toArray();
        $this->assertSame('extracted_document', $array['source_type']);
        $this->assertArrayHasKey('confidence', $array);
        $this->assertSame(0.92, $array['confidence']);
        $this->assertArrayHasKey('bbox', $array['locator']);
        $this->assertSame([120.0, 412.0, 340.0, 14.5], $array['locator']['bbox']);
    }

    public function testGuidelineShape(): void
    {
        $reference = new SourceReference(
            sourceType: 'guideline',
            sourceId: 'uspstf-chunk-1',
            locator: ['section' => 'Recommendation Statement'],
            quote: 'The USPSTF recommends...',
            meta: ['rerank_score' => 0.81],
        );

        $array = $reference->toArray();
        $this->assertSame('guideline', $array['source_type']);
        $this->assertArrayHasKey('section', $array['locator']);
        $this->assertSame('Recommendation Statement', $array['locator']['section']);
    }

    public function testJsonEncodableRoundTrip(): void
    {
        $reference = new SourceReference(
            sourceType: 'chart',
            sourceId: 'Observation/abc',
            locator: ['field' => 'observation.value'],
            quote: '120/80',
            meta: ['record_recorded_at' => '2026-01-15'],
        );

        $encoded = json_encode($reference->toArray(), JSON_THROW_ON_ERROR);
        $decoded = json_decode($encoded, true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame($reference->toArray(), $decoded);
    }
}
