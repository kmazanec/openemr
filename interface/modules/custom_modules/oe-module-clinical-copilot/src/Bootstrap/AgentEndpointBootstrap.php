<?php

/**
 * Shared wiring helper for the narrow agent snapshot endpoints
 * (prescriptions.php, labs.php, encounters.php, patientContext.php).
 *
 * Centralizes the three pieces every endpoint needs:
 *   - JWT verifier built against the site's OAuth2 issuer
 *   - {@see EventDispatcher} with the disclosure listener attached
 *   - request parsing for bearer / pid / conversation / site
 *
 * The narrow controllers themselves take only the adapters they need,
 * so each endpoint's `.php` shim stays a few lines: parse → bootstrap
 * → construct controller → handle.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Bootstrap;

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DbalAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Symfony\Component\HttpFoundation\Request;

/**
 * Parsed request envelope for narrow snapshot endpoints.
 */
final readonly class ParsedAgentRequest
{
    public function __construct(
        public ?string $bearer,
        public ?int $pid,
        public ?string $conversationId,
        public string $siteId,
    ) {
    }
}

final class AgentEndpointBootstrap
{
    public static function parseRequest(Request $request): ParsedAgentRequest
    {
        $bearer = null;
        $authHeader = $request->headers->get('Authorization');
        if (is_string($authHeader) && str_starts_with($authHeader, 'Bearer ')) {
            $bearer = substr($authHeader, 7);
        }

        $pid = null;
        $pidParam = $request->query->get('pid');
        if (is_string($pidParam) && ctype_digit($pidParam)) {
            $pid = (int) $pidParam;
        }

        $conversationParam = $request->query->get('conversation');
        $conversationId = is_string($conversationParam) && $conversationParam !== ''
            ? $conversationParam
            : null;

        $siteIdRaw = $request->query->get('site');
        $siteId = is_string($siteIdRaw) && $siteIdRaw !== '' ? $siteIdRaw : 'default';

        return new ParsedAgentRequest($bearer, $pid, $conversationId, $siteId);
    }

    public static function buildVerifier(string $siteId): OpenEmrJwtVerifier
    {
        $globals = OEGlobalsBag::getInstance();
        $siteAddr = $globals->getString('site_addr_oath');
        $webroot = $globals->getWebRoot();
        // Issuer derivation matches AgentTokenMinter exactly: minter
        // stamps `site_addr_oath + webroot + /oauth2/{site}` so the
        // verifier composes the same string.
        $issuer = $siteAddr . $webroot . '/oauth2/' . $siteId;

        return new OpenEmrJwtVerifier(
            publicKeyPem: AgentSigningKey::fromOAuth2KeyConfig()->publicKeyPem,
            issuer: $issuer,
            audience: AgentTokenMinter::AGENT_CLIENT_ID,
        );
    }

    public static function buildDispatcher(LoggerInterface $logger): EventDispatcher
    {
        $connection = AgentDbalConnection::get();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener(
                new ExtendedLogDisclosureRecorder($connection),
                new DbalAgentRequestLogRecorder($connection),
                $logger,
            ),
        );
        return $dispatcher;
    }

    public static function logger(): LoggerInterface
    {
        return ServiceContainer::getLogger();
    }
}
