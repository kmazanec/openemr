<?php

/**
 * Cross-language contract test for the unified W2 `SourceReference`
 * shape. Reads the committed fixture at
 * `agent/tests/fixtures/contract/sourceReference.json` (the same
 * file the agent's Vitest contract test reads) and asserts every
 * example decodes through `SourceReference::fromArray`, round-trips
 * back through `toArray`, and matches the original decoded JSON
 * structurally.
 *
 * The fixture must contain at least one example of each
 * `source_type` (`chart`, `extracted_document`, `guideline`) so the
 * polymorphic locator rule is exercised on both sides. Bad locator
 * combinations and missing required fields have their own dedicated
 * cases.
 *
 * If this test fails, either the PHP `SourceReference` class drifted
 * from `W2_ARCHITECTURE.md` §"Unified `SourceReference` shape", or
 * the fixture itself is malformed. Update both the PHP class and
 * the TS Zod schema together.
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

final class SourceReferenceContractTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    private const FIXTURE_PATH = __DIR__
        . '/../../../../../../agent/tests/fixtures/contract/sourceReference.json';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
    }

    /**
     * @return array{schema_version: string, examples: list<array<string, mixed>>}
     */
    private static function loadFixture(): array
    {
        $raw = file_get_contents(self::FIXTURE_PATH);
        self::assertNotFalse($raw, 'Fixture must be readable at ' . self::FIXTURE_PATH);
        $decoded = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);
        self::assertArrayHasKey('schema_version', $decoded);
        self::assertArrayHasKey('examples', $decoded);
        self::assertIsString($decoded['schema_version']);
        self::assertIsArray($decoded['examples']);
        /** @var array{schema_version: string, examples: list<array<string, mixed>>} $decoded */
        return $decoded;
    }

    public function testFixtureCoversEverySourceType(): void
    {
        $fixture = self::loadFixture();
        $sourceTypes = [];
        foreach ($fixture['examples'] as $example) {
            self::assertArrayHasKey('source_type', $example);
            self::assertIsString($example['source_type']);
            $sourceTypes[] = $example['source_type'];
        }
        $this->assertEqualsCanonicalizing(
            ['chart', 'extracted_document', 'guideline'],
            array_values(array_unique($sourceTypes)),
            'Contract fixture must cover every source_type so polymorphism is exercised both sides.',
        );
    }

    public function testEveryExampleRoundTrips(): void
    {
        $fixture = self::loadFixture();
        foreach ($fixture['examples'] as $i => $example) {
            $sourceType = $example['source_type'] ?? '<missing>';
            self::assertIsString($sourceType);
            $reference = SourceReference::fromArray($example);
            $reEncoded = $reference->toArray();
            // Compare decoded structures, not formatted JSON bytes —
            // matches `feedback_compare_decoded_not_formatted` so the
            // assertion is robust to JSON pretty-print differences.
            $this->assertEquals(
                $example,
                $reEncoded,
                "SourceReference example {$i} (source_type='{$sourceType}') must round-trip through fromArray->toArray.",
            );
        }
    }

    public function testChartReferenceRequiresField(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'chart',
            sourceId: 'Observation/abc',
            locator: [],
            quote: '7.4 %',
        );
    }

    public function testExtractedDocumentRequiresPageAndBbox(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'extracted_document',
            sourceId: 'artifact-1',
            locator: ['field' => 'results[0].value'],
            quote: 'HbA1c 7.6 %',
        );
    }

    public function testExtractedDocumentRejectsMalformedBbox(): void
    {
        $this->expectException(\DomainException::class);
        // Use fromArray() so PHPStan's compile-time bbox shape check
        // does not block this intentionally-malformed input. The
        // constructor's runtime check is what we want to exercise.
        SourceReference::fromArray([
            'source_type' => 'extracted_document',
            'source_id' => 'artifact-2',
            'locator' => ['page' => 1, 'bbox' => [1.0, 2.0, 3.0]],
            'quote' => 'q',
        ]);
    }

    public function testGuidelineRequiresSection(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'guideline',
            sourceId: 'uspstf-chunk-1',
            locator: [],
            quote: 'Recommendation text',
        );
    }

    public function testRejectsUnknownSourceType(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            // @phpstan-ignore argument.type
            sourceType: 'lab_pdf',
            sourceId: 'rec-1',
            locator: ['field' => 'medication.name'],
            quote: 'metformin',
        );
    }

    public function testRejectsEmptySourceId(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'chart',
            sourceId: '',
            locator: ['field' => 'medication.name'],
            quote: 'metformin',
        );
    }

    public function testRejectsEmptyQuote(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'chart',
            sourceId: 'rec-1',
            locator: ['field' => 'medication.name'],
            quote: '',
        );
    }

    public function testRejectsConfidenceOutOfRange(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(
            sourceType: 'extracted_document',
            sourceId: 'artifact-3',
            locator: ['page' => 1, 'bbox' => [1.0, 2.0, 3.0, 4.0]],
            quote: 'value',
            confidence: 1.4,
        );
    }

    public function testToArrayOmitsEmptyMetaAndAbsentConfidence(): void
    {
        $reference = new SourceReference(
            sourceType: 'chart',
            sourceId: 'Observation/abc',
            locator: ['field' => 'observation.value'],
            quote: '120/80',
        );
        $array = $reference->toArray();
        $this->assertArrayNotHasKey('confidence', $array);
        $this->assertArrayNotHasKey('meta', $array);
    }
}
