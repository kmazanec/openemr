<?php

/**
 * Isolated tests for the §B.8 ExtractController.
 *
 * The controller's job is body-shape validation + delegating to the
 * AgentProxyController dispatcher. Tests inject a recording closure as
 * the dispatcher seam so we can assert the controller forwards exactly
 * what the proxy needs without exercising the proxy's session/scope
 * machinery (PolicyGate has its own test suite).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Controller;

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentRequest;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;
use OpenEMR\Modules\ClinicalCopilot\Controller\ExtractController;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ExtractControllerTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/Auth/ResolvedFhirUser.php';
        require_once self::MODULE_DIR . '/Auth/SessionContext.php';
        require_once self::MODULE_DIR . '/Auth/AgentRequest.php';
        require_once self::MODULE_DIR . '/Auth/PolicyDenyReason.php';
        require_once self::MODULE_DIR . '/Auth/PolicyDecision.php';
        require_once self::MODULE_DIR . '/Auth/PolicyGate.php';
        require_once self::MODULE_DIR . '/Controller/ExtractController.php';
    }

    /**
     * @return array{
     *     captured: array<int, array{session: SessionContext, request: AgentRequest, body: string}>,
     *     controller: ExtractController,
     * }
     */
    private function buildController(): array
    {
        $captured = [];
        $dispatcher = static function (SessionContext $session, AgentRequest $request, string $body) use (&$captured): void {
            $captured[] = ['session' => $session, 'request' => $request, 'body' => $body];
        };
        return [
            'captured' => &$captured,
            'controller' => new ExtractController($dispatcher),
        ];
    }

    private function fhirUser(): ResolvedFhirUser
    {
        return new ResolvedFhirUser(
            uuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            fhirUserUri: 'https://example.test/apis/default/fhir/Practitioner/a8f5f167-f44f-4964-ad62-30e69e7e90d6',
        );
    }

    public function testDispatchesValidatedBodyToProxy(): void
    {
        $built = $this->buildController();
        $body = json_encode([
            'pid' => 4242,
            'document_uuid' => 'placeholder-1',
            'doc_type' => 'lab_pdf',
            'trigger_source' => 'panel',
            'canonical_ext' => 'pdf',
            'conversation_id' => 'conv-1',
        ], JSON_THROW_ON_ERROR);

        $built['controller']->handle(
            rawBody: $body,
            authUserId: '42',
            authUser: 'admin',
            siteId: 'default',
            sessionPid: '4242',
            fhirUser: $this->fhirUser(),
        );

        $this->assertCount(1, $built['captured']);
        $captured = $built['captured'][0];

        $this->assertSame('extract', $captured['request']->action);
        $this->assertSame('4242', $captured['request']->requestedPatientPid);
        $this->assertSame('default', $captured['request']->siteId);

        // Scopes mirror the PolicyGate allowlist for `extract`.
        $this->assertContains('user/DocumentReference.cs', $captured['request']->requestedScopes);
        $this->assertContains('user/Patient.rs', $captured['request']->requestedScopes);

        // Forwarded body preserves all envelope fields and uses the
        // request's parsed pid value (an int, not a string).
        $forwarded = json_decode($captured['body'], associative: true);
        $this->assertIsArray($forwarded);
        $this->assertSame(4242, $forwarded['pid']);
        $this->assertSame('placeholder-1', $forwarded['document_uuid']);
        $this->assertSame('lab_pdf', $forwarded['doc_type']);
        $this->assertSame('panel', $forwarded['trigger_source']);
        $this->assertSame('pdf', $forwarded['canonical_ext']);
        $this->assertSame('conv-1', $forwarded['conversation_id']);
    }

    public function testDefaultsCanonicalExtToPdfWhenAbsent(): void
    {
        $built = $this->buildController();
        $body = json_encode([
            'pid' => 4242,
            'document_uuid' => 'placeholder-1',
            'doc_type' => 'intake_form',
            'trigger_source' => 'panel',
        ], JSON_THROW_ON_ERROR);
        $built['controller']->handle($body, '42', 'admin', 'default', '4242', $this->fhirUser());
        $forwarded = json_decode($built['captured'][0]['body'], associative: true);
        $this->assertIsArray($forwarded);
        $this->assertSame('pdf', $forwarded['canonical_ext']);
        $this->assertArrayNotHasKey('conversation_id', $forwarded);
    }

    /**
     * @return array<string, array{string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function invalidBodyProvider(): array
    {
        return [
            'not json' => ['{not json', 'invalid_body'],
            'missing pid' => [
                json_encode([
                    'document_uuid' => 'd',
                    'doc_type' => 'lab_pdf',
                    'trigger_source' => 'panel',
                ], JSON_THROW_ON_ERROR),
                'missing_pid',
            ],
            'pid zero' => [
                json_encode([
                    'pid' => 0,
                    'document_uuid' => 'd',
                    'doc_type' => 'lab_pdf',
                    'trigger_source' => 'panel',
                ], JSON_THROW_ON_ERROR),
                'missing_pid',
            ],
            'pid negative' => [
                json_encode([
                    'pid' => -1,
                    'document_uuid' => 'd',
                    'doc_type' => 'lab_pdf',
                    'trigger_source' => 'panel',
                ], JSON_THROW_ON_ERROR),
                'missing_pid',
            ],
            'missing document_uuid' => [
                json_encode([
                    'pid' => 1,
                    'doc_type' => 'lab_pdf',
                    'trigger_source' => 'panel',
                ], JSON_THROW_ON_ERROR),
                'invalid_document_uuid',
            ],
            'invalid doc_type' => [
                json_encode([
                    'pid' => 1,
                    'document_uuid' => 'd',
                    'doc_type' => 'xray',
                    'trigger_source' => 'panel',
                ], JSON_THROW_ON_ERROR),
                'invalid_doc_type',
            ],
            'invalid trigger_source' => [
                json_encode([
                    'pid' => 1,
                    'document_uuid' => 'd',
                    'doc_type' => 'lab_pdf',
                    'trigger_source' => 'browser',
                ], JSON_THROW_ON_ERROR),
                'invalid_trigger_source',
            ],
        ];
    }

    #[DataProvider('invalidBodyProvider')]
    public function testRejectsInvalidBody(string $body, string $expectedError): void
    {
        $built = $this->buildController();

        ob_start();
        $built['controller']->handle($body, '42', 'admin', 'default', '1', $this->fhirUser());
        $output = ob_get_clean();

        $this->assertCount(0, $built['captured']);
        $decoded = json_decode((string) $output, associative: true);
        $this->assertIsArray($decoded);
        $this->assertSame(['error' => $expectedError], $decoded);
    }

    public function testTrimsAndBoundsDocumentUuid(): void
    {
        $built = $this->buildController();
        $body = json_encode([
            'pid' => 1,
            'document_uuid' => '   ' . str_repeat('x', 250),  // exceeds 200 cap
            'doc_type' => 'lab_pdf',
            'trigger_source' => 'panel',
        ], JSON_THROW_ON_ERROR);
        ob_start();
        $built['controller']->handle($body, '42', 'admin', 'default', '1', $this->fhirUser());
        $output = ob_get_clean();
        $this->assertCount(0, $built['captured']);
        $decoded = json_decode((string) $output, associative: true);
        $this->assertIsArray($decoded);
        $this->assertSame(['error' => 'invalid_document_uuid'], $decoded);
    }

    public function testForwardsAutosweepTriggerSource(): void
    {
        $built = $this->buildController();
        $body = json_encode([
            'pid' => 1,
            'document_uuid' => 'd',
            'doc_type' => 'lab_pdf',
            'trigger_source' => 'autosweep',
        ], JSON_THROW_ON_ERROR);
        $built['controller']->handle($body, '42', 'admin', 'default', '1', $this->fhirUser());
        $forwarded = json_decode($built['captured'][0]['body'], associative: true);
        $this->assertIsArray($forwarded);
        $this->assertSame('autosweep', $forwarded['trigger_source']);
    }
}
