<?php

/**
 * Isolated tests for {@see DocumentUploadController} and the SigV4
 * Spaces upload service. The session+ACL gate that fronts the
 * controller in production lives in `public/document_upload.php` and
 * is the boundary owner of those checks; the controller assumes the
 * caller is already authorized and focuses on shape validation, MIME
 * enforcement, and the Spaces hand-off.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Controller;

use DateTimeImmutable;
use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentUploadController;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentUuidGenerator;
use OpenEMR\Modules\ClinicalCopilot\Service\GeneratedDocumentUuid;
use OpenEMR\Modules\ClinicalCopilot\Service\LocalDocumentStore;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\SigV4SpacesUploadService;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesConfig;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesUploadService;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\RequestInterface;
use Psr\Log\NullLogger;
use Symfony\Component\EventDispatcher\EventDispatcher;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentUuidGenerator.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/SpacesUploadService.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/SpacesConfig.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/LocalDocumentStore.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentReferenceWriteService.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Events/DocumentReferenceCreatedEvent.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/Production/SigV4SpacesUploadService.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentUploadController.php';

#[Group('isolated')]
final class DocumentUploadControllerTest extends TestCase
{
    public const FIXED_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    public const FIXED_NOW = '2026-05-05T12:00:00+00:00';

    public function testHappyPathReturnsUuidAndDocTypeGuess(): void
    {
        $upload = new InMemorySpacesUploadService();
        $localStore = new InMemoryLocalDocumentStore();
        $writer = new RecordingDocumentTableWriter();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            localStore: $localStore,
            tableWriter: $writer,
            pid: 4242,
            originalFilename: 'cdc-cbc-2026-05-01.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(self::FIXED_UUID, $body['document_uuid']);
        $this->assertSame(DocumentUploadController::DOC_TYPE_LAB_PDF, $body['doc_type_guess']);
        $this->assertSame('s3://test-bucket/4242/' . self::FIXED_UUID . '.pdf', $body['spaces_url']);
        // canonical_ext is what the panel forwards to extract.php → the
        // agent's /v1/agent/extract route validates it and threads it
        // into the rasterize/persist nodes' Spaces key resolution.
        $this->assertSame('pdf', $body['canonical_ext']);
        $this->assertCount(1, $upload->uploads);
        $this->assertSame(4242, $upload->uploads[0]['pid']);
        $this->assertSame(self::FIXED_UUID, $upload->uploads[0]['documentUuid']);
        $this->assertSame('pdf', $upload->uploads[0]['extension']);
        $this->assertSame('application/pdf', $upload->uploads[0]['contentType']);

        // Local-disk persistence path: bytes mirrored to disk + row
        // pre-written so the legacy Documents-tab viewer can render it.
        $this->assertCount(1, $localStore->stored);
        $this->assertSame(4242, $localStore->stored[0]['pid']);
        $this->assertSame('cdc-cbc-2026-05-01.pdf', $localStore->stored[0]['filename']);
        $this->assertCount(1, $writer->insertedRows);
        $row = $writer->insertedRows[0];
        $this->assertSame(4242, $row['pid']);
        $this->assertStringStartsWith('file://', $row['url']);
        $this->assertStringContainsString('cdc-cbc-2026-05-01.pdf', $row['url']);
        $this->assertSame('cdc-cbc-2026-05-01.pdf', $row['filename']);
        $this->assertSame('application/pdf', $row['mimeType']);
        $this->assertNotSame('', $row['hash']);
        $this->assertGreaterThan(0, $row['size']);
    }

    public function testIntakeFormGuessFromFilename(): void
    {
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'patient-intake-form.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(DocumentUploadController::DOC_TYPE_INTAKE_FORM, $body['doc_type_guess']);
    }

    public function testRejectsMissingPid(): void
    {
        [$status, $body] = $this->dispatch(
            uploadService: new InMemorySpacesUploadService(),
            pid: null,
            originalFilename: 'x.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_pid'], $body);
    }

    public function testRejectsMissingFile(): void
    {
        [$status, $body] = $this->dispatch(
            uploadService: new InMemorySpacesUploadService(),
            pid: 4242,
            originalFilename: 'x.pdf',
            detectedMime: 'application/pdf',
            bytes: '',
        );

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_file'], $body);
    }

    public function testRejectsFileLargerThanCap(): void
    {
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'huge.pdf',
            detectedMime: 'application/pdf',
            // One byte over the 10 MB cap.
            bytes: str_repeat('A', DocumentUploadController::MAX_BYTES + 1),
        );

        $this->assertSame(413, $status);
        $this->assertSame(['error' => 'file_too_large'], $body);
        $this->assertCount(0, $upload->uploads);
    }

    public function testRejectsUnsupportedMime(): void
    {
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'malicious.exe',
            detectedMime: 'application/x-msdownload',
            bytes: 'MZ' . str_repeat("\0", 100),
        );

        $this->assertSame(415, $status);
        $this->assertSame(['error' => 'unsupported_media_type'], $body);
        $this->assertCount(0, $upload->uploads);
    }

    public function testRejectsWhenSniffMissing(): void
    {
        // Caller couldn't sniff the bytes (finfo failed) — refuse rather
        // than trusting the client-supplied MIME. The controller's
        // contract is that the caller has already content-sniffed; null
        // means "we couldn't detect" not "no content type was sent".
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'x.pdf',
            detectedMime: null,
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(415, $status);
        $this->assertSame(['error' => 'unsupported_media_type'], $body);
    }

    public function testReturns503OnUploadFailure(): void
    {
        $upload = new InMemorySpacesUploadService(failOnUpload: true);
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'cdc-a1c.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'upload_unavailable'], $body);
    }

    public function testReturns503WhenLocalDiskWriteFails(): void
    {
        // Spaces succeeded, but the local-disk mirror failed. The
        // user's chart row is missing, so we must fail the request
        // rather than let the panel attach a phantom upload.
        $upload = new InMemorySpacesUploadService();
        $localStore = new InMemoryLocalDocumentStore(failOnStore: true);
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            localStore: $localStore,
            pid: 4242,
            originalFilename: 'cdc-cbc.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'persist_unavailable'], $body);
        // Spaces was attempted (and succeeded) before we discovered the
        // local-disk failure; orphan is tolerable per the
        // architecture decision.
        $this->assertCount(1, $upload->uploads);
    }

    public function testReturns503WhenRowInsertFails(): void
    {
        $upload = new InMemorySpacesUploadService();
        $writer = new RecordingDocumentTableWriter(failOnInsert: true);
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            tableWriter: $writer,
            pid: 4242,
            originalFilename: 'cdc-cbc.pdf',
            detectedMime: 'application/pdf',
            bytes: $this->fakePdfBytes(),
        );

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'persist_unavailable'], $body);
    }

    public function testJpegMimeMapsToJpgExtension(): void
    {
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'intake-photo.jpeg',
            detectedMime: 'image/jpeg',
            bytes: "\xff\xd8\xff" . str_repeat('A', 100),
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame('s3://test-bucket/4242/' . self::FIXED_UUID . '.jpg', $body['spaces_url']);
        $this->assertSame('jpg', $body['canonical_ext']);
        $this->assertSame('jpg', $upload->uploads[0]['extension']);
    }

    public function testTiffAccepted(): void
    {
        $upload = new InMemorySpacesUploadService();
        [$status, $body] = $this->dispatch(
            uploadService: $upload,
            pid: 4242,
            originalFilename: 'fax-page-1.tiff',
            detectedMime: 'image/tiff',
            bytes: 'II*' . str_repeat('A', 100),
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame('tiff', $body['canonical_ext']);
        $this->assertSame('tiff', $upload->uploads[0]['extension']);
    }

    // -------------------------------------------------------------------
    // SigV4SpacesUploadService — production implementation
    // -------------------------------------------------------------------

    public function testSigV4ServiceUploadsBytesAndReturnsCanonicalUrl(): void
    {
        /** @var list<RequestInterface> $captured */
        $captured = [];
        $mock = new MockHandler([new Response(200)]);
        $stack = HandlerStack::create($mock);
        $stack->push(static function (callable $handler) use (&$captured): callable {
            return static function (RequestInterface $request, array $options) use ($handler, &$captured) {
                $captured[] = $request;
                return $handler($request, $options);
            };
        });
        $client = new Client(['handler' => $stack]);

        $service = new SigV4SpacesUploadService(
            config: new SpacesConfig(
                bucket: 'test-bucket',
                region: 'nyc3',
                endpoint: 'https://nyc3.digitaloceanspaces.com',
                accessKey: 'TEST-KEY',
                secretKey: 'TEST-SECRET-1234567890',
            ),
            httpClient: $client,
            clock: new FixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            logger: new NullLogger(),
        );

        $url = $service->upload(
            pid: 4242,
            documentUuid: self::FIXED_UUID,
            extension: 'pdf',
            bytes: 'pdf-bytes-here',
            contentType: 'application/pdf',
        );

        $this->assertSame('s3://test-bucket/4242/' . self::FIXED_UUID . '.pdf', $url);
        $this->assertCount(1, $captured);
        $req = $captured[0];
        $this->assertSame('PUT', $req->getMethod());
        $this->assertSame(
            'https://nyc3.digitaloceanspaces.com/test-bucket/4242/' . self::FIXED_UUID . '.pdf',
            (string) $req->getUri(),
        );
        $this->assertSame('application/pdf', $req->getHeaderLine('Content-Type'));
        $this->assertNotSame('', $req->getHeaderLine('Authorization'));
        $this->assertStringStartsWith('AWS4-HMAC-SHA256 Credential=TEST-KEY/', $req->getHeaderLine('Authorization'));
        $this->assertSame('20260505T120000Z', $req->getHeaderLine('X-Amz-Date'));
        $this->assertSame(hash('sha256', 'pdf-bytes-here'), $req->getHeaderLine('X-Amz-Content-Sha256'));
        $this->assertSame('pdf-bytes-here', (string) $req->getBody());
    }

    public function testSigV4ServiceWrapsNon2xxAsRuntimeException(): void
    {
        $mock = new MockHandler([new Response(403, [], '<Error><Code>SignatureDoesNotMatch</Code></Error>')]);
        $stack = HandlerStack::create($mock);
        $client = new Client(['handler' => $stack]);

        $service = new SigV4SpacesUploadService(
            config: new SpacesConfig(
                bucket: 'test-bucket',
                region: 'nyc3',
                endpoint: 'https://nyc3.digitaloceanspaces.com',
                accessKey: 'TEST-KEY',
                secretKey: 'TEST-SECRET-1234567890',
            ),
            httpClient: $client,
            clock: new FixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            logger: new NullLogger(),
        );

        $this->expectException(\RuntimeException::class);
        $service->upload(
            pid: 4242,
            documentUuid: self::FIXED_UUID,
            extension: 'pdf',
            bytes: 'bytes',
            contentType: 'application/pdf',
        );
    }

    public function testSigV4ServiceRejectsZeroBytes(): void
    {
        $service = new SigV4SpacesUploadService(
            config: new SpacesConfig(
                bucket: 'test-bucket',
                region: 'nyc3',
                endpoint: 'https://nyc3.digitaloceanspaces.com',
                accessKey: 'TEST-KEY',
                secretKey: 'TEST-SECRET-1234567890',
            ),
            httpClient: new Client(),
            clock: new FixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            logger: new NullLogger(),
        );

        $this->expectException(\DomainException::class);
        $service->upload(
            pid: 4242,
            documentUuid: self::FIXED_UUID,
            extension: 'pdf',
            bytes: '',
            contentType: 'application/pdf',
        );
    }

    // -------------------------------------------------------------------
    // SpacesConfig::fromEnv
    // -------------------------------------------------------------------

    public function testSpacesConfigFromEnvComputesEndpointFromRegion(): void
    {
        $config = SpacesConfig::fromEnv([
            'SPACES_BUCKET' => 'cdn.biograph.dev',
            'SPACES_REGION' => 'nyc3',
            'SPACES_OPENEMR_KEY' => 'KEY',
            'SPACES_OPENEMR_SECRET' => 'SECRET',
        ]);

        $this->assertSame('cdn.biograph.dev', $config->bucket);
        $this->assertSame('nyc3', $config->region);
        $this->assertSame('https://nyc3.digitaloceanspaces.com', $config->endpoint);
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function missingEnvVarProvider(): array
    {
        return [
            'bucket' => ['SPACES_BUCKET'],
            'region' => ['SPACES_REGION'],
            'key' => ['SPACES_OPENEMR_KEY'],
            'secret' => ['SPACES_OPENEMR_SECRET'],
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('missingEnvVarProvider')]
    public function testSpacesConfigFromEnvFailsClosedOnMissingVar(string $missing): void
    {
        $env = [
            'SPACES_BUCKET' => 'cdn.biograph.dev',
            'SPACES_REGION' => 'nyc3',
            'SPACES_OPENEMR_KEY' => 'KEY',
            'SPACES_OPENEMR_SECRET' => 'SECRET',
        ];
        unset($env[$missing]);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/' . preg_quote($missing, '/') . '/');
        SpacesConfig::fromEnv($env);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /**
     * @return array{0: int, 1: ?array<string, mixed>}
     */
    private function dispatch(
        SpacesUploadService $uploadService,
        ?int $pid,
        ?string $originalFilename,
        ?string $detectedMime,
        ?string $bytes,
        ?LocalDocumentStore $localStore = null,
        ?DocumentTableWriter $tableWriter = null,
    ): array {
        $localStore ??= new InMemoryLocalDocumentStore();
        $tableWriter ??= new RecordingDocumentTableWriter();
        $writeService = new DocumentReferenceWriteService(
            tableWriter: $tableWriter,
            uuidGenerator: new FixedDocumentUploadUuid(self::FIXED_UUID),
            eventDispatcher: new EventDispatcher(),
            clock: new FixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            logger: new NullLogger(),
        );
        $controller = new DocumentUploadController(
            uploadService: $uploadService,
            localStore: $localStore,
            writeService: $writeService,
            uuidGenerator: new FixedDocumentUploadUuid(self::FIXED_UUID),
            logger: new NullLogger(),
        );

        ob_start();
        try {
            $controller->handle(
                pid: $pid,
                originalFilename: $originalFilename,
                detectedMime: $detectedMime,
                bytes: $bytes === '' ? null : $bytes,
            );
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status);

        $decoded = null;
        if (is_string($output) && $output !== '') {
            $raw = json_decode($output, true);
            $this->assertIsArray($raw);
            $stringKeyed = [];
            foreach ($raw as $key => $value) {
                $this->assertIsString($key);
                $stringKeyed[$key] = $value;
            }
            $decoded = $stringKeyed;
        }

        return [$status, $decoded];
    }

    private function fakePdfBytes(): string
    {
        return "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n" . str_repeat('A', 256);
    }
}

final class InMemorySpacesUploadService implements SpacesUploadService
{
    /** @var list<array{pid: int, documentUuid: string, extension: string, contentType: string, bytes: string}> */
    public array $uploads = [];

    public function __construct(private readonly bool $failOnUpload = false)
    {
    }

    public function upload(
        int $pid,
        string $documentUuid,
        string $extension,
        string $bytes,
        string $contentType,
    ): string {
        if ($this->failOnUpload) {
            throw new \RuntimeException('simulated Spaces failure');
        }
        $this->uploads[] = [
            'pid' => $pid,
            'documentUuid' => $documentUuid,
            'extension' => $extension,
            'contentType' => $contentType,
            'bytes' => $bytes,
        ];
        return "s3://test-bucket/{$pid}/{$documentUuid}.{$extension}";
    }
}

final readonly class FixedDocumentUploadUuid implements DocumentUuidGenerator
{
    public function __construct(private string $canonical)
    {
    }

    public function generate(): GeneratedDocumentUuid
    {
        return new GeneratedDocumentUuid(
            canonical: $this->canonical,
            binary: hex2bin(str_replace('-', '', $this->canonical)) ?: '',
        );
    }

    public function fromCanonical(string $canonical): GeneratedDocumentUuid
    {
        return new GeneratedDocumentUuid(
            canonical: $canonical,
            binary: hex2bin(str_replace('-', '', $canonical)) ?: '',
        );
    }
}

final readonly class FixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final class InMemoryLocalDocumentStore implements LocalDocumentStore
{
    /** @var list<array{pid: int, filename: string, bytes: string, hash: string, size: int}> */
    public array $stored = [];

    public function __construct(private readonly bool $failOnStore = false)
    {
    }

    public function store(int $pid, string $originalFilename, string $bytes): array
    {
        if ($this->failOnStore) {
            throw new \RuntimeException('simulated disk failure');
        }
        $hash = hash('sha3-512', $bytes);
        $size = strlen($bytes);
        $this->stored[] = [
            'pid' => $pid,
            'filename' => $originalFilename,
            'bytes' => $bytes,
            'hash' => $hash,
            'size' => $size,
        ];
        return [
            'filename' => $originalFilename,
            'absolutePath' => '/test/documents/' . $pid . '/' . $originalFilename,
            'hash' => $hash,
            'size' => $size,
        ];
    }
}

final class RecordingDocumentTableWriter implements DocumentTableWriter
{
    /** @var list<array{pid: int, url: string, mimeType: string, filename: string, hash: string, size: int, categoryId: int, uuidBinary: string}> */
    public array $insertedRows = [];

    /** @var array<string, int> doc_type → category id */
    private array $categoryByDocType = [];

    private int $nextCategoryId = 100;
    private int $nextDocumentId = 1;

    public function __construct(private readonly bool $failOnInsert = false)
    {
    }

    public function ensureCategory(string $docType): int
    {
        if (!isset($this->categoryByDocType[$docType])) {
            $this->categoryByDocType[$docType] = $this->nextCategoryId++;
        }
        return $this->categoryByDocType[$docType];
    }

    public function insertDocumentReferenceRow(
        int $pid,
        string $uuidBinary,
        string $url,
        string $mimeType,
        string $filename,
        string $hash,
        int $size,
        \DateTimeImmutable $createdAt,
        int $categoryId,
    ): int {
        if ($this->failOnInsert) {
            throw new \RuntimeException('simulated DBAL failure');
        }
        $rowId = $this->nextDocumentId++;
        $this->insertedRows[] = [
            'pid' => $pid,
            'url' => $url,
            'mimeType' => $mimeType,
            'filename' => $filename,
            'hash' => $hash,
            'size' => $size,
            'categoryId' => $categoryId,
            'uuidBinary' => $uuidBinary,
        ];
        return $rowId;
    }

    public function findRowIdByUuid(string $uuidBinary): ?int
    {
        foreach ($this->insertedRows as $idx => $row) {
            if ($row['uuidBinary'] === $uuidBinary) {
                return $idx + 1;
            }
        }
        return null;
    }

    public function findRowByUuid(string $uuidBinary): ?array
    {
        foreach ($this->insertedRows as $idx => $row) {
            if ($row['uuidBinary'] === $uuidBinary) {
                $docType = array_search($row['categoryId'], $this->categoryByDocType, strict: true);
                return [
                    'rowId' => $idx + 1,
                    'pid' => $row['pid'],
                    'docType' => is_string($docType) ? $docType : '',
                ];
            }
        }
        return null;
    }
}
