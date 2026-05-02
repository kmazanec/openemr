<?php

/**
 * Narrow agent endpoint: detail for a single clinical reminder.
 *
 * 1:1 with the agent's `getReminderDetail` tool. Backs §4.6.5's
 * reminder-detail drill-down — returns the rule description and
 * resolved category/item/due-status titles for a single reminder.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/reminder_detail.php
 *       ?pid=<pid>&site=<id>&reminderId=<int>&conversation=<id?>
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// Tell globals.php to skip its auth.inc.php redirect — bearer auth, not session.
$ignoreAuth = true; // phpcs:ignore SlevomatCodingStandard.Variables.UnusedVariable -- read by globals.php
require_once __DIR__ . '/../../../../../globals.php';

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\ReminderDetailController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ReminderDetailServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderDetailAdapter;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$reminderIdParam = $request->query->get('reminderId');
$reminderId = (is_string($reminderIdParam) && ctype_digit($reminderIdParam))
    ? (int) $reminderIdParam
    : null;

$controller = new ReminderDetailController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    adapter: new ReminderDetailAdapter(new ReminderDetailServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $reminderId, $parsed->conversationId);
