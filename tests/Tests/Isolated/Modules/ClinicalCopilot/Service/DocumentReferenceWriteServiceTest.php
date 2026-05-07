<?php

/**
 * Isolated tests for {@see DocumentReferenceWriteService} and the
 * Tier-1 endpoint controller. The service uses an in-memory
 * {@see DocumentTableWriter} so the unit boundary stays free of DBAL.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Service;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentReferenceController;
use OpenEMR\Modules\ClinicalCopilot\Events\DocumentReferenceCreatedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentUuidGenerator;
use OpenEMR\Modules\ClinicalCopilot\Service\GeneratedDocumentUuid;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\RequireModuleClasses;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\EventDispatcher\EventDispatcher;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentActorResolver.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentUuidGenerator.php';

final class DocumentReferenceWriteServiceTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-05-05T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-doc-ref';
    public const FIXED_UUID_CANONICAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();

        $auth = self::MODULE_DIR . '/Auth';
        foreach ([
            'AgentTokenMintException.php',
            'AgentTokenVerificationException.php',
            'AgentSigningKey.php',
            'JwksKeyId.php',
            'ClockInterface.php',
            'SystemClock.php',
            'JtiGenerator.php',
            'RandomJtiGenerator.php',
            'ResolvedFhirUser.php',
            'AgentTokenMinter.php',
            'VerifiedAgentToken.php',
            'OpenEmrJwtVerifier.php',
            'ResolvedAgentActor.php',
            'AgentActorResolver.php',
            'AuthorizedAgentRequest.php',
            'AgentEndpointAuth.php',
        ] as $f) {
            require_once $auth . '/' . $f;
        }
        require_once self::MODULE_DIR . '/Events/DocumentReferenceCreatedEvent.php';
        require_once self::MODULE_DIR . '/Service/DocumentUuidGenerator.php';
        require_once self::MODULE_DIR . '/Service/DocumentTableWriter.php';
        require_once self::MODULE_DIR . '/Service/DocumentReferenceWriteService.php';
        require_once self::MODULE_DIR . '/Controller/DocumentReferenceController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    // ------------------------------------------------------------------
    // Service-level tests
    // ------------------------------------------------------------------

    public function testWritePersistsRowAndDispatchesEvent(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $events = new RecordingEventDispatcher();
        $service = new DocumentReferenceWriteService(
            tableWriter: $writer,
            uuidGenerator: new FixedDocumentUuidGenerator(self::FIXED_UUID_CANONICAL),
            eventDispatcher: $events,
            clock: $this->fixedClock(),
            logger: new NullLogger(),
        );

        $uuid = $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/cdc-a1c-2026-05-01.pdf',
            mimeType: 'application/pdf',
            filename: 'cdc-a1c-2026-05-01.pdf',
            hash: hash('sha3-512', 'pdf-bytes'),
            size: 4242,
        );

        $this->assertSame(self::FIXED_UUID_CANONICAL, $uuid);
        $this->assertCount(1, $writer->insertedRows);
        $row = $writer->insertedRows[0];
        $this->assertSame(4242, $row['pid']);
        $this->assertSame('file:///site/documents/4242/cdc-a1c-2026-05-01.pdf', $row['url']);
        $this->assertSame('application/pdf', $row['mimeType']);
        $this->assertSame('cdc-a1c-2026-05-01.pdf', $row['filename']);

        $this->assertCount(1, $events->dispatched);
        $event = $events->dispatched[0];
        $this->assertInstanceOf(DocumentReferenceCreatedEvent::class, $event);
        $this->assertSame(self::FIXED_UUID_CANONICAL, $event->documentUuid);
        $this->assertSame(4242, $event->pid);
        $this->assertSame(DocumentReferenceWriteService::DOC_TYPE_LAB_PDF, $event->docType);
        $this->assertSame(1, $event->documentRowId);
    }

    public function testWriteEnsuresLeafCategoryPerDocType(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        // Use a sequence generator so each write gets a unique UUID —
        // otherwise the idempotency probe short-circuits the second
        // and third write, defeating the assertion below.
        $service = new DocumentReferenceWriteService(
            tableWriter: $writer,
            uuidGenerator: new SequenceDocumentUuidGenerator([
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef',
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeef0',
            ]),
            eventDispatcher: new EventDispatcher(),
            clock: $this->fixedClock(),
            logger: new NullLogger(),
        );

        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
        );
        $service->write(
            pid: 4243,
            docType: DocumentReferenceWriteService::DOC_TYPE_INTAKE_FORM,
            url: 'file:///site/documents/4243/b.pdf',
            mimeType: 'application/pdf',
            filename: 'b.pdf',
            hash: 'h',
            size: 1,
        );
        $service->write(
            pid: 4244,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4244/c.pdf',
            mimeType: 'application/pdf',
            filename: 'c.pdf',
            hash: 'h',
            size: 1,
        );

        // Two leaf categories — Lab PDF reused on the third write.
        $this->assertSame(['lab_pdf', 'intake_form', 'lab_pdf'], array_map(
            static fn(array $r): string => $r['docType'],
            $writer->insertedRows,
        ));
        $this->assertCount(2, array_unique(array_map(
            static fn(array $r): int => $r['categoryId'],
            $writer->insertedRows,
        )));
    }

    public function testWriteIsIdempotentOnUuid(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $events = new RecordingEventDispatcher();
        $service = new DocumentReferenceWriteService(
            tableWriter: $writer,
            uuidGenerator: new FixedDocumentUuidGenerator(self::FIXED_UUID_CANONICAL),
            eventDispatcher: $events,
            clock: $this->fixedClock(),
            logger: new NullLogger(),
        );

        $uuid1 = $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );
        $uuid2 = $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $this->assertSame(self::FIXED_UUID_CANONICAL, $uuid1);
        $this->assertSame(self::FIXED_UUID_CANONICAL, $uuid2);
        // Second call short-circuits — only one row inserted, only one
        // event dispatched.
        $this->assertCount(1, $writer->insertedRows);
        $this->assertCount(1, $events->dispatched);
    }

    public function testWriteRejectsInvalidPid(): void
    {
        $service = $this->makeService(new InMemoryDocumentTableWriter());
        $this->expectException(\DomainException::class);
        $service->write(
            pid: 0,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            hash: 'h',
            size: 1,
        );
    }

    public function testWriteRejectsUnknownDocType(): void
    {
        $service = $this->makeService(new InMemoryDocumentTableWriter());
        $this->expectException(\DomainException::class);
        $service->write(
            pid: 1,
            docType: 'mystery',
            url: 'file:///x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            hash: 'h',
            size: 1,
        );
    }

    public function testWriteWrapsTableWriterFailureAsRuntimeException(): void
    {
        $writer = new InMemoryDocumentTableWriter(failOnInsert: true);
        $service = $this->makeService($writer);
        $this->expectException(\RuntimeException::class);
        $service->write(
            pid: 1,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            hash: 'h',
            size: 1,
        );
    }

    public function testConfirmExistingHappyPath(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $service = $this->makeService($writer);

        // Pre-write a row with the canonical UUID, simulating the
        // chat-upload controller's pre-write step.
        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $confirmed = $service->confirmExisting(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );
        $this->assertSame(self::FIXED_UUID_CANONICAL, $confirmed);
    }

    public function testConfirmExistingThrowsWhenRowMissing(): void
    {
        $service = $this->makeService(new InMemoryDocumentTableWriter());
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('document_not_pre_written');
        $service->confirmExisting(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );
    }

    public function testConfirmExistingRejectsPidMismatch(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $service = $this->makeService($writer);

        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('pid_mismatch');
        $service->confirmExisting(
            pid: 9999,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );
    }

    public function testConfirmExistingRejectsDocTypeMismatch(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $service = $this->makeService($writer);

        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/a.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('doc_type_mismatch');
        $service->confirmExisting(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_INTAKE_FORM,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );
    }

    // ------------------------------------------------------------------
    // Controller-level tests
    // ------------------------------------------------------------------

    public function testControllerHappyPathConfirmsPreWrittenRow(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $service = $this->makeService($writer);
        // Simulate the chat-upload controller's pre-write.
        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/cdc-a1c.pdf',
            mimeType: 'application/pdf',
            filename: 'cdc-a1c.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body, $disclosures] = $this->dispatchController($token, [
            'pid' => 4242,
            'doc_type' => 'lab_pdf',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ], $service);

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(self::FIXED_UUID_CANONICAL, $body['document_uuid']);
        $this->assertCount(1, $disclosures);
        $this->assertSame('document_reference_write', $disclosures[0]->action);
        $this->assertSame(['document'], $disclosures[0]->categories);
        $this->assertSame(4242, $disclosures[0]->patientPid);
    }

    public function testControllerReturns409WhenRowNotPreWritten(): void
    {
        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, [
            'pid' => 4242,
            'doc_type' => 'lab_pdf',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ]);
        $this->assertSame(409, $status);
        $this->assertSame(['error' => 'document_not_pre_written'], $body);
    }

    public function testControllerRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchController($token, [
            'pid' => 4242,
            'doc_type' => 'lab_pdf',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ]);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testControllerRejectsMissingPid(): void
    {
        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, [
            'doc_type' => 'lab_pdf',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ]);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_pid'], $body);
    }

    public function testControllerRejectsInvalidDocType(): void
    {
        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, [
            'pid' => 4242,
            'doc_type' => 'mystery',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ]);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_doc_type'], $body);
    }

    public function testControllerRejectsMissingDocumentUuid(): void
    {
        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, [
            'pid' => 4242,
            'doc_type' => 'lab_pdf',
        ]);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_document_uuid'], $body);
    }

    public function testControllerRejectsPidMismatch(): void
    {
        $writer = new InMemoryDocumentTableWriter();
        $service = $this->makeService($writer);
        $service->write(
            pid: 4242,
            docType: DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            url: 'file:///site/documents/4242/x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            hash: 'h',
            size: 1,
            documentUuid: self::FIXED_UUID_CANONICAL,
        );

        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, [
            'pid' => 9999,
            'doc_type' => 'lab_pdf',
            'document_uuid' => self::FIXED_UUID_CANONICAL,
        ], $service);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'identity_mismatch'], $body);
    }

    public function testControllerRejectsMissingBody(): void
    {
        $token = $this->mintToken([DocumentReferenceController::REQUIRED_SCOPE]);
        [$status, $body] = $this->dispatchController($token, null);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $body);
    }

    /**
     * @param array<string, mixed>|null $body
     * @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>}
     */
    private function dispatchController(
        ?string $token,
        ?array $body,
        ?DocumentReferenceWriteService $serviceOverride = null,
    ): array {
        $logger = new NullLogger();
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new DocumentReferenceStubResolver(
            new ResolvedAgentActor(7, 'patel', $this->actorUuid()),
            true,
        );

        $auth = new AgentEndpointAuth(
            new OpenEmrJwtVerifier(
                publicKeyPem: self::keypair()['public'],
                issuer: self::ISSUER,
                audience: AgentTokenMinter::AGENT_CLIENT_ID,
                clock: $this->fixedClock(),
            ),
            $resolver,
            $logger,
            'default',
        );

        $service = $serviceOverride ?? $this->makeService(new InMemoryDocumentTableWriter());

        $controller = new DocumentReferenceController(
            auth: $auth,
            writeService: $service,
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: $this->fixedClock(),
        );

        ob_start();
        try {
            $controller->handle($token, $body, null);
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status);

        $decoded = null;
        if ($output !== '') {
            $raw = json_decode((string) $output, true);
            $this->assertIsArray($raw);
            $stringKeyed = [];
            foreach ($raw as $key => $value) {
                $this->assertIsString($key);
                $stringKeyed[$key] = $value;
            }
            $decoded = $stringKeyed;
        }

        return [$status, $decoded, $requestLogSink->all()];
    }

    private function makeService(InMemoryDocumentTableWriter $writer): DocumentReferenceWriteService
    {
        return new DocumentReferenceWriteService(
            tableWriter: $writer,
            uuidGenerator: new FixedDocumentUuidGenerator(self::FIXED_UUID_CANONICAL),
            eventDispatcher: new EventDispatcher(),
            clock: $this->fixedClock(),
            logger: new NullLogger(),
        );
    }

    private function fixedClock(): ClockInterface
    {
        return new DocumentReferenceFixedClock(new DateTimeImmutable(self::FIXED_NOW));
    }

    private function fixedJti(): JtiGenerator
    {
        return new DocumentReferenceFixedJti(self::FIXED_JTI);
    }

    private function actorUuid(): string
    {
        return 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';
    }

    /** @param list<string> $scopes */
    private function mintToken(array $scopes): string
    {
        $minter = new AgentTokenMinter(
            new AgentSigningKey(self::keypair()['private'], self::keypair()['public'], null),
            $this->fixedClock(),
            $this->fixedJti(),
        );
        return $minter->mint(
            new ResolvedFhirUser(
                uuid: $this->actorUuid(),
                fhirUserUri: self::FHIR_BASE . '/Practitioner/' . $this->actorUuid(),
            ),
            $scopes,
            self::ISSUER,
        );
    }

    /** @return array{private: string, public: string} */
    private static function keypair(): array
    {
        if (self::$keypair === null) {
            self::fail('keypair not initialized');
        }
        return self::$keypair;
    }

    /** @return array{private: string, public: string} */
    private static function generateKeypair(): array
    {
        $r = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($r);
        $priv = '';
        openssl_pkey_export($r, $priv);
        $details = openssl_pkey_get_details($r);
        self::assertNotFalse($details);
        $pub = $details['key'];
        self::assertIsString($pub);
        self::assertIsString($priv);
        return ['private' => $priv, 'public' => $pub];
    }
}

final class InMemoryDocumentTableWriter implements DocumentTableWriter
{
    /** @var list<array{pid: int, url: string, mimeType: string, filename: string, hash: string, size: int, docType: string, categoryId: int, uuidBinary: string}> */
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
        $docType = array_search($categoryId, $this->categoryByDocType, strict: true);
        if (!is_string($docType)) {
            throw new \RuntimeException('unknown category id in test writer');
        }
        $rowId = $this->nextDocumentId++;
        $this->insertedRows[] = [
            'pid' => $pid,
            'url' => $url,
            'mimeType' => $mimeType,
            'filename' => $filename,
            'hash' => $hash,
            'size' => $size,
            'docType' => $docType,
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
                return [
                    'rowId' => $idx + 1,
                    'pid' => $row['pid'],
                    'docType' => $row['docType'],
                ];
            }
        }
        return null;
    }
}

final readonly class FixedDocumentUuidGenerator implements DocumentUuidGenerator
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

final class SequenceDocumentUuidGenerator implements DocumentUuidGenerator
{
    /** @param list<string> $remaining */
    public function __construct(private array $remaining)
    {
    }

    public function generate(): GeneratedDocumentUuid
    {
        $next = array_shift($this->remaining);
        if ($next === null) {
            throw new \RuntimeException('SequenceDocumentUuidGenerator exhausted');
        }
        return new GeneratedDocumentUuid(
            canonical: $next,
            binary: hex2bin(str_replace('-', '', $next)) ?: '',
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

final class RecordingEventDispatcher implements \Symfony\Component\EventDispatcher\EventDispatcherInterface
{
    /** @var list<object> */
    public array $dispatched = [];

    public function dispatch(object $event, ?string $eventName = null): object
    {
        $this->dispatched[] = $event;
        return $event;
    }

    public function addListener(string $eventName, callable $listener, int $priority = 0): void
    {
    }

    public function addSubscriber(\Symfony\Component\EventDispatcher\EventSubscriberInterface $subscriber): void
    {
    }

    public function removeListener(string $eventName, callable $listener): void
    {
    }

    public function removeSubscriber(\Symfony\Component\EventDispatcher\EventSubscriberInterface $subscriber): void
    {
    }

    /** @return array<int, array<int, callable>>|array<int, callable> */
    public function getListeners(?string $eventName = null): array
    {
        return [];
    }

    public function getListenerPriority(string $eventName, callable $listener): ?int
    {
        return null;
    }

    public function hasListeners(?string $eventName = null): bool
    {
        return false;
    }
}

final readonly class DocumentReferenceFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class DocumentReferenceFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class DocumentReferenceStubResolver implements \OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver
{
    public function __construct(
        private ?ResolvedAgentActor $actor,
        private bool $mayRead,
    ) {
    }

    public function resolve(string $userUuid): ?ResolvedAgentActor
    {
        return $this->actor;
    }

    public function mayReadPatients(ResolvedAgentActor $actor): bool
    {
        return $this->mayRead;
    }
}
