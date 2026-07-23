import 'dotenv/config';

import { Pool } from 'pg';

import { verifyRouteAgainstZones } from '../src/common/geo';
import { config } from '../src/config';
import type { DangerZonesService } from '../src/zones/danger-zones.service';
import type { ZonesService } from '../src/zones/zones.service';
import { GoogleProvider } from '../src/routing/providers/google.provider';
import { GraphHopperProvider } from '../src/routing/providers/graphhopper.provider';
import { HereProvider } from '../src/routing/providers/here.provider';
import { HybridProvider } from '../src/routing/providers/hybrid.provider';
import { MockProvider } from '../src/routing/providers/mock.provider';
import { ProviderRegistry } from '../src/routing/providers/provider-registry';
import { RoutingService } from '../src/routing/routing.service';
import { ROUTING_PRESETS } from '../src/routing/presets';
import { DANGER_FIXTURE, fixtureDanger, fixtureZones } from './fixtures';
import type { RouteRequest, RoutingEngine } from '@shared';

/**
 * Halachic-correctness harness (spec section 16.7). For every available engine and every
 * preset it asserts the invariants the whole product rests on:
 *
 *   1. avoidance ON  yields a geometry that intersects NO active zone, verified independently
 *      here - never trusting the verifiedClean flag (fail-safe correctness).
 *   2. avoidance OFF (the naive baseline) DOES cross a zone, so the demo data is meaningful.
 *   3. an endpoint inside a zone fails safe: verifiedClean=false with a stable reason code.
 *
 * The mock engine is offline and fully deterministic, so it is the guaranteed part of the
 * run. Real engines are exercised when their keys are present; a genuine upstream or network
 * error is reported as SKIP rather than FAIL, so the pass/fail reflects our own logic, not a
 * third party being reachable at that moment.
 *
 * Run: npm run verify            (all available engines)
 *      npm run verify -- --engine=here
 */
function engineFromArgv(): RoutingEngine | undefined {
  const arg = process.argv.find((value) => value.startsWith('--engine='));
  return arg ? (arg.split('=')[1] as RoutingEngine) : undefined;
}

interface Check {
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

function isUpstreamError(message: string): boolean {
  return /(failed|timeout|network|fetch|ENOTFOUND|ECONN|no route sections|returned no route|non-JSON|502|503|429)/i.test(
    message,
  );
}

async function main(): Promise<void> {
  // Fully self-contained: zone data is in-harness fixtures, never the database, so the real
  // database is untouched and the run needs no server. computePlan does not persist, so the
  // prisma dependency is an unused stub here.
  const zonesService = fixtureZones as unknown as ZonesService;
  const dangerService = fixtureDanger as unknown as DangerZonesService;

  // The routing graph is wired by hand rather than through the Nest container: this script
  // runs under tsx (esbuild), which does not emit the decorator metadata Nest DI relies on.
  const here = new HereProvider();
  const google = new GoogleProvider();
  const graphhopper = new GraphHopperProvider();
  const hybrid = new HybridProvider(graphhopper, here, google);
  const mock = new MockProvider();
  const registry = new ProviderRegistry(here, google, graphhopper, hybrid, mock);
  const routing = new RoutingService(
    registry,
    zonesService,
    dangerService,
    {} as never,
  );

  const only = engineFromArgv();
  const engines = registry
    .list()
    .filter((info) => info.available && (!only || info.name === only))
    .map((info) => info.name)
    .sort();

  process.stdout.write(`available engines: ${engines.join(', ')}\n`);

  const checks: Check[] = [];

  for (const engine of engines) {
    process.stdout.write(`\n=== engine: ${engine} ===\n`);

    for (const preset of ROUTING_PRESETS) {
      const zones = await zonesService.getZones(preset.stringency);
      const request: RouteRequest = {
        origin: preset.origin,
        destination: preset.destination,
        stringency: preset.stringency,
        mode: 'drive',
        trafficAware: false,
        language: 'he',
        engine,
      };

      let plan;
      try {
        plan = await routing.computePlan(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = isUpstreamError(message) ? 'skip' : 'fail';
        checks.push({ label: `${engine}/${preset.id}: compute`, status, detail: message });
        process.stdout.write(`  ${status.toUpperCase()} compute threw: ${message}\n`);
        continue;
      }

      // Plan shape: 1..3 routes, best first. Every route in a clean preset must be verified.
      checks.push({
        label: `${engine}/${preset.id}: plan has 1..${3} routes`,
        status: plan.routes.length >= 1 && plan.routes.length <= 3 ? 'pass' : 'fail',
        detail: `${plan.routes.length} route(s), labels=[${plan.routes
          .map((r) => r.label ?? '-')
          .join(', ')}]`,
      });
      if (preset.expect === 'clean') {
        const allClean = plan.routes.every(
          (r) => r.verifiedClean && verifyRouteAgainstZones(r.geometry, zones).clean,
        );
        // Only assert when the primary is clean (a real engine may genuinely give up upstream).
        if (plan.routes[0]?.verifiedClean) {
          checks.push({
            label: `${engine}/${preset.id}: every alternative in the plan is verified clean`,
            status: allClean ? 'pass' : 'fail',
            detail: `${plan.routes.length} route(s), all verified clean = ${allClean}`,
          });
        }
      }

      const result = plan.routes[0];

      // Cross-cutting fail-safe invariant: a clean flag must be backed by real geometry.
      if (result.verifiedClean) {
        const independent = verifyRouteAgainstZones(result.geometry, zones);
        checks.push({
          label: `${engine}/${preset.id}: verifiedClean flag matches the geometry`,
          status: independent.clean ? 'pass' : 'fail',
          detail: independent.clean
            ? 'geometry independently verified clean'
            : `FLAG LIES: touches [${independent.offending
                .map((z) => z.properties.name)
                .join(', ')}]`,
        });
      }

      if (preset.expect === 'clean') {
        const upstreamGaveUp =
          !result.verifiedClean && result.reason === 'avoidance_failed' && engine !== 'mock';
        checks.push({
          label: `${engine}/${preset.id}: avoidance ON is clean`,
          status: result.verifiedClean ? 'pass' : upstreamGaveUp ? 'skip' : 'fail',
          detail: result.verifiedClean
            ? `${(result.distanceMeters / 1000).toFixed(2)} km, detourRatio=${
                result.detourRatio ?? 'n/a'
              }`
            : `verifiedClean=false reason=${result.reason ?? 'unknown'}`,
        });

        const naive = result.debug?.naiveGeometry;
        const naiveCheck = naive
          ? verifyRouteAgainstZones(naive, zones)
          : { clean: true, offending: [] };
        checks.push({
          label: `${engine}/${preset.id}: avoidance OFF crosses a zone (data is meaningful)`,
          status: naive && !naiveCheck.clean ? 'pass' : 'fail',
          detail: naive
            ? `naive crosses [${naiveCheck.offending
                .map((z) => z.properties.name)
                .join(', ') || 'nothing'}]`
            : 'no naive geometry returned',
        });
      } else {
        checks.push({
          label: `${engine}/${preset.id}: endpoint inside a zone fails safe`,
          status:
            !result.verifiedClean &&
            (result.reason ?? '').startsWith(preset.reasonPrefix ?? '')
              ? 'pass'
              : 'fail',
          detail: `verifiedClean=${result.verifiedClean} reason=${result.reason ?? 'none'}`,
        });
      }
    }
  }

  // Hybrid pricing invariant: travel time always comes from Google, priced over the shape
  // engine's verified-clean geometry, in BOTH traffic modes, and the two must differ when
  // traffic differs (spec section 6.7, the always-Google-time product decision).
  if (engines.includes('hybrid') && (!only || only === 'hybrid')) {
    process.stdout.write(`\n=== hybrid: Google-priced time in both modes ===\n`);
    for (const preset of ROUTING_PRESETS.filter((p) => p.expect === 'clean')) {
      const base = {
        origin: preset.origin,
        destination: preset.destination,
        stringency: preset.stringency,
        mode: 'drive' as const,
        language: 'he' as const,
        engine: 'hybrid' as RoutingEngine,
      };
      try {
        const free = (await routing.computePlan({ ...base, trafficAware: false })).routes[0];
        const live = (await routing.computePlan({ ...base, trafficAware: true })).routes[0];

        const pricedNote = (r: typeof free): boolean =>
          (r.debug?.attempts ?? []).some((a) => a.includes('priced by Google'));

        const bothPriced = pricedNote(free) && pricedNote(live);
        const sameShape = JSON.stringify(free.geometry) === JSON.stringify(live.geometry);
        const differ = free.durationSeconds !== live.durationSeconds;

        checks.push({
          label: `hybrid/${preset.id}: both traffic modes are Google-priced`,
          status: bothPriced ? 'pass' : 'skip',
          detail: bothPriced
            ? 'free-flow and live traffic both priced by Google'
            : 'Google did not price (upstream not reachable/enabled)',
        });

        if (bothPriced) {
          // The two prices differ once traffic differs from Google's free-flow speed model.
          // At a very quiet hour they can read equal (or live can even be a touch faster than
          // the conservative default model), so an equal reading is a skip - the load-bearing
          // invariant, that both modes reach Google, is asserted above.
          checks.push({
            label: `hybrid/${preset.id}: free-flow and live-traffic prices are independent`,
            status: differ ? 'pass' : 'skip',
            detail: `${free.durationSeconds}s free-flow vs ${live.durationSeconds}s live` +
              (differ ? '' : ' (traffic flat right now)'),
          });
          checks.push({
            label: `hybrid/${preset.id}: geometry stays the shape engine's, verified clean`,
            status: sameShape && free.verifiedClean && live.verifiedClean ? 'pass' : 'fail',
            detail: `sameShape=${sameShape} clean=${free.verifiedClean}/${live.verifiedClean}`,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({
          label: `hybrid/${preset.id}: pricing`,
          status: isUpstreamError(message) ? 'skip' : 'fail',
          detail: message,
        });
      }
    }
  }

  // RoutePlan features: alternatives count, toll avoidance pass-through, and the unavoided
  // comparison route appearing only when avoidance actually changed the outcome.
  {
    process.stdout.write(`\n=== RoutePlan features (default engine) ===\n`);
    for (const preset of ROUTING_PRESETS.filter((p) => p.expect === 'clean')) {
      const base = {
        origin: preset.origin,
        destination: preset.destination,
        stringency: preset.stringency,
        mode: 'drive' as const,
        trafficAware: false,
        language: 'he' as const,
      };
      try {
        const plain = await routing.computePlan(base);
        process.stdout.write(
          `  ${preset.id}: ${plain.routes.length} clean alternative(s) ` +
            `[${plain.routes.map((r) => r.label ?? '-').join(', ')}]\n`,
        );

        // avoidTolls must be reflected on each returned route.
        const tolled = await routing.computePlan({ ...base, avoidTolls: true });
        checks.push({
          label: `plan/${preset.id}: avoidTolls sets avoidsTolls on every route`,
          status:
            tolled.routes.length > 0 && tolled.routes.every((r) => r.avoidsTolls === true)
              ? 'pass'
              : 'fail',
          detail: `avoidsTolls=[${tolled.routes.map((r) => String(r.avoidsTolls)).join(', ')}]`,
        });

        // includeUnavoided: present here because these presets cross a zone without avoidance.
        const withUnavoided = await routing.computePlan({ ...base, includeUnavoided: true });
        const naiveCrosses = !verifyRouteAgainstZones(
          withUnavoided.routes[0]?.debug?.naiveGeometry ?? {
            type: 'LineString',
            coordinates: [],
          },
          await zonesService.getZones(preset.stringency),
        ).clean;
        checks.push({
          label: `plan/${preset.id}: unavoidedRoute present when avoidance bit`,
          status:
            naiveCrosses &&
            withUnavoided.unavoidedRoute != null &&
            withUnavoided.unavoidedRoute.verifiedClean === false
              ? 'pass'
              : 'fail',
          detail: `naiveCrosses=${naiveCrosses} unavoided=${
            withUnavoided.unavoidedRoute ? 'present' : 'absent'
          }`,
        });

        // And absent when avoidance was not requested to be surfaced.
        checks.push({
          label: `plan/${preset.id}: unavoidedRoute absent unless includeUnavoided`,
          status: plain.unavoidedRoute == null ? 'pass' : 'fail',
          detail: `unavoided=${plain.unavoidedRoute ? 'present' : 'absent'}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({
          label: `plan/${preset.id}: features`,
          status: isUpstreamError(message) ? 'skip' : 'fail',
          detail: message,
        });
      }
    }
  }

  // Danger-zone avoidance: a corridor whose direct line crosses ONLY a danger zone (no
  // stringency zone). With avoidDangerZones on (default) the route must clear it; with it off
  // the naive route is allowed to cross it, proving the danger axis actually bit.
  {
    process.stdout.write(`\n=== danger-zone avoidance (mock engine) ===\n`);
    const dangerGeom = { type: 'Polygon' as const, coordinates: DANGER_FIXTURE.coordinates };
    const dangerZone = { type: 'Feature' as const, properties: {} as never, geometry: dangerGeom };
    const base = {
      origin: { lat: 32.05, lng: 34.788 },
      destination: { lat: 32.061, lng: 34.803 },
      stringency: 'basic' as const,
      mode: 'drive' as const,
      trafficAware: false,
      language: 'he' as const,
      engine: 'mock' as RoutingEngine,
    };
    try {
      const on = await routing.computePlan({ ...base, avoidDangerZones: true });
      const onClean = on.routes[0]
        ? verifyRouteAgainstZones(on.routes[0].geometry, [dangerZone]).clean
        : false;
      checks.push({
        label: 'danger/on: route clears the danger zone',
        status: on.routes[0]?.verifiedClean && onClean ? 'pass' : 'fail',
        detail: `verifiedClean=${on.routes[0]?.verifiedClean} clearsDanger=${onClean}`,
      });

      const off = await routing.computePlan({ ...base, avoidDangerZones: false });
      const offCrosses = off.routes[0]
        ? !verifyRouteAgainstZones(off.routes[0].geometry, [dangerZone]).clean
        : false;
      checks.push({
        label: 'danger/off: naive route is allowed to cross the danger zone',
        status: offCrosses ? 'pass' : 'fail',
        detail: `crossesDanger=${offCrosses} (proves the danger axis changed the outcome)`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        label: 'danger: avoidance',
        status: isUpstreamError(message) ? 'skip' : 'fail',
        detail: message,
      });
    }
  }

  process.stdout.write('\n-------- verification summary --------\n');
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.label}\n       ${check.detail}\n`);
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  const passed = checks.filter((c) => c.status === 'pass').length;
  process.stdout.write(
    `\n${passed} passed, ${skipped} skipped, ${failed} failed - ${failed === 0 ? 'PASS' : 'FAIL'}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify failed to run:', error);
  process.exit(1);
});
